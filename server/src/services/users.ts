/**
 * User accounts: creation, profile, settings, lifecycle and role management.
 *
 * Anonymity model (pseudonymous by default):
 *  - Every account gets a generated handle and a deterministic identicon avatar.
 *    Neither is derived from any personal identifier.
 *  - displayName and bio are optional and may stay null forever.
 *  - Optional recovery identifiers (email/phone) are stored ONLY as a keyed hash
 *    for lookup plus AES-256-GCM ciphertext for recovery. They are never exposed
 *    to other users, never logged, and the owner sees only a short fingerprint.
 *  - IP addresses are stored hashed with the server pepper; raw IPs never touch
 *    the database.
 */
import type {
  AccountStatus,
  AvatarSpec,
  IdentityFingerprint,
  PrivateProfile,
  PublicProfile,
  Role,
  UserSettings,
  Visibility,
} from '../../../shared/types.js';
import { DEFAULT_SETTINGS, ROLE_RANK } from '../../../shared/types.js';
import { db, parseJson, toJson, nowMs } from '../db/index.js';
import { config } from '../config.js';
import {
  decryptSecret,
  encryptSecret,
  identityFingerprint,
  isValidEmail,
  isValidHandle,
  isValidPhone,
  keyedHash,
  normaliseEmail,
  normalisePhone,
  sha256Hex,
} from '../security/crypto.js';
import { avatarSpec, generateHandle, newId } from '../lib/ids.js';
import { audit } from './audit.js';

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const err = {
  notFound: (what = 'Resource') => new AppError('not_found', `${what} not found`, 404),
  forbidden: (msg = 'You do not have permission to do that') => new AppError('forbidden', msg, 403),
  conflict: (msg: string, code = 'conflict') => new AppError(code, msg, 409),
  badRequest: (msg: string, code = 'invalid_request') => new AppError(code, msg, 400),
  tooMany: (msg = 'Too many attempts. Try again later.') => new AppError('rate_limited', msg, 429),
  unauthorized: (msg = 'Authentication required') => new AppError('unauthorized', msg, 401),
  unavailable: (msg = 'Service temporarily unavailable') => new AppError('unavailable', msg, 503),
};

/** Require `actor` to hold at least `role`. Throws 403 otherwise. */
export function requireRole(actor: { role: Role } | null, role: Role): void {
  if (!actor) throw err.unauthorized();
  if (ROLE_RANK[actor.role] < ROLE_RANK[role]) {
    throw err.forbidden(`Requires the ${role} role`);
  }
}

interface UserRow {
  id: string;
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_seed: string;
  avatar_hue: number;
  avatar_attachment: string | null;
  password_hash: string | null;
  role: Role;
  status: AccountStatus;
  verified: number;
  two_factor_secret: string | null;
  two_factor_enabled: number;
  must_change_password: number;
  settings_json: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  deactivated_at: number | null;
  delete_after: number | null;
  suspension_until: number | null;
  trust_score: number;
}

const rowToAvatar = (r: UserRow): AvatarSpec => ({
  seed: r.avatar_seed,
  hue: r.avatar_hue,
  attachmentId: r.avatar_attachment,
});

function mergeSettings(partial: unknown): UserSettings {
  const base: UserSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!partial || typeof partial !== 'object') return base;
  const p = partial as Record<string, Record<string, unknown>>;
  for (const section of Object.keys(base) as (keyof UserSettings)[]) {
    const incoming = p[section];
    if (incoming && typeof incoming === 'object') {
      (base[section] as Record<string, unknown>) = {
        ...(base[section] as Record<string, unknown>),
        ...incoming,
      };
    }
  }
  return base;
}

