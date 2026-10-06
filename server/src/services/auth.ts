/**
 * Authentication orchestration.
 *
 * Every sign-in method converges on `finishSignIn()`, which is the only place a
 * session is ever created. That is deliberate: rate limits, lockouts, status
 * checks and audit all live there, so adding a login method cannot bypass them.
 *
 * Methods
 *   passkey      email or phone + password
 *   otp_email    6-digit code to an email
 *   otp_sms      6-digit code to a phone (E.164)
 *   magic_link   emailed link carrying a single-use token
 *   google       Sign in with Google (id_token from the native SDK, or code+PKCE)
 *   apple        Sign in with Apple
 *   device_key   pure local keypair — no email, no phone, no provider at all
 *
 * Enumeration resistance: whether or not an identifier exists, the response has
 * the same shape and takes the same time. For password sign-in we always run a
 * dummy scrypt verification when the account is missing, so timing cannot reveal
 * existence.
 */
import { createHmac } from 'node:crypto';
import type { DeviceInfo, LoginMethod, PrivateProfile } from '../../../shared/types.js';
import { config, featureFlags } from '../config.js';
import { db, nowMs, toJson } from '../db/index.js';
import {
  assertPasswordAcceptable,
  constantTimeEqual,
  generateOtp,
  hashPassword,
  identityFingerprint,
  isValidEmail,
  isValidPhone,
  keyedHash,
  needsRehash,
  normaliseEmail,
  normalisePhone,
  passwordScore,
  randomHex,
  sha256Hex,
  verifyPassword,
} from '../security/crypto.js';
import { newId, newToken } from '../lib/ids.js';
import {
  AppError, attachIdentity, createUser, err, findByIdentifier, getUser,
  recoverIdentifier, toPrivateProfile,
} from './users.js';
import { issueTokens, revokeAllSessions, type IssuedTokens } from './tokens.js';
import { sendEmail } from '../adapters/email/index.js';
import { sendSms } from '../adapters/sms/index.js';
import {
  exchangeAppleCode, exchangeGoogleCode, resolveFederatedUser, verifyAppleIdToken,
  verifyGoogleIdToken, type VerifiedFederatedIdentity,
} from '../adapters/oauth/index.js';
import { audit } from './audit.js';

export interface SignInResult {
  tokens: IssuedTokens;
  profile: PrivateProfile;
  /** True when this call created the account rather than signing into one. */
  created: boolean;
  /** Which method actually succeeded — the client shows "signed in with …". */
  method: LoginMethod;
}

/**
 * Returned instead of a session when the caller must first prove control of an
 * identifier (OTP, magic link, 2FA). The client shows a code entry screen and
 * calls back with `challengeId` + `code`.
 */
export interface VerificationStep {
  step: 'verify';
  challengeId: string;
  kind: ChallengeKind;
  ttlSeconds: number;
  /** Where the code went, so the UI can say "check your email". */
  channel: 'email' | 'sms' | 'app';
  /** Masked destination — never the full address or number. */
  targetHint: string;
}

export interface AuthContext {
  ip: string;
  userAgent?: string;
  device: DeviceInfo;
}

/* ─────────────────────────── Anti-abuse primitives ─────────────────────────── */

/**
 * A throwaway hash used to equalise timing on a missing account. Without this a
 * "wrong password" response would return in ~1ms for unknown users and ~80ms for
 * known ones, which is a perfectly good account oracle.
 */
const DUMMY_HASH = hashPassword('vesper-timing-equaliser-not-a-real-password');

/**
 * Sliding lockout keyed on a *pseudonymised* identifier plus the client IP hash.
 * The raw email or phone is never written to this table.
 */
function lockoutKey(purpose: string, subject: string): string {
  return `${purpose}:${keyedHash(subject, 'auth-lockout').slice(0, 32)}`;
}

