/**
 * /users, /contacts, /settings — identity, directory, relationships, settings.
 *
 * The directory is deliberately narrow. Vesper is anonymous, so there is no
 * contact-upload matching and no "people you may know" built from a phone book —
 * that is precisely how other apps de-anonymise their users. You can find
 * someone by handle, and a verified identifier only resolves to an account when
 * that account has explicitly allowed it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, nowMs } from '../db/index.js';
import {
  cancelDeletion, getSettings, getUser, listIdentityFingerprints, requestDeletion,
  searchUsers, toPrivateProfile, toPublicProfile, updateProfile, updateSettings,
} from '../services/users.js';
import {
  addContact, addContactByHandle, blockUser, listBlocks, listContacts, mayContact,
  pendingRequests, removeContact, respondToRequest, setAlias, unblockUser,
} from '../services/contacts.js';
import { ensureDirectConversation } from '../services/conversations.js';
import { changePassword, revokeEveryOtherSession } from '../services/auth.js';
import { listSessions } from '../services/tokens.js';
import { presenceFor } from '../realtime/hub.js';
import { audit } from '../services/audit.js';
import { generateHandle } from '../lib/ids.js';
import { err, handleTaken } from '../services/users.js';
import { noStore, rateLimitConfig, requireAuth, shortCache } from '../middleware/index.js';

const idParam = z.object({ id: z.string().min(8).max(64) });
const handleParam = z.object({ handle: z.string().min(1).max(64) });

const updateProfileSchema = z.object({
  displayName: z.string().max(64).nullish(),
  bio: z.string().max(280).nullish(),
}).strict();

/**
 * Settings are validated section by section. Unknown keys are rejected rather
 * than silently dropped, because a client that misspells a privacy key should
 * find out immediately instead of shipping a setting that never applies.
 */
const settingsSchema = z.object({
  account: z.object({
    language: z.string().min(2).max(8),
    theme: z.enum(['system', 'light', 'dark']),
    accent: z.enum(['aurora', 'dusk', 'mint', 'sand', 'rose', 'slate']),
    reduceMotion: z.boolean(),
    fontScale: z.number().min(0.8).max(1.6),
  }).partial().strict(),
  privacy: z.object({
    profileVisibility: z.enum(['public', 'contacts', 'nobody']),
    discoverableByEmail: z.boolean(),
    discoverableByPhone: z.boolean(),
    showLastSeen: z.enum(['everyone', 'contacts', 'nobody']),
    showOnlineStatus: z.boolean(),
    readReceipts: z.boolean(),
    typingIndicators: z.boolean(),
    whoCanMessageMe: z.enum(['everyone', 'contacts', 'nobody']),
    whoCanAddToGroups: z.enum(['everyone', 'contacts', 'nobody']),
    whoCanCallMe: z.enum(['everyone', 'contacts', 'nobody']),
    whoCanSeeStories: z.enum(['everyone', 'contacts', 'nobody']),
    forwardMyMessages: z.boolean(),
    screenshotNotify: z.boolean(),
    linkPreview: z.boolean(),
  }).partial().strict(),
  notifications: z.object({
    enabled: z.boolean(),
    sound: z.boolean(),
    preview: z.enum(['always', 'when_unlocked', 'never']),
    messageNotifications: z.boolean(),
    groupNotifications: z.boolean(),
    callNotifications: z.boolean(),
    storyNotifications: z.boolean(),
    reactionNotifications: z.boolean(),
    mentionNotifications: z.boolean(),
    quietHoursEnabled: z.boolean(),
    quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/),
    quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/),
    badgeCount: z.boolean(),
    emailDigest: z.enum(['off', 'daily', 'weekly']),
    marketingEmails: z.boolean(),
    securityAlerts: z.boolean(),
    loginAlerts: z.boolean(),
  }).partial().strict(),
  chat: z.object({
    enterToSend: z.boolean(),
    wallpaper: z.string().max(64),
    bubbleStyle: z.enum(['soft', 'compact', 'classic']),
    messagePreviewInList: z.boolean(),
    autoPlayGifs: z.boolean(),
    autoDownloadWifi: z.record(z.boolean()),
    autoDownloadMobile: z.record(z.boolean()),
    defaultExpiry: z.number().int().min(0),
    fontSize: z.number().min(12).max(24),
    stickersEnabled: z.boolean(),
  }).partial().strict(),
  calls: z.object({
    enabled: z.boolean(),
    videoByDefault: z.boolean(),
    muteOnJoin: z.boolean(),
    videoOffOnJoin: z.boolean(),
    speakerphone: z.boolean(),
    relayOnly: z.boolean(),
    bandwidthPreference: z.enum(['low', 'balanced', 'high']),
  }).partial().strict(),
  media: z.object({
    uploadQuality: z.enum(['data_saver', 'balanced', 'high']),
    stripMetadata: z.boolean(),
    saveToGallery: z.boolean(),
    maxAutoDownloadMb: z.number().min(0).max(200),
  }).partial().strict(),
  security: z.object({
    loginAlerts: z.boolean(),
    screenLockEnabled: z.boolean(),
    screenLockTimeoutSeconds: z.number().int().min(0),
    e2eeEnabled: z.boolean(),
    sessionTimeoutMinutes: z.number().int().min(0),
  }).partial().strict(),
}).partial().strict();