export function getUserRow(id: string): UserRow | null {
  return (db().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
}

export function getUser(id: string): UserRow {
  const row = getUserRow(id);
  if (!row) throw err.notFound('User');
  return row;
}

export function findByHandle(handle: string): UserRow | null {
  const h = handle.replace(/^@/, '').trim().toLowerCase();
  return (db().prepare('SELECT * FROM users WHERE handle = ?').get(h) as UserRow | undefined) ?? null;
}

export function handleTaken(handle: string): boolean {
  const h = handle.replace(/^@/, '').trim().toLowerCase();
  return !!db().prepare('SELECT 1 FROM users WHERE handle = ?').get(h);
}

/** Look up an account by an optional recovery identifier (email or phone). */
export function findByIdentifier(method: 'email' | 'phone', value: string): UserRow | null {
  const normalised = method === 'email' ? normaliseEmail(value) : normalisePhone(value);
  const hash = keyedHash(`${method}:${normalised}`, 'identity');
  const row = db()
    .prepare('SELECT user_id FROM identities WHERE method = ? AND identifier_hash = ?')
    .get(method, hash) as { user_id: string } | undefined;
  return row ? getUserRow(row.user_id) : null;
}

export function findByOAuth(provider: string, subject: string): UserRow | null {
  const row = db()
    .prepare('SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?')
    .get(provider, subject) as { user_id: string } | undefined;
  return row ? getUserRow(row.user_id) : null;
}

export interface CreateUserInput {
  handle?: string | null;
  displayName?: string | null;
  passwordHash?: string | null;
  role?: Role;
  status?: AccountStatus;
  settings?: Partial<UserSettings>;
  email?: string | null;
  phone?: string | null;
  verified?: boolean;
  oauth?: { provider: string; subject: string; email?: string | null } | null;
  /** Device-generated public identity key (pure-anonymous accounts). */
  identityKey?: string | null;
}

export function createUser(input: CreateUserInput = {}): UserRow {
  const id = newId();
  const now = nowMs();
  const spec = avatarSpec(id);

  let handle = input.handle?.replace(/^@/, '').trim().toLowerCase() ?? null;
  if (handle) {
    if (!isValidHandle(handle)) {
      throw err.badRequest(
        'That handle is not allowed. Use 3-32 lowercase letters, numbers, underscores, or single hyphens/dots as separators.',
        'invalid_handle',
      );
    }
    if (handleTaken(handle)) throw err.conflict('That handle is already taken', 'handle_taken');
  } else {
    handle = generateHandle(handleTaken);
  }

  const settings = mergeSettings(input.settings);
  const role: Role = input.role ?? 'user';
  const status: AccountStatus = input.status ?? 'active';

  const insert = db().prepare(`
    INSERT INTO users (
      id, handle, display_name, bio, avatar_seed, avatar_hue, avatar_attachment,
      password_hash, role, status, verified, two_factor_secret, two_factor_enabled,
      settings_json, created_at, updated_at, last_seen_at, deactivated_at,
      delete_after, suspension_until, trust_score
    ) VALUES (
      @id, @handle, @display_name, @bio, @avatar_seed, @avatar_hue, NULL,
      @password_hash, @role, @status, @verified, NULL, 0,
      @settings_json, @created_at, @updated_at, NULL, NULL,
      NULL, NULL, 100
    )
  `);

  insert.run({
    id,
    handle,
    display_name: input.displayName?.trim() ? input.displayName.trim().slice(0, 64) : null,
    bio: null,
    avatar_seed: spec.seed,
    avatar_hue: spec.hue,
    password_hash: input.passwordHash ?? null,
    role,
    status,
    verified: input.verified ? 1 : 0,
    settings_json: toJson(settings),
    created_at: now,
    updated_at: now,
  });

  if (input.email) attachIdentity(id, 'email', input.email, !!input.verified);
  if (input.phone) attachIdentity(id, 'phone', input.phone, !!input.verified);

  if (input.oauth) {
    db().prepare(`
      INSERT INTO oauth_identities (provider, subject, user_id, email_hash, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, subject) DO UPDATE SET last_login_at = excluded.last_login_at
    `).run(
      input.oauth.provider,
      input.oauth.subject,
      id,
      input.oauth.email ? keyedHash(normaliseEmail(input.oauth.email), 'oauth-email') : null,
      now,
      now,
    );
  }

  // Every account gets a "Saved messages" conversation with itself. This is the
  // scratch space for note-to-self, and it is what a brand new user sees first so
  // the app is never an empty screen.
  createSelfConversation(id);

  audit({
    actorId: id,
    actorRole: role,
    action: 'user.created',
    target: { type: 'user', id },
    severity: 'info',
    meta: { handle, method: input.oauth?.provider ?? (input.passwordHash ? 'passkey' : 'device_key') },
  });

  return getUser(id);
}

/**
 * Store an optional recovery identifier.
 * Only the keyed hash (for lookup) and AES-256-GCM ciphertext (for recovery)
 * are persisted. The plaintext never reaches the database or the logs.
 */
export function attachIdentity(
  userId: string,
  method: 'email' | 'phone',
  rawValue: string,
  verified: boolean,
): IdentityFingerprint {
  const value = method === 'email' ? normaliseEmail(rawValue) : normalisePhone(rawValue);
  if (method === 'email' && !isValidEmail(value)) throw err.badRequest('That email address is not valid');
  if (method === 'phone' && !isValidPhone(value)) throw err.badRequest('That phone number is not valid');

  const hash = keyedHash(`${method}:${value}`, 'identity');
  const fingerprint = identityFingerprint(value, method);
  const now = nowMs();

  const existing = db()
    .prepare('SELECT id, user_id FROM identities WHERE method = ? AND identifier_hash = ?')
    .get(method, hash) as { id: string; user_id: string } | undefined;

  if (existing && existing.user_id !== userId) {
    throw err.conflict('That identifier is already linked to another account', 'identifier_taken');
  }

  if (existing) {
    db().prepare(
      'UPDATE identities SET verified = ?, encrypted_value = ?, fingerprint = ? WHERE id = ?',
    ).run(verified ? 1 : 0, encryptSecret(value, `identity:${existing.id}`), fingerprint, existing.id);
    return { method, fingerprint, addedAt: now, isPrimary: false };
  }

  const id = newId();
  const isPrimary =
    !db().prepare('SELECT 1 FROM identities WHERE user_id = ? AND is_primary = 1').get(userId);

  db().prepare(`
    INSERT INTO identities (id, user_id, method, identifier_hash, encrypted_value, fingerprint, verified, is_primary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, method, hash, encryptSecret(value, `identity:${id}`), fingerprint, verified ? 1 : 0, isPrimary ? 1 : 0, now);

  return { method, fingerprint, addedAt: now, isPrimary };
}

export function detachIdentity(userId: string, identityId: string): void {
  const row = db()
    .prepare('SELECT * FROM identities WHERE id = ? AND user_id = ?')
    .get(identityId, userId) as { id: string; method: string; is_primary: number } | undefined;
  if (!row) throw err.notFound('Identity');
  db().prepare('DELETE FROM identities WHERE id = ?').run(identityId);

  // Promote another identifier to primary so recovery always has a route.
  if (row.is_primary) {
    const next = db()
      .prepare('SELECT id FROM identities WHERE user_id = ? ORDER BY created_at LIMIT 1')
      .get(userId) as { id: string } | undefined;
    if (next) db().prepare('UPDATE identities SET is_primary = 1 WHERE id = ?').run(next.id);
  }
}

export function listIdentityFingerprints(userId: string): IdentityFingerprint[] {
  const rows = db()
    .prepare('SELECT method, fingerprint, created_at, is_primary FROM identities WHERE user_id = ? ORDER BY created_at')
    .all(userId) as { method: string; fingerprint: string; created_at: number; is_primary: number }[];
  return rows.map((r) => ({
    method: r.method as IdentityFingerprint['method'],
    fingerprint: r.fingerprint,
    addedAt: r.created_at,
    isPrimary: !!r.is_primary,
  }));
}

/** Only ever called by the account-recovery flow; returns plaintext or null. */
export function recoverIdentifier(userId: string, method: 'email' | 'phone'): string | null {
  const row = db()
    .prepare('SELECT id, encrypted_value FROM identities WHERE user_id = ? AND method = ? AND is_primary = 1')
    .get(userId, method) as { id: string; encrypted_value: string } | undefined;
  if (!row?.encrypted_value) return null;
  return decryptSecret(row.encrypted_value, `identity:${row.id}`);
}

/* ─────────────────────────── Profile projection ─────────────────────────── */

export function toPublicProfile(row: UserRow, viewerId?: string | null): PublicProfile {
  const presence = presenceOf(row.id, row.status);
  const profile: PublicProfile = {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    avatar: rowToAvatar(row),
    presence,
    createdAt: row.created_at,
  };

  if (!viewerId || viewerId === row.id) return profile;

  const contact = db()
    .prepare("SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ? AND status = 'accepted'")
    .get(viewerId, row.id);
  const blocked = db()
    .prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?')
    .get(viewerId, row.id);
  profile.isContact = !!contact;
  profile.isBlocked = !!blocked;

  // Honour "who can see my handle": when the viewer is not permitted, the handle
  // is replaced with a stable pseudonym so the UI still has something to show but
  // the account cannot be searched for or cross-referenced.
  const settings = getSettings(row.id);
  if (!canSee(settings.privacy.whoCanSeeMyHandle, !!contact)) {
    profile.handle = pseudonymFor(row.id);
  }
  if (!settings.privacy.showPresence && !contact) {
    profile.presence = 'offline';
  }
  return profile;
}

/** Stable, non-reversible display name used when the handle is hidden. */
function pseudonymFor(userId: string): string {
  return `anonymous-${sha256Hex(`${config.secrets.pepper}:pseudonym:${userId}`).slice(0, 8)}`;
}

function canSee(rule: Visibility | 'everyone' | 'contacts' | 'nobody', isContact: boolean): boolean {
  if (rule === 'everyone') return true;
  if (rule === 'contacts') return isContact;
  return false;
}

export function toPrivateProfile(row: UserRow): PrivateProfile {
  return {
    ...toPublicProfile(row, row.id),
    status: row.status,
    role: row.role,
    settings: getSettings(row.id),
    identityFingerprints: listIdentityFingerprints(row.id),
    verified: !!row.verified,
    lastSeenAt: row.last_seen_at,
    twoFactorEnabled: !!row.two_factor_enabled,
    mustChangePassword: !!row.must_change_password,
  };
}

export function getSettings(userId: string): UserSettings {
  const row = db().prepare('SELECT settings_json FROM users WHERE id = ?').get(userId) as
    | { settings_json: string }
    | undefined;
  return mergeSettings(row ? parseJson(row.settings_json, null) : null);
}

export function updateSettings(userId: string, patch: Record<string, unknown>): UserSettings {
  const current = getSettings(userId);
  const next = mergeSettings({ ...current, ...patch } as unknown as Partial<UserSettings>);
  // Deep-merge section by section so a partial patch cannot wipe a section.
  for (const section of Object.keys(patch) as (keyof UserSettings)[]) {
    if (patch[section] && typeof patch[section] === 'object') {
      (next[section] as Record<string, unknown>) = {
        ...(current[section] as Record<string, unknown>),
        ...(patch[section] as Record<string, unknown>),
      };
    }
  }
  db().prepare('UPDATE users SET settings_json = ?, updated_at = ? WHERE id = ?').run(
    toJson(next),
    nowMs(),
    userId,
  );
  return next;
}

export interface UpdateProfileInput {
  displayName?: string | null;
  bio?: string | null;
  handle?: string;
}

export function updateProfile(userId: string, patch: UpdateProfileInput): UserRow {
  const row = getUser(userId);
  const next: Partial<UserRow> = { updated_at: nowMs() };

  if (patch.displayName !== undefined) {
    const name = patch.displayName?.trim() ?? '';
    if (name.length > 64) throw err.badRequest('Display name must be 64 characters or fewer');
    // Strip control characters and bidi overrides — these are used for spoofing.
    next.display_name = name ? name.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') : null;
  }
  if (patch.bio !== undefined) {
    const bio = patch.bio?.trim() ?? '';
    if (bio.length > 280) throw err.badRequest('Bio must be 280 characters or fewer');
    next.bio = bio ? bio.replace(/[\u0000-\u001f\u007f]/g, '') : null;
  }
  if (patch.handle !== undefined) {
    const handle = patch.handle.replace(/^@/, '').trim().toLowerCase();
    if (!isValidHandle(handle)) throw err.badRequest('That handle is not allowed', 'invalid_handle');
    if (handle !== row.handle && handleTaken(handle)) {
      throw err.conflict('That handle is already taken', 'handle_taken');
    }
    next.handle = handle;
  }

  const sets = Object.keys(next);
  if (sets.length) {
    db().prepare(
      `UPDATE users SET ${sets.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`,
    ).run({ ...next, id: userId });
  }
  return getUser(userId);
}

/* ─────────────────────────── Presence ─────────────────────────── */

const presenceCache = new Map<string, { state: PublicProfile['presence']; at: number }>();

export function setPresence(userId: string, state: PublicProfile['presence']): void {
  presenceCache.set(userId, { state, at: nowMs() });
  db().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowMs(), userId);
}

export function presenceOf(userId: string, status: AccountStatus): PublicProfile['presence'] {
  if (status !== 'active') return 'offline';
  const cached = presenceCache.get(userId);
  if (!cached) {
    const row = db().prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId) as
      | { last_seen_at: number | null }
      | undefined;
    const at = row?.last_seen_at ?? 0;
    return nowMs() - at < 120_000 ? 'online' : 'offline';
  }
  if (nowMs() - cached.at > 120_000) {
    presenceCache.delete(userId);
    return 'offline';
  }
  return cached.state;
}

export function clearPresence(userId: string): void {
  presenceCache.delete(userId);
  db().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowMs(), userId);
}

export function touchLastSeen(userId: string): void {
  db().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowMs(), userId);
}

/* ─────────────────────────── Self conversation ─────────────────────────── */

function createSelfConversation(userId: string): void {
  const conversationId = newId();
  const now = nowMs();
  db().prepare(`
    INSERT INTO conversations (id, kind, title, avatar_seed, avatar_hue, created_by, created_at, member_count, state)
    VALUES (?, 'self', 'Saved messages', ?, ?, ?, ?, 1, 'active')
  `).run(conversationId, `self-${userId.slice(0, 8)}`, 210, userId, now);
  db().prepare(`
    INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at, notifications_on, pinned)
    VALUES (?, ?, 'owner', ?, ?, 0, 1)
  `).run(conversationId, userId, now, now);
}

/* ─────────────────────────── Lifecycle ─────────────────────────── */

/**
 * User-initiated deactivation. Immediately signs the account out everywhere and
 * schedules hard deletion after the grace period (App Store / Play Store both
 * require an in-app deletion path).
 */
export function requestDeletion(userId: string, actorId: string): { deleteAfter: number } {
  const now = nowMs();
  const deleteAfter = now + config.retention.deletionGraceDays * 86_400_000;
  db().prepare(
    'UPDATE users SET status = ?, deactivated_at = ?, delete_after = ?, updated_at = ? WHERE id = ?',
  ).run('deactivated', now, deleteAfter, now, userId);
  db().prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(now, 'account_deactivated', userId);
  db().prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(now, userId);
  audit({
    actorId,
    action: 'user.deletion_requested',
    target: { type: 'user', id: userId },
    severity: 'warning',
    meta: { deleteAfter, graceDays: config.retention.deletionGraceDays },
  });
  return { deleteAfter };
}

/** Cancel a pending deletion (user came back inside the grace window). */
export function cancelDeletion(userId: string, actorId: string): void {
  const row = getUser(userId);
  if (row.status !== 'deactivated') throw err.badRequest('This account is not pending deletion');
  db().prepare(
    'UPDATE users SET status = ?, deactivated_at = NULL, delete_after = NULL, updated_at = ? WHERE id = ?',
  ).run('active', nowMs(), userId);
  audit({ actorId, action: 'user.deletion_cancelled', target: { type: 'user', id: userId }, severity: 'notice' });
}

/**
 * Hard delete. Removes the row and cascades to conversations, messages and media.
 * Attachment blobs are swept separately by jobs/sweeper so a failed storage call
 * cannot leave the database in a half-deleted state.
 */
export function hardDelete(userId: string, actorId: string | null, reason: string): void {
  const storageKeys = (db()
    .prepare('SELECT storage_key FROM attachments WHERE owner_id = ?')
    .all(userId) as { storage_key: string }[])
    .map((r) => r.storage_key);

  db().prepare('DELETE FROM users WHERE id = ?').run(userId);
  audit({
    actorId,
    action: 'user.hard_deleted',
    target: { type: 'user', id: userId },
    severity: 'critical',
    reason,
    meta: { attachmentsPurged: storageKeys.length },
  });
}

export function setRole(actor: UserRow, targetId: string, role: Role, reason: string): void {
  if (role === 'owner') throw err.forbidden('The owner role cannot be granted');
  // Only someone strictly above the target's current rank may change it, and
  // nobody may promote to or above their own rank. This prevents privilege
  // escalation via a colluding lower-ranked account.
  const target = getUser(targetId);
  if (ROLE_RANK[actor.role] <= ROLE_RANK[target.role]) {
    throw err.forbidden('You cannot modify an account of equal or higher rank');
  }
  if (ROLE_RANK[role] >= ROLE_RANK[actor.role]) {
    throw err.forbidden('You cannot grant a rank equal to or above your own');
  }
  db().prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, nowMs(), targetId);
  audit({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'user.role_changed',
    target: { type: 'user', id: targetId },
    severity: 'warning',
    reason,
    meta: { from: target.role, to: role },
  });
}

export function setStatus(
  actor: UserRow | null,
  targetId: string,
  status: AccountStatus,
  reason: string,
  durationDays?: number,
): void {
  const target = getUser(targetId);
  if (actor && ROLE_RANK[actor.role] <= ROLE_RANK[target.role]) {
    throw err.forbidden('You cannot moderate an account of equal or higher rank');
  }
  if (target.role === 'owner') throw err.forbidden('The owner account cannot be moderated');

  const now = nowMs();
  const suspensionUntil =
    status === 'suspended' && durationDays ? now + durationDays * 86_400_000 : null;

  db().prepare(
    'UPDATE users SET status = ?, suspension_until = ?, updated_at = ? WHERE id = ?',
  ).run(status, suspensionUntil, now, targetId);

  if (status === 'suspended' || status === 'deleted') {
    db().prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(now, status, targetId);
    db().prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(now, targetId);
  }

  db().prepare(`
    INSERT INTO moderation_actions (id, actor_id, target_type, target_id, action, reason, expires_at, created_at)
    VALUES (?, ?, 'user', ?, ?, ?, ?, ?)
  `).run(newId(), actor?.id ?? null, targetId, status, reason, suspensionUntil, now);

  audit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: `user.status_${status}`,
    target: { type: 'user', id: targetId },
    severity: status === 'deleted' ? 'critical' : 'warning',
    reason,
    meta: { suspensionUntil },
  });
}

/* ─────────────────────────── Discovery & directory ─────────────────────────── */

export function searchUsers(query: string, viewerId: string, limit = 20): PublicProfile[] {
  const q = query.replace(/^@/, '').trim().toLowerCase();
  if (q.length < 2) return [];
  const viewer = getUser(viewerId);
  const rows = db()
    .prepare(
      `SELECT * FROM users
        WHERE (handle LIKE ? OR display_name LIKE ?)
          AND status = 'active'
          AND id != ?
        ORDER BY
          CASE WHEN handle = ? THEN 0 WHEN handle LIKE ? THEN 1 ELSE 2 END,
          handle
        LIMIT ?`,
    )
    .all(`%${q}%`, `%${q}%`, viewerId, q, `${q}%`, limit) as UserRow[];
  return rows.map((r) => toPublicProfile(r, viewerId)).filter((p) => !p.isBlocked);
}

export function listUsersForAdmin(opts: {
  cursor?: string;
  limit?: number;
  status?: AccountStatus;
  role?: Role;
  query?: string;
}): { items: UserRow[]; nextCursor: string | null } {
  const limit = Math.min(opts.limit ?? 50, 200);
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: limit + 1 };
  if (opts.status) { where.push('status = @status'); params.status = opts.status; }
  if (opts.role) { where.push('role = @role'); params.role = opts.role; }
  if (opts.query) {
    where.push('(handle LIKE @query OR id = @query)');
    params.query = `%${opts.query.replace(/^@/, '')}%`;
  }
  if (opts.cursor) { where.push('created_at < @cursor'); params.cursor = Number(opts.cursor); }

  const rows = db()
    .prepare(
      `SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC LIMIT @limit`,
    )
    .all(params) as UserRow[];

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? String(last.created_at) : null };
}

export function countUsers(): { total: number; active: number; today: number } {
  const total = (db().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  const active = (db()
    .prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'active'")
    .get() as { c: number }).c;
  const since = nowMs() - 86_400_000;
  const today = (db()
    .prepare('SELECT COUNT(*) AS c FROM users WHERE created_at > ?')
    .get(since) as { c: number }).c;
  return { total, active, today };
}