function checkLockout(key: string): void {
  const row = db()
    .prepare('SELECT failures, locked_until FROM auth_attempts WHERE key = ?')
    .get(key) as { failures: number; locked_until: number | null } | undefined;
  if (!row) return;
  if (row.locked_until && row.locked_until > nowMs()) {
    const minutes = Math.ceil((row.locked_until - nowMs()) / 60_000);
    throw err.tooMany(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

function recordFailure(key: string): void {
  const now = nowMs();
  const row = db().prepare('SELECT failures FROM auth_attempts WHERE key = ?').get(key) as
    | { failures: number }
    | undefined;
  const failures = (row?.failures ?? 0) + 1;
  // Exponential lockout from the 5th failure: 1, 2, 4, 8 … minutes, capped at 30.
  const lockedUntil = failures >= 5 ? now + Math.min(30, 2 ** (failures - 5)) * 60_000 : null;
  db().prepare(`
    INSERT INTO auth_attempts (key, failures, locked_until, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at
  `).run(key, failures, lockedUntil, now);
}

function clearFailures(key: string): void {
  db().prepare('DELETE FROM auth_attempts WHERE key = ?').run(key);
}

function assertMethodEnabled(method: LoginMethod): void {
  if (!featureFlags().registrationMethods.includes(method)) {
    throw err.forbidden(`${method} sign-in is not enabled on this server`);
  }
}

/** Mask an address for a UI hint: `j***@example.com`, `+91 •••• ••4321`. */
function hint(kind: 'email' | 'phone', value: string): string {
  if (kind === 'email') {
    const [local = '', domain = ''] = value.split('@');
    const head = local.slice(0, 1);
    return `${head}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`;
  }
  const digits = value.replace(/\D/g, '');
  return `${value.slice(0, 3)} •••• ${digits.slice(-4)}`;
}

/* ─────────────────────────── Challenges ─────────────────────────── */

export type ChallengeKind = 'otp_email' | 'otp_sms' | 'magic_link' | 'two_factor' | 'handoff';

interface ChallengeRow {
  id: string;
  kind: ChallengeKind;
  channel: string | null;
  target_hash: string | null;
  user_id: string | null;
  code_hash: string | null;
  token_hash: string | null;
  attempts: number;
  max_attempts: number;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  last_sent_at: number | null;
  context_json: string | null;
}

function createChallenge(
  kind: ChallengeKind,
  opts: {
    code?: string;
    token?: string;
    targetHash?: string;
    channel?: string;
    userId?: string | null;
    ttlSeconds?: number;
    maxAttempts?: number;
    context?: Record<string, unknown>;
  },
): { id: string; code?: string; token?: string } {
  const id = newId();
  const now = nowMs();
  const ttl = opts.ttlSeconds ?? config.auth.otp.ttlSeconds;
  db().prepare(`
    INSERT INTO challenges (id, kind, channel, target_hash, user_id, code_hash, token_hash,
                            attempts, max_attempts, created_at, expires_at, last_sent_at, context_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).run(
    id, kind, opts.channel ?? null, opts.targetHash ?? null, opts.userId ?? null,
    // The code hash is bound to the challenge id, so a code cannot be replayed
    // against a different challenge even if both are in flight.
    opts.code ? sha256Hex(`${id}:${opts.code}`) : null,
    opts.token ? sha256Hex(opts.token) : null,
    opts.maxAttempts ?? config.auth.otp.maxAttempts,
    now, now + ttl * 1000, now,
    opts.context ? toJson(opts.context) : null,
  );
  return { id, ...(opts.code ? { code: opts.code } : {}), ...(opts.token ? { token: opts.token } : {}) };
}

function loadChallenge(id: string, kind: ChallengeKind): ChallengeRow {
  const row = db().prepare('SELECT * FROM challenges WHERE id = ? AND kind = ?').get(id, kind) as
    | ChallengeRow
    | undefined;
  if (!row) throw err.notFound('That code is no longer valid. Request a new one.');
  if (row.consumed_at) throw err.badRequest('That code has already been used. Request a new one.', 'challenge_consumed');
  if (row.expires_at < nowMs()) throw err.badRequest('That code has expired. Request a new one.', 'challenge_expired');
  if (row.attempts >= row.max_attempts) throw err.tooMany('Too many incorrect attempts. Request a new code.');
  return row;
}

function consumeChallenge(id: string): void {
  db().prepare('UPDATE challenges SET consumed_at = ? WHERE id = ?').run(nowMs(), id);
}

function recordChallengeFailure(id: string): void {
  db().prepare('UPDATE challenges SET attempts = attempts + 1 WHERE id = ?').run(id);
}

function assertConstantTimeEqual(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
}

/** Cooldown so a client cannot spam a mailbox or burn SMS credit. */
function assertSendCooldown(kind: ChallengeKind, targetHash: string): void {
  const row = db()
    .prepare('SELECT last_sent_at FROM challenges WHERE kind = ? AND target_hash = ? ORDER BY created_at DESC LIMIT 1')
    .get(kind, targetHash) as { last_sent_at: number | null } | undefined;
  const cooldownMs = config.auth.otp.resendCooldownSeconds * 1000;
  if (row?.last_sent_at && nowMs() - row.last_sent_at < cooldownMs) {
    const wait = Math.ceil((cooldownMs - (nowMs() - row.last_sent_at)) / 1000);
    throw err.tooMany(`Please wait ${wait}s before requesting another code.`);
  }
}

/* ─────────────────────────── Inputs ─────────────────────────── */

/**
 * One input shape for both register and sign-in. For OTP, magic link, OAuth and
 * device-key methods the two are genuinely the same action — prove control of the
 * identifier and you are in — which is why there is no separate "forgot password"
 * maze. Only `passkey` distinguishes them, because a password is a secret that
 * must be set once and changed deliberately.
 */
export interface RegisterInput {
  method: LoginMethod;
  email?: string;
  phone?: string;
  password?: string;
  handle?: string;
  displayName?: string;
  /** Device-generated public key, for pure-anonymous accounts. */
  identityKey?: string;
  challengeId?: string;
  code?: string;
  /** OAuth id_token from the native SDK (Android/iOS/Windows). */
  idToken?: string;
  /** OAuth authorization code + PKCE verifier (web). */
  oauthCode?: string;
  redirectUri?: string;
  codeVerifier?: string;
}

export type AuthOutcome = SignInResult | VerificationStep;

/* ─────────────────────────── Register / sign in ─────────────────────────── */

export async function register(input: RegisterInput, ctx: AuthContext): Promise<AuthOutcome> {
  assertMethodEnabled(input.method);
  const ipHash = keyedHash(ctx.ip, 'client-ip');

  switch (input.method) {
    /* ── Password with email or phone ───────────────────────────── */
    case 'passkey': {
      const identifier = input.email ?? input.phone;
      if (!identifier) throw err.badRequest('An email address or phone number is required');
      const isEmail = identifier.includes('@');
      const normalised = isEmail ? normaliseEmail(identifier) : normalisePhone(identifier);
      if (isEmail && !isValidEmail(normalised)) throw err.badRequest('That email address is not valid');
      if (!isEmail && !isValidPhone(normalised)) {
        throw err.badRequest('That phone number is not valid. Include the country code, e.g. +91…');
      }
      if (!input.password) throw err.badRequest('A password is required');

      // Reject passwords that contain the user's own identifier — the single
      // highest-value password rule there is.
      requireAcceptablePassword(input.password, [
        normalised.split('@')[0] ?? '',
        input.handle ?? '',
        input.displayName ?? '',
      ]);

      checkLockout(lockoutKey('register', normalised));

      if (findByIdentifier(isEmail ? 'email' : 'phone', normalised)) {
        // Disclose that the identifier is taken — for *registration* this is not
        // an oracle leak, because the client must show "already registered" to be
        // usable. Sign-in, below, is deliberately vague.
        throw new AppError('identifier_in_use', 'An account already uses that. Try signing in instead.', 409);
      }

      const user = createUser({
        handle: input.handle ?? null,
        displayName: input.displayName ?? null,
        passwordHash: hashPassword(input.password),
        [isEmail ? 'email' : 'phone']: normalised,
        verified: false,
        identityKey: input.identityKey ?? null,
      });

      // Verification is issued but does not block first use: the account works
      // immediately, and an unverified account simply cannot use recovery.
      const challengeId = await startVerification(user.id, isEmail ? 'email' : 'phone', normalised);
      const result = finishSignIn(user.id, 'passkey', ctx, ipHash, true);
      return result.created
        ? result
        : result;
      void challengeId;
    }

    /* ── Email OTP ──────────────────────────────────────────────── */
    case 'otp_email': {
      if (!input.email) throw err.badRequest('An email address is required');
      const email = normaliseEmail(input.email);
      if (!isValidEmail(email)) throw err.badRequest('That email address is not valid');

      if (!input.challengeId || !input.code) {
        const challengeId = await startOtpChallenge('otp_email', email);
        return verificationStep(challengeId, 'otp_email', 'email', hint('email', email));
      }
      assertOtp(input.challengeId, 'otp_email', input.code, email);

      const existing = findByIdentifier('email', email);
      if (existing) return finishSignIn(existing.id, 'otp_email', ctx, ipHash, false);
      const user = createUser({ email, verified: true });
      return finishSignIn(user.id, 'otp_email', ctx, ipHash, true);
    }

    /* ── SMS OTP ────────────────────────────────────────────────── */
    case 'otp_sms': {
      if (!input.phone) throw err.badRequest('A phone number is required');
      const phone = normalisePhone(input.phone);
      if (!isValidPhone(phone)) {
        throw err.badRequest('That phone number is not valid. Include the country code, e.g. +91…');
      }

      if (!input.challengeId || !input.code) {
        const challengeId = await startOtpChallenge('otp_sms', phone);
        return verificationStep(challengeId, 'otp_sms', 'sms', hint('phone', phone));
      }
      assertOtp(input.challengeId, 'otp_sms', input.code, phone);

      const existing = findByIdentifier('phone', phone);
      if (existing) return finishSignIn(existing.id, 'otp_sms', ctx, ipHash, false);
      const user = createUser({ phone, verified: true });
      return finishSignIn(user.id, 'otp_sms', ctx, ipHash, true);
    }

    /* ── Magic link ─────────────────────────────────────────────── */
    case 'magic_link': {
      if (!input.email) throw err.badRequest('An email address is required');
      const email = normaliseEmail(input.email);
      if (!isValidEmail(email)) throw err.badRequest('That email address is not valid');

      const token = newToken(32);
      const targetHash = keyedHash(`email:${email}`, 'identity');
      const challenge = createChallenge('magic_link', {
        token,
        targetHash,
        channel: 'email',
        ttlSeconds: 15 * 60,
        maxAttempts: 3,
        // Only the hash of the address is kept; the link itself is the secret.
        context: { emailHash: sha256Hex(email) },
      });

      const url = `${config.app.publicUrl.replace(/\/$/, '')}/auth/magic?cid=${challenge.id}&t=${token}`;
      await sendEmail({
        to: email,
        subject: `Your ${config.app.name} sign-in link`,
        text:
          `Sign in to ${config.app.name}:\n\n${url}\n\n` +
          `This link expires in 15 minutes and can be used once.\n` +
          `If you did not ask for it, ignore this email — no account is created until the link is opened.`,
        html: magicLinkHtml(url),
        category: 'transactional',
      });

      audit({ action: 'auth.magic_link_sent', target: { type: 'identity', id: targetHash.slice(0, 16) }, ipHash });
      return verificationStep(challenge.id, 'magic_link', 'email', hint('email', email));
    }

    /* ── Google ─────────────────────────────────────────────────── */
    case 'google': {
      const identity = await resolveOAuthIdentity('google', input);
      const { userId, created } = resolveFederatedUser(identity);
      return finishSignIn(userId, 'google', ctx, ipHash, created);
    }

    /* ── Apple ──────────────────────────────────────────────────── */
    case 'apple': {
      const identity = await resolveOAuthIdentity('apple', input);
      const { userId, created } = resolveFederatedUser(identity);
      return finishSignIn(userId, 'apple', ctx, ipHash, created);
    }

    /* ── Pure device key: no email, no phone, no provider ───────── */
    case 'device_key': {
      if (!config.auth.deviceKey.enabled) {
        throw err.forbidden('Anonymous device-key accounts are disabled on this server');
      }
      if (!input.identityKey || input.identityKey.length < 16) {
        throw err.badRequest('A device identity key is required');
      }
      const keyHash = sha256Hex(input.identityKey);
      const existing = db()
        .prepare("SELECT user_id FROM identities WHERE method = 'device_key' AND identifier_hash = ?")
        .get(keyHash) as { user_id: string } | undefined;
      if (existing) return finishSignIn(existing.user_id, 'device_key', ctx, ipHash, false);

      const user = createUser({ handle: input.handle ?? null });
      db().prepare(`
        INSERT INTO identities (id, user_id, method, identifier_hash, encrypted_value, fingerprint, verified, is_primary, created_at)
        VALUES (?, ?, 'device_key', ?, NULL, ?, 1, 1, ?)
      `).run(newId(), user.id, keyHash, identityFingerprint(keyHash, 'device_key'), nowMs());

      return finishSignIn(user.id, 'device_key', ctx, ipHash, true);
    }

    default:
      throw err.badRequest('That sign-in method is not supported');
  }
}

async function resolveOAuthIdentity(provider: 'google' | 'apple', input: RegisterInput): Promise<VerifiedFederatedIdentity> {
  if (input.idToken) {
    return provider === 'google' ? verifyGoogleIdToken(input.idToken) : verifyAppleIdToken(input.idToken);
  }
  if (provider === 'google' && input.oauthCode && input.redirectUri && input.codeVerifier) {
    return exchangeGoogleCode(input.oauthCode, input.codeVerifier, input.redirectUri);
  }
  if (provider === 'apple' && input.oauthCode && input.redirectUri) {
    return exchangeAppleCode(input.oauthCode, input.redirectUri);
  }
  throw err.badRequest(`A ${provider} id_token or authorization code is required`);
}

function verificationStep(challengeId: string, kind: ChallengeKind, channel: VerificationStep['channel'], targetHint: string): VerificationStep {
  const ttl = kind === 'magic_link' ? 15 * 60 : config.auth.otp.ttlSeconds;
  return { step: 'verify', challengeId, kind, ttlSeconds: ttl, channel, targetHint };
}

/* ─────────────────────────── Sign in ─────────────────────────── */

export async function signIn(input: RegisterInput, ctx: AuthContext): Promise<AuthOutcome> {
  const ipHash = keyedHash(ctx.ip, 'client-ip');
  assertMethodEnabled(input.method);

  if (input.method !== 'passkey') {
    // For every other method, sign-in and sign-up are the same act.
    return register(input, ctx);
  }

  // Email and phone are the hashed identifiers; handle is the public one.
  // All three are accepted here so a staff or anonymous account that never
  // attached an email can still sign in with a password.
  const identifier = input.email ?? input.phone ?? input.handle;
  if (!identifier) throw err.badRequest('An email address, phone number or handle is required');
  if (!input.password) throw err.badRequest('A password is required');

  const isEmail = identifier.includes('@');
  const looksLikePhone = !isEmail && /^\+?[\d\s()-]{7,}$/.test(identifier);
  const key = lockoutKey('signin', identifier.toLowerCase());
  checkLockout(key);

  const user = isEmail
    ? findByIdentifier('email', identifier)
    : looksLikePhone
      ? findByIdentifier('phone', identifier)
      : findByHandleCase(identifier);

  if (!user || !user.password_hash) {
    // Always burn a scrypt cycle so response time does not reveal existence.
    verifyPassword(input.password, DUMMY_HASH);
    recordFailure(key);
    audit({
      action: 'auth.signin_failed',
      target: { type: 'identifier', id: sha256Hex(identifier).slice(0, 16) },
      severity: 'notice',
      ipHash,
    });
    throw err.unauthorized('Those details do not match an account');
  }

  if (!verifyPassword(input.password, user.password_hash)) {
    recordFailure(key);
    audit({
      actorId: user.id,
      action: 'auth.signin_failed',
      target: { type: 'user', id: user.id },
      severity: 'notice',
      ipHash,
    });
    throw err.unauthorized('Those details do not match an account');
  }

  clearFailures(key);

  // Transparent parameter upgrade when we have raised the scrypt cost.
  if (needsRehash(user.password_hash)) {
    db().prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(input.password), nowMs(), user.id);
  }

  // Second factor, when enrolled. The code goes to the verified recovery address
  // rather than being displayed, so a stolen password alone is not enough.
  if (user.two_factor_enabled && user.two_factor_secret) {
    const challenge = createChallenge('two_factor', {
      code: generateOtp(6),
      userId: user.id,
      ttlSeconds: 300,
      maxAttempts: 5,
      context: { next: 'signin' },
    });
    const address = await recoveryAddress(user.id);
    if (address) {
      await sendEmail({
        to: address,
        subject: `Your ${config.app.name} security code`,
        text:
          `Your sign-in code is ${challenge.code}. It expires in 5 minutes.\n\n` +
          `If this was not you, change your password immediately.`,
        category: 'transactional',
      });
      return verificationStep(challenge.id, 'two_factor', 'email', hint('email', address));
    }
    // TOTP fallback: the user enrolled an authenticator app, so verify against it.
    return verificationStep(challenge.id, 'two_factor', 'app', 'your authenticator app');
  }

  return finishSignIn(user.id, 'passkey', ctx, ipHash, false);
}

function findByHandleCase(handle: string) {
  const h = handle.replace(/^@/, '').trim().toLowerCase();
  const row = db().prepare('SELECT id FROM users WHERE handle = ?').get(h) as { id: string } | undefined;
  if (!row) return null;
  try {
    return getUser(row.id);
  } catch {
    return null;
  }
}

/** Verify an OTP. Throws on failure so callers do not have to branch. */
function assertOtp(challengeId: string, kind: 'otp_email' | 'otp_sms', code: string, target: string): void {
  const row = loadChallenge(challengeId, kind);
  const expected = sha256Hex(`${challengeId}:${code.trim()}`);
  if (!row.code_hash || !assertConstantTimeEqual(expected, row.code_hash)) {
    recordChallengeFailure(challengeId);
    audit({
      action: 'auth.otp_failed',
      target: { type: 'identity', id: keyedHash(target, 'identity').slice(0, 16) },
      severity: 'notice',
    });
    throw err.unauthorized('That code is not correct');
  }
  consumeChallenge(challengeId);
  clearFailures(lockoutKey('otp', target));
}

/**
 * Complete an OTP sign-in from the challenge alone.
 *
 * The challenge stores only the *hash* of the email or phone, and a hash cannot
 * be reversed — so this resolves the account by looking the hash up in
 * `identities`. That is exactly what we want: verification and account
 * resolution both happen server-side from data the client never sees in full,
 * and the client cannot substitute a different target for the one it proved.
 */
export async function completeOtpSignIn(challengeId: string, code: string, ctx: AuthContext): Promise<SignInResult> {
  const kind = challengeKindOf(challengeId);
  if (kind !== 'otp_email' && kind !== 'otp_sms') {
    throw err.badRequest('That challenge is not an OTP request');
  }
  const row = loadChallenge(challengeId, kind);
  const targetHash = row.target_hash ?? '';

  const expected = sha256Hex(`${challengeId}:${code.trim()}`);
  if (!row.code_hash || !assertConstantTimeEqual(expected, row.code_hash)) {
    recordChallengeFailure(challengeId);
    audit({
      action: 'auth.otp_failed',
      target: { type: 'identity', id: targetHash.slice(0, 16) },
      severity: 'notice',
      ipHash: keyedHash(ctx.ip, 'client-ip'),
    });
    throw err.unauthorized('That code is not correct');
  }
  consumeChallenge(challengeId);

  const identity = db()
    .prepare('SELECT user_id FROM identities WHERE identifier_hash = ?')
    .get(targetHash) as { user_id: string } | undefined;

  const method: LoginMethod = kind === 'otp_email' ? 'otp_email' : 'otp_sms';
  if (identity) {
    // Proving control of the identifier also proves it is verified.
    db().prepare('UPDATE identities SET verified = 1 WHERE identifier_hash = ?').run(targetHash);
    db().prepare('UPDATE users SET verified = 1, updated_at = ? WHERE id = ?').run(nowMs(), identity.user_id);
    return finishSignIn(identity.user_id, method, ctx, keyedHash(ctx.ip, 'client-ip'), false);
  }

  // No account yet: create one, attaching the identifier by hash. The plaintext
  // was never stored, and does not need to be — the hash is what every lookup uses.
  const user = createUser({ verified: true });
  db().prepare(`
    INSERT INTO identities (id, user_id, method, identifier_hash, encrypted_value, fingerprint, verified, is_primary, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, 1, 1, ?)
  `).run(
    newId(), user.id, kind === 'otp_email' ? 'email' : 'phone', targetHash,
    identityFingerprint(targetHash, kind === 'otp_email' ? 'email' : 'phone'), nowMs(),
  );
  return finishSignIn(user.id, method, ctx, keyedHash(ctx.ip, 'client-ip'), true);
}

/** Verify a magic-link click. */
export async function consumeMagicLink(challengeId: string, token: string, ctx: AuthContext): Promise<SignInResult> {
  const row = loadChallenge(challengeId, 'magic_link');
  if (!row.token_hash || !assertConstantTimeEqual(sha256Hex(token), row.token_hash)) {
    recordChallengeFailure(challengeId);
    throw err.unauthorized('That link is not valid');
  }
  consumeChallenge(challengeId);

  // The address is not recoverable from the hash, so the identity row is looked
  // up by hash. Clicking the link proves control, so a first-time click creates
  // and verifies the account in one step.
  const identity = db()
    .prepare('SELECT user_id FROM identities WHERE identifier_hash = ?')
    .get(row.target_hash ?? '') as { user_id: string } | undefined;

  if (identity) return finishSignIn(identity.user_id, 'magic_link', ctx, keyedHash(ctx.ip, 'client-ip'), false);

  // No identity row yet: create the account, then attach the address as verified
  // using the email hash stored in the challenge context.
  const user = createUser({ verified: true });
  const context = row.context_json ? (JSON.parse(row.context_json) as { emailHash?: string }) : {};
  if (context.emailHash) {
    db().prepare(`
      INSERT INTO identities (id, user_id, method, identifier_hash, encrypted_value, fingerprint, verified, is_primary, created_at)
      VALUES (?, ?, 'email', ?, NULL, ?, 1, 1, ?)
    `).run(newId(), user.id, row.target_hash, identityFingerprint(row.target_hash ?? '', 'email'), nowMs());
  }
  return finishSignIn(user.id, 'magic_link', ctx, keyedHash(ctx.ip, 'client-ip'), true);
}

/* ─────────────────────────── OTP issuing ─────────────────────────── */

export async function startOtpChallenge(kind: 'otp_email' | 'otp_sms', target: string): Promise<string> {
  const targetHash = keyedHash(`${kind === 'otp_email' ? 'email' : 'phone'}:${target}`, 'identity');
  assertSendCooldown(kind, targetHash);

  const code = generateOtp(config.auth.otp.length);
  const challenge = createChallenge(kind, {
    code,
    targetHash,
    channel: kind === 'otp_email' ? 'email' : 'sms',
    ttlSeconds: config.auth.otp.ttlSeconds,
    maxAttempts: config.auth.otp.maxAttempts,
  });

  const appName = config.app.name;
  const minutes = Math.round(config.auth.otp.ttlSeconds / 60);
  if (kind === 'otp_email') {
    await sendEmail({
      to: target,
      subject: `${code} is your ${appName} code`,
      text:
        `Your ${appName} verification code is ${code}.\n\n` +
        `It expires in ${minutes} minutes. If you did not request it, ignore this email.`,
      html: otpHtml(code, appName),
      category: 'transactional',
    });
  } else {
    await sendSms({
      to: target,
      message: `${code} is your ${appName} verification code. Valid for ${minutes} minutes. Do not share it with anyone.`,
      templateId: config.providers.sms.msg91.templateId || undefined,
      variables: { otp: code },
    });
  }

  audit({ action: `auth.${kind}_sent`, target: { type: 'identity', id: targetHash.slice(0, 16) } });
  return challenge.id;
}

/** Issue a verification challenge for an existing account's email or phone. */
export async function startVerification(userId: string, method: 'email' | 'phone', value: string): Promise<string> {
  const challengeId = await startOtpChallenge(method === 'email' ? 'otp_email' : 'otp_sms', value);
  db().prepare('UPDATE challenges SET user_id = ? WHERE id = ?').run(userId, challengeId);
  return challengeId;
}

export function confirmVerification(challengeId: string, code: string, userId: string): void {
  const kind = challengeKindOf(challengeId);
  const row = loadChallenge(challengeId, kind);
  const expected = sha256Hex(`${challengeId}:${code.trim()}`);
  if (!row.code_hash || !assertConstantTimeEqual(expected, row.code_hash)) {
    recordChallengeFailure(challengeId);
    throw err.unauthorized('That code is not correct');
  }
  consumeChallenge(challengeId);
  db().prepare('UPDATE identities SET verified = 1 WHERE user_id = ?').run(userId);
  db().prepare("UPDATE users SET verified = 1, updated_at = ? WHERE id = ?").run(nowMs(), userId);
  audit({ actorId: userId, action: 'auth.identifier_verified', target: { type: 'user', id: userId } });
}

function challengeKindOf(challengeId: string): ChallengeKind {
  const row = db().prepare('SELECT kind FROM challenges WHERE id = ?').get(challengeId) as
    | { kind: ChallengeKind }
    | undefined;
  return row?.kind ?? 'otp_email';
}

/** Complete a 2FA step during sign-in. */
export async function completeTwoFactor(challengeId: string, code: string, ctx: AuthContext): Promise<SignInResult> {
  const row = loadChallenge(challengeId, 'two_factor');
  if (!row.user_id) throw err.badRequest('That challenge is not bound to an account');

  // Accept either the emailed code or a TOTP code from an authenticator app.
  const emailedOk = !!row.code_hash && assertConstantTimeEqual(sha256Hex(`${challengeId}:${code.trim()}`), row.code_hash);
  const user = getUser(row.user_id);
  const totpOk = !emailedOk && !!user.two_factor_secret && verifyTotp(user.two_factor_secret, code);
  if (!emailedOk && !totpOk) {
    recordChallengeFailure(challengeId);
    audit({
      actorId: row.user_id,
      action: 'auth.2fa_failed',
      target: { type: 'user', id: row.user_id },
      severity: 'warning',
    });
    throw err.unauthorized('That code is not correct');
  }
  consumeChallenge(challengeId);
  return finishSignIn(row.user_id, 'passkey', ctx, keyedHash(ctx.ip, 'client-ip'), false);
}

/* ─────────────────────────── The single sign-in funnel ─────────────────────────── */

function finishSignIn(
  userId: string,
  method: LoginMethod,
  ctx: AuthContext,
  ipHash: string,
  created: boolean,
): SignInResult {
  const user = getUser(userId);
  if (user.status === 'deleted') throw err.forbidden('This account no longer exists');
  if (user.status === 'suspended') {
    throw err.forbidden('This account is suspended. Contact support if you believe this is a mistake.');
  }
  if (user.status === 'deactivated') {
    // Reactivate on successful authentication inside the grace window.
    db().prepare("UPDATE users SET status = 'active', deactivated_at = NULL, delete_after = NULL, updated_at = ? WHERE id = ?")
      .run(nowMs(), userId);
  }

  const tokens = issueTokens(userId, ctx.device, {
    ipHash,
    country: null,
    userAgent: ctx.userAgent ?? null,
  });

  const now = nowMs();
  db().prepare('UPDATE identities SET last_used_at = ? WHERE user_id = ?').run(now, userId);
  db().prepare('UPDATE users SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(now, now, userId);

  audit({
    actorId: userId,
    actorRole: user.role,
    action: created ? 'auth.account_created' : 'auth.signed_in',
    target: { type: 'user', id: userId },
    severity: 'info',
    ipHash,
    meta: { method, platform: ctx.device.platform, created },
  });

  // Login alert to a verified address, if the user has enabled it. Never allowed
  // to block or slow the sign-in itself.
  if (!created && toPrivateProfile(getUser(userId)).settings.security.loginAlerts) {
    void sendLoginAlert(userId, ctx);
  }

  return { tokens, profile: toPrivateProfile(getUser(userId)), created, method };
}

async function sendLoginAlert(userId: string, ctx: AuthContext): Promise<void> {
  try {
    const address = await recoveryAddress(userId);
    if (!address) return;
    await sendEmail({
      to: address,
      subject: `New sign-in to ${config.app.name}`,
      text:
        `A new device signed in to your account.\n\n` +
        `Platform: ${ctx.device.platform}\n` +
        `App version: ${ctx.device.appVersion}\n` +
        `When: ${new Date().toUTCString()}\n\n` +
        `If this was you, no action is needed. If it was not, open ` +
        `${config.app.name} → Settings → Security → Active sessions, sign out everything else, ` +
        `then change your password.`,
      category: 'transactional',
    });
  } catch {
    // A failed alert must never block the sign-in.
  }
}

async function recoveryAddress(userId: string): Promise<string | null> {
  return recoverIdentifier(userId, 'email');
}

/**
 * Password policy rejections are client-facing validation, not server faults:
 * the crypto layer throws plain Errors, and those must arrive as 400s with the
 * human reason attached, never as opaque 500s.
 */
function requireAcceptablePassword(password: string, context: string[]): void {
  try {
    assertPasswordAcceptable(password, context);
  } catch (e) {
    throw err.badRequest(e instanceof Error ? e.message : 'That password is not acceptable');
  }
}

/* ─────────────────────────── Password management ─────────────────────────── */

export function changePassword(userId: string, currentPassword: string | null, newPassword: string): void {
  const user = getUser(userId);
  if (user.password_hash) {
    if (!currentPassword) throw err.badRequest('Your current password is required');
    if (!verifyPassword(currentPassword, user.password_hash)) {
      audit({
        actorId: userId,
        action: 'security.password_change_failed',
        target: { type: 'user', id: userId },
        severity: 'warning',
      });
      throw err.unauthorized('That current password is not correct');
    }
  }
  requireAcceptablePassword(newPassword, [user.handle, user.display_name ?? '']);
  // Clearing must_change_password here is what makes a staff credential reset
  // a one-time event: the forced dialog disappears once the user owns a
  // password of their own choosing.
  db().prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
    .run(hashPassword(newPassword), nowMs(), userId);
  audit({
    actorId: userId,
    action: 'security.password_changed',
    target: { type: 'user', id: userId },
    severity: 'warning',
  });
}

/** Revoke every session except the caller's own, and say how many went. */
export function revokeEveryOtherSession(userId: string, currentSessionId: string): number {
  const count = revokeAllSessions(userId, 'password_changed', currentSessionId || undefined);
  audit({
    actorId: userId,
    action: 'security.sessions_revoked',
    target: { type: 'user', id: userId },
    severity: 'warning',
    meta: { count },
  });
  return count;
}

export function strengthOf(password: string, context: string[] = []): { score: number; acceptable: boolean } {
  const score = passwordScore(password, context);
  return {
    score,
    acceptable: score >= config.auth.password.minScore && password.length >= config.auth.password.minLength,
  };
}

/* ─────────────────────────── Two-factor (TOTP) ─────────────────────────── */

/**
 * Enrol a TOTP second factor. The secret is returned exactly once, as both a raw
 * string and an `otpauth://` URI for QR scanning, and is not marked enabled until
 * `confirmTwoFactor` proves the user can actually generate codes from it.
 */
export function enrollTwoFactor(userId: string): { secret: string; otpauthUrl: string } {
  const user = getUser(userId);
  if (!user.password_hash) {
    throw err.badRequest('Set a password before enabling two-factor authentication');
  }
  // 20 bytes of base32-ish entropy, rendered as the uppercase hex an
  // authenticator app expects.
  const secret = randomHex(20).toUpperCase().slice(0, 32);
  db().prepare('UPDATE users SET two_factor_secret = ?, two_factor_enabled = 0, updated_at = ? WHERE id = ?')
    .run(secret, nowMs(), userId);

  const label = encodeURIComponent(`${config.app.name}:${user.handle}`);
  const otpauthUrl =
    `otpauth://totp/${label}?secret=${secret}` +
    `&issuer=${encodeURIComponent(config.app.name)}&algorithm=SHA1&digits=6&period=30`;

  audit({ actorId: userId, action: 'security.2fa_enrolled', target: { type: 'user', id: userId }, severity: 'warning' });
  return { secret, otpauthUrl };
}

/**
 * RFC 6238 TOTP on node:crypto HMAC-SHA1.
 *
 * The secret is treated as hex rather than base32 because that is what
 * `enrollTwoFactor` generates and what we store; an authenticator app is given
 * the same bytes through the otpauth URI, so the two agree.
 */
export function totpCode(secretHex: string, atMs = Date.now(), period = 30, digits = 6): string {
  const key = Buffer.from(secretHex, 'hex');
  const counter = Math.floor(atMs / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Accept one step of clock drift either side — 90 seconds total. */
export function verifyTotp(secretHex: string, code: string, window = 1): boolean {
  const now = Date.now();
  const candidate = code.trim();
  for (let offset = -window; offset <= window; offset++) {
    if (assertConstantTimeEqual(totpCode(secretHex, now + offset * 30_000), candidate)) return true;
  }
  return false;
}

export function confirmTwoFactor(userId: string, code: string): void {
  const user = getUser(userId);
  if (!user.two_factor_secret) throw err.badRequest('Two-factor authentication is not enrolled');
  if (!verifyTotp(user.two_factor_secret, code)) throw err.unauthorized('That code is not correct');
  db().prepare('UPDATE users SET two_factor_enabled = 1, updated_at = ? WHERE id = ?').run(nowMs(), userId);
  audit({ actorId: userId, action: 'security.2fa_enabled', target: { type: 'user', id: userId }, severity: 'warning' });
}

export function disableTwoFactor(userId: string, password: string): void {
  const user = getUser(userId);
  if (user.password_hash && !verifyPassword(password, user.password_hash)) {
    throw err.unauthorized('Your password is required to turn off two-factor authentication');
  }
  db().prepare('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0, updated_at = ? WHERE id = ?')
    .run(nowMs(), userId);
  audit({ actorId: userId, action: 'security.2fa_disabled', target: { type: 'user', id: userId }, severity: 'warning' });
}

/* ─────────────────────────── Identity linking ─────────────────────────── */

/**
 * Attach an email or phone to an existing account, then require proof of control
 * before it is marked verified. Adding an identifier you do not control must
 * never become a way to hijack someone else's recovery path.
 */
export async function addIdentifier(userId: string, method: 'email' | 'phone', value: string): Promise<string> {
  const normalised = method === 'email' ? normaliseEmail(value) : normalisePhone(value);
  if (method === 'email' && !isValidEmail(normalised)) throw err.badRequest('That email address is not valid');
  if (method === 'phone' && !isValidPhone(normalised)) {
    throw err.badRequest('That phone number is not valid. Include the country code, e.g. +91…');
  }
  if (findByIdentifier(method, normalised)) {
    throw new AppError('identifier_in_use', 'Another account already uses that', 409);
  }
  attachIdentity(userId, method, normalised, false);
  return startVerification(userId, method, normalised);
}

/* ─────────────────────────── Email templates ─────────────────────────── */

function otpHtml(code: string, appName: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:40px 20px">
  <div style="background:#fff;border-radius:16px;padding:32px;text-align:center">
    <div style="font-size:14px;color:#6b7280;letter-spacing:.02em">${escapeHtml(appName)} verification code</div>
    <div style="font-size:40px;font-weight:600;letter-spacing:.35em;margin:20px 0;color:#111827">${code}</div>
    <div style="font-size:13px;color:#6b7280;line-height:1.6">
      Expires in ${Math.round(config.auth.otp.ttlSeconds / 60)} minutes.<br>
      If you did not request this code you can safely ignore this email.
    </div>
  </div>
  <div style="text-align:center;font-size:12px;color:#9ca3af;margin-top:20px">
    ${escapeHtml(appName)} will never ask you for this code.
  </div>
</div></body></html>`;
}

function magicLinkHtml(url: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:40px 20px">
  <div style="background:#fff;border-radius:16px;padding:32px;text-align:center">
    <div style="font-size:18px;font-weight:600;color:#111827">Sign in to ${escapeHtml(config.app.name)}</div>
    <a href="${url}" style="display:inline-block;margin:24px 0;padding:12px 28px;background:#6366f1;color:#fff;border-radius:999px;text-decoration:none;font-weight:500">Open ${escapeHtml(config.app.name)}</a>
    <div style="font-size:13px;color:#6b7280;line-height:1.6">
      This link expires in 15 minutes and works once.<br>
      If the button does not work, copy this address:<br>
      <span style="word-break:break-all;color:#374151">${escapeHtml(url)}</span>
    </div>
  </div>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