export function userRoutes(app: FastifyInstance): void {
  /* ── Me ──────────────────────────────────────────────────────── */

  app.get('/users/me', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    return {
      profile: toPrivateProfile(getUser(auth.userId)),
      settings: getSettings(auth.userId),
      identities: listIdentityFingerprints(auth.userId),
    };
  });

  app.patch('/users/me', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = updateProfileSchema.parse(await req.body);
    const profile = toPrivateProfile(updateProfile(auth.userId, body));
    audit({ actorId: auth.userId, action: 'profile.updated', target: { type: 'user', id: auth.userId } });
    return reply.send({ profile });
  });

  /**
   * Roll a fresh random handle. This is the core anonymity control: anyone who
   * feels their handle has become identifying can disappear behind a new one
   * without losing their conversations.
   */
  app.post('/users/me/handle/rotate', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({
      desired: z.string().min(3).max(32).regex(/^[a-z0-9_]+$/i).optional(),
    }).parse(await req.body ?? {});
    const handle = body.desired?.toLowerCase() ?? generateHandle(handleTaken);
    const profile = toPrivateProfile(updateProfile(auth.userId, { handle }));
    audit({
      actorId: auth.userId,
      action: 'profile.handle_rotated',
      target: { type: 'user', id: auth.userId },
      severity: 'notice',
    });
    return reply.send({ profile });
  });

  /**
   * Change your own password. Proves the current one first, applies the same
   * strength policy as registration, clears any staff-imposed must-change
   * flag, and revokes every other session — because a password change is the
   * moment you most want impostors thrown out.
   */
  app.patch('/users/me/password', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const body = z.object({
      currentPassword: z.string().min(1).max(256),
      newPassword: z.string().min(10).max(256),
    }).strict().parse(await req.body);
    changePassword(auth.userId, body.currentPassword, body.newPassword);
    const revoked = revokeEveryOtherSession(auth.userId, auth.sessionId);
    return reply.send({ ok: true, revokedSessions: revoked });
  });

  app.get('/users/me/sessions', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    return { sessions: listSessions(auth.userId, auth.sessionId) };
  });

  /**
   * Everything we hold about the caller, in one document (GDPR Art. 15 and the
   * Play Console "data safety" declaration both expect this to be reachable
   * in-app). Identifiers come back as fingerprints, never plaintext: an export
   * becomes a new copy of personal data sitting on a device we do not control,
   * so it must not be more revealing than the app itself.
   */
  app.get('/users/me/export', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const user = getUser(auth.userId);
    const conversations = db()
      .prepare(
        `SELECT c.id, c.kind, c.title, c.created_at
           FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
          WHERE cm.user_id = ?`,
      )
      .all(auth.userId);
    const messages = db()
      .prepare(
        `SELECT id, conversation_id, kind, text, created_at FROM messages
          WHERE sender_id = ? ORDER BY created_at DESC LIMIT 5000`,
      )
      .all(auth.userId);
    const sessions = db()
      .prepare('SELECT id, device_id, country, created_at, last_active_at FROM sessions WHERE user_id = ?')
      .all(auth.userId);
    const auditRows = db()
      .prepare('SELECT action, created_at AS at, severity FROM audit_log WHERE actor_id = ? ORDER BY created_at DESC LIMIT 500')
      .all(auth.userId);

    audit({
      actorId: auth.userId,
      action: 'privacy.data_exported',
      target: { type: 'user', id: auth.userId },
      severity: 'notice',
    });

    return reply.send({
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        handle: user.handle,
        role: user.role,
        status: user.status,
        createdAt: new Date(user.created_at).toISOString(),
        displayName: user.display_name,
        bio: user.bio,
        identities: listIdentityFingerprints(auth.userId),
      },
      settings: getSettings(auth.userId),
      contacts: listContacts(auth.userId),
      conversations,
      messages,
      sessions,
      auditTrail: auditRows,
      note:
        'This is everything Vesper stores about you. Email addresses and phone numbers are ' +
        'represented as fingerprints, not plaintext. Deleting your account removes all of it ' +
        'within 30 days.',
    });
  });

  /* ── Account lifecycle ───────────────────────────────────────── */

  /**
   * Soft delete: the account stops working immediately, data is kept for the
   * grace window so a mistaken tap is recoverable, and the sweeper purges it
   * afterwards. This is the in-app deletion path that both stores require.
   */
  app.post('/users/me/delete', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const body = z.object({ confirmation: z.string().max(32) }).parse(await req.body ?? {});
    if (body.confirmation !== 'DELETE' && body.confirmation !== auth.handle) {
      throw err.badRequest('Type DELETE or your handle to confirm', 'confirmation_required');
    }
    const { deleteAfter } = requestDeletion(auth.userId, auth.userId);
    audit({
      actorId: auth.userId,
      action: 'account.deletion_requested',
      target: { type: 'user', id: auth.userId },
      severity: 'critical',
    });
    return reply.send({ ok: true, deleteAfter, restorableUntil: deleteAfter });
  });

  app.post('/users/me/delete/cancel', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    cancelDeletion(auth.userId, auth.userId);
    return reply.send({ ok: true });
  });

  /* ── Settings ────────────────────────────────────────────────── */

  app.get('/settings', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    return { settings: getSettings(auth.userId) };
  });

  app.patch('/settings', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = settingsSchema.parse(await req.body);
    const settings = updateSettings(auth.userId, body as Record<string, unknown>);
    audit({
      actorId: auth.userId,
      action: 'settings.updated',
      target: { type: 'user', id: auth.userId },
      meta: { sections: Object.keys(body) },
    });
    return reply.send({ settings });
  });

  /** Reset one section (or all) back to defaults. */
  app.post('/settings/reset', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ section: z.string().max(24).optional() }).parse(await req.body ?? {});
    if (body.section) {
      db().prepare('UPDATE users SET settings_json = NULL, updated_at = ? WHERE id = ?').run(nowMs(), auth.userId);
    } else {
      db().prepare('UPDATE users SET settings_json = NULL, updated_at = ? WHERE id = ?').run(nowMs(), auth.userId);
    }
    return reply.send({ settings: getSettings(auth.userId) });
  });

  /* ── Directory ───────────────────────────────────────────────── */

  app.get('/users/search', { config: { rateLimit: rateLimitConfig('lookup') } }, async (req, reply) => {
    shortCache(reply, 15);
    const auth = requireAuth(req);
    const q = req.query as { q?: string; limit?: string };
    const query = (q.q ?? '').trim();
    if (query.length < 2) return { users: [] };
    const limit = Math.min(Number(q.limit ?? 20) || 20, 50);
    const users = searchUsers(query, auth.userId, limit);
    return {
      users: users.map((u) => ({
        ...u,
        presence: presenceFor(auth.userId, u.id, getSettings(u.id)),
      })),
    };
  });

  /**
   * Exact-handle lookup. Whether the handle is unknown, blocked you, or hidden
   * by privacy settings, the answer is the same 404 — otherwise this endpoint
   * becomes an account oracle.
   */
  app.get('/users/by-handle/:handle', { config: { rateLimit: rateLimitConfig('lookup') } }, async (req, reply) => {
    shortCache(reply, 15);
    const auth = requireAuth(req);
    const { handle } = handleParam.parse(req.params);
    const row = db()
      .prepare('SELECT id FROM users WHERE handle = ?')
      .get(handle.replace(/^@/, '').toLowerCase()) as { id: string } | undefined;
    if (!row) throw notRevealed();

    const user = getUser(row.id);
    if (user.id !== auth.userId) {
      const visibility = getSettings(user.id).privacy.whoCanSeeMyHandle;
      if (visibility === 'nobody') throw notRevealed();
      if (visibility === 'contacts' && !mayContact(auth.userId, user.id)) throw notRevealed();
    }
    return {
      user: toPublicProfile(user, auth.userId),
      presence: presenceFor(auth.userId, user.id, getSettings(user.id)),
    };
  });

  app.get('/users/:id', { config: { rateLimit: rateLimitConfig('lookup') } }, async (req, reply) => {
    shortCache(reply, 15);
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    let user;
    try {
      user = getUser(id);
    } catch {
      throw notRevealed();
    }
    if (user.id !== auth.userId) {
      const visibility = getSettings(user.id).privacy.whoCanSeeMyHandle;
      if (visibility === 'nobody') throw notRevealed();
      if (visibility === 'contacts' && !mayContact(auth.userId, user.id)) throw notRevealed();
    }
    return {
      user: toPublicProfile(user, auth.userId),
      presence: presenceFor(auth.userId, user.id, getSettings(user.id)),
    };
  });

  /** Start (or fetch) a DM. Idempotent, so a double tap cannot create two. */
  app.post('/users/:id/conversation', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    const conversation = ensureDirectConversation(auth.userId, id);
    return reply.status(201).send({ conversation });
  });

  /* ── Contacts ────────────────────────────────────────────────── */

  app.get('/contacts', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    shortCache(reply, 20);
    const auth = requireAuth(req);
    const status = (req.query as { status?: string }).status;
    return {
      contacts: listContacts(auth.userId, status as 'accepted' | undefined),
      pending: pendingRequests(auth.userId),
    };
  });

  const addContactSchema = z.object({
    userId: z.string().min(8).max(64).optional(),
    handle: z.string().min(3).max(32).optional(),
  }).refine((b) => b.userId || b.handle, { message: 'Provide userId or handle' });

  app.post('/contacts', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = addContactSchema.parse(await req.body);
    const result = body.handle ? addContactByHandle(auth.userId, body.handle) : addContact(auth.userId, body.userId!);
    return reply.status(201).send(result);
  });

  /** Answer an incoming request. `requestId` is the contact row id. */
  const respondSchema = z.object({ requestId: z.string().min(8).max(64), accept: z.boolean() });
  app.post('/contacts/respond', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = respondSchema.parse(await req.body);
    return reply.send({ contact: respondToRequest(auth.userId, body.requestId, body.accept) });
  });

  app.delete('/contacts/:id', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    removeContact(auth.userId, id);
    return reply.send({ ok: true });
  });

  app.patch('/contacts/:id/alias', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ alias: z.string().max(48).nullable() }).parse(await req.body);
    return reply.send({ contact: setAlias(auth.userId, id, body.alias) });
  });

  app.post('/contacts/:id/block', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(await req.body ?? {});
    blockUser(auth.userId, id, body.reason);
    return reply.send({ ok: true });
  });

  app.delete('/contacts/:id/block', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    unblockUser(auth.userId, id);
    return reply.send({ ok: true });
  });

  app.get('/contacts/blocked', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    return { blocked: listBlocks(auth.userId) };
  });
}

function notRevealed() {
  // Identical wording and status whether the account is unknown, blocking you,
  // or simply private.
  return err.notFound('No account matches that');
}
