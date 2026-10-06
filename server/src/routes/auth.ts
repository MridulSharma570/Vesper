/**
 * /auth — registration, sign-in, OTP, magic links, OAuth, sessions, passwords.
 *
 * Everything here is rate-limited on the `auth` tier and audited. The response
 * shapes are identical whether or not an identifier exists, so the endpoints
 * cannot be used as an account oracle.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DeviceInfo } from '../../../shared/types.js';
import { config } from '../config.js';
import type { AuthContext } from '../services/auth.js';
import { db, nowMs } from '../db/index.js';
import { err, getUser, toPrivateProfile } from '../services/users.js';
import {
  changePassword, completeOtpSignIn, completeTwoFactor, confirmTwoFactor, confirmVerification, consumeMagicLink,
  disableTwoFactor, enrollTwoFactor, register, revokeEveryOtherSession, signIn,
  startOtpChallenge, startVerification, strengthOf, verifyTotp,
} from '../services/auth.js';
import { issueRealtimeTicket, issueTokens, listSessions, revokeSession, rotateRefreshToken } from '../services/tokens.js';
import { federatedProvidersEnabled, googleAuthorizeUrl, pkceChallenge } from '../adapters/oauth/index.js';
import { getFlags, publicConfig } from '../services/features.js';
import { audit } from '../services/audit.js';
import { clientIp, deviceFromHeaders, noStore, rateLimitConfig, requireAuth } from '../middleware/index.js';
import { keyedHash, randomHex } from '../security/crypto.js';
import { newId, newToken } from '../lib/ids.js';

/**
 * Normalises to exactly the shared `DeviceInfo` shape. Optional fields become
 * explicit nulls rather than undefined, so the object is structurally identical
 * to what the database and the realtime hub expect.
 */
const deviceSchema = z.object({
  deviceId: z.string().min(8).max(128),
  platform: z.enum(['web', 'android', 'ios', 'windows', 'macos', 'linux', 'unknown']),
  appVersion: z.string().max(32).default('0.0.0'),
  osVersion: z.string().max(64).nullish(),
  model: z.string().max(128).nullish(),
  pushToken: z.string().max(4096).nullish(),
  pushProvider: z.enum(['none', 'fcm', 'apns', 'web', 'wns']).default('none'),
}).transform((d) => ({
  deviceId: d.deviceId,
  platform: d.platform,
  appVersion: d.appVersion,
  osVersion: d.osVersion ?? null,
  model: d.model ?? null,
  pushToken: d.pushToken ?? null,
  pushProvider: d.pushProvider,
} satisfies DeviceInfo));

const registerSchema = z.object({
  method: z.enum(['passkey', 'otp_email', 'otp_sms', 'google', 'apple', 'magic_link', 'device_key']),
  email: z.string().max(254).optional(),
  phone: z.string().max(20).optional(),
  password: z.string().max(256).optional(),
  handle: z.string().min(3).max(32).regex(/^[a-z0-9_]+$/i).optional(),
  displayName: z.string().max(64).optional(),
  identityKey: z.string().max(512).optional(),
  challengeId: z.string().max(64).optional(),
  code: z.string().max(12).optional(),
  idToken: z.string().max(16_384).optional(),
  oauthCode: z.string().max(512).optional(),
  redirectUri: z.string().max(512).optional(),
  codeVerifier: z.string().max(256).optional(),
  device: deviceSchema,
});

/** RegisterInput plus the device, which travels in the auth context. */
type RegisterBody = z.infer<typeof registerSchema>;
function toRegisterInput(body: RegisterBody): Parameters<typeof register>[0] {
  const { device: _device, ...rest } = body;
  return rest;
}

export function authRoutes(app: FastifyInstance): void {
  /** What the client needs before it can render a sign-in screen. */
  app.get('/auth/config', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    return publicConfig('user');
  });

  app.get('/auth/methods', { config: { rateLimit: rateLimitConfig('api') } }, async (_req, reply) => {
    noStore(reply);
    const flags = getFlags();
    const federated = federatedProvidersEnabled();
    return {
      methods: flags.registrationMethods,
      google: federated.google,
      apple: federated.apple,
      maintenance: flags.maintenance,
    };
  });

  /* ── Register & sign in ──────────────────────────────────────── */

  /**
   * Shared body for register and sign-in. Both return either a session or a
   * verification step, and the client branches on the presence of `step`.
   */
  const authHandler = async (req: FastifyRequest, reply: FastifyReply, isRegister: boolean) => {
    noStore(reply);
    const body = registerSchema.parse(await req.body);
    const ctx: AuthContext = {
      ip: clientIp(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
      device: body.device,
    };
    const input = toRegisterInput(body);
    const result = await (isRegister ? register(input, ctx) : signIn(input, ctx));

    if ('step' in result) {
      // No session yet: the caller must prove control of the identifier. The
      // target is masked so this response cannot be used to enumerate accounts.
      return reply.status(202).send({
        step: result.step,
        challengeId: result.challengeId,
        kind: result.kind,
        channel: result.channel,
        targetHint: result.targetHint,
        ttlSeconds: result.ttlSeconds,
      });
    }
    return reply.status(result.created ? 201 : 200).send({
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresIn: result.tokens.expiresIn,
      session: result.tokens.session,
      profile: result.profile,
      created: result.created,
      method: result.method,
      flags: getFlags(),
    });
  };

  app.post('/auth/register', { config: { rateLimit: rateLimitConfig('auth') } }, (req, reply) => authHandler(req, reply, true));
  app.post('/auth/login', { config: { rateLimit: rateLimitConfig('auth') } }, (req, reply) => authHandler(req, reply, false));

  /* ── OTP ─────────────────────────────────────────────────────── */

  const otpStartSchema = z.object({
    kind: z.enum(['otp_email', 'otp_sms']),
    target: z.string().max(254),
  });

  app.post('/auth/otp/start', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const { kind, target } = otpStartSchema.parse(await req.body);
    const challengeId = await startOtpChallenge(kind, target);
    return reply.status(202).send({ challengeId, ttlSeconds: config.auth.otp.ttlSeconds });
  });

  const otpVerifySchema = z.object({
    challengeId: z.string().max(64),
    code: z.string().min(4).max(12),
    device: deviceSchema,
    purpose: z.enum(['signin', 'verify_identifier', 'two_factor']).default('signin'),
  });

  app.post('/auth/otp/verify', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const body = otpVerifySchema.parse(await req.body);

    if (body.purpose === 'two_factor') {
      const result = await completeTwoFactor(body.challengeId, body.code, {
        ip: clientIp(req),
        userAgent: (req.headers['user-agent'] as string) ?? undefined,
        device: body.device,
      });
      return reply.send({
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresIn: result.tokens.expiresIn,
        profile: result.profile,
      });
    }

    if (body.purpose === 'verify_identifier') {
      const auth = requireAuth(req);
      confirmVerification(body.challengeId, body.code, auth.userId);
      return reply.send({ ok: true, profile: toPrivateProfile(getUser(auth.userId)) });
    }

    // Sign-in: the challenge carries the target hash; re-register through the
    // OTP path so a new account is created when none exists.
    const result = await completeOtpSignIn(body.challengeId, body.code, {
      ip: clientIp(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
      device: body.device,
    });
    return reply.send({
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresIn: result.tokens.expiresIn,
      session: result.tokens.session,
      profile: result.profile,
      created: result.created,
      method: result.method,
      flags: getFlags(),
    });
  });

  /* ── Magic link ──────────────────────────────────────────────── */

  const magicStartSchema = z.object({ email: z.string().max(254) });
  app.post('/auth/magic-link', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const { email } = magicStartSchema.parse(await req.body);
    const device = deviceFromHeaders(req);
    const result = await register({ method: 'magic_link', email }, { ip: clientIp(req), device });
    if (!('step' in result)) throw err.badRequest('Unexpected state');
    return reply.status(202).send({ ok: true, challengeId: result.challengeId });
  });

  app.get('/auth/magic', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    const q = req.query as { cid?: string; t?: string };
    if (!q.cid || !q.t) throw err.badRequest('That link is incomplete');
    try {
      const result = await consumeMagicLink(q.cid, q.t, {
        ip: clientIp(req), device: deviceFromHeaders(req), userAgent: (req.headers['user-agent'] as string) ?? undefined,
      });
      // Land the browser on the app with a one-time handoff code; never put the
      // access token in a URL, where it would end up in history and referrers.
      const handoff = randomHex(24);
      db().prepare('INSERT INTO challenges (id, kind, token_hash, attempts, max_attempts, created_at, expires_at, context_json, user_id) VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?)')
        .run(newId(), 'recovery', keyedHash(handoff, 'handoff'), nowMs(), nowMs() + 120_000, JSON.stringify({ handoff: true }), result.profile.id);
      return reply.redirect(`${config.app.publicUrl.replace(/\/$/, '')}/auth/handoff?c=${handoff}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'That link did not work';
      return reply.status(400).send({ error: { code: 'invalid_link', message } });
    }
  });

  /** Exchange a magic-link handoff code for tokens (called by the web client). */
  app.post('/auth/handoff', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const body = z.object({ code: z.string().max(64), device: deviceSchema }).parse(await req.body);
    const row = db().prepare("SELECT * FROM challenges WHERE kind = 'recovery' AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?")
      .get(keyedHash(body.code, 'handoff'), nowMs()) as Record<string, unknown> | undefined;
    if (!row) throw err.unauthorized('That handoff code is not valid');
    db().prepare('UPDATE challenges SET consumed_at = ? WHERE id = ?').run(nowMs(), String(row.id));
    const tokens = issueTokens(String(row.user_id), body.device, { ipHash: keyedHash(clientIp(req), 'client-ip') });
    return reply.send({
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn,
      profile: toPrivateProfile(getUser(String(row.user_id))),
    });
  });

  /* ── OAuth (web authorization-code flow) ─────────────────────── */

  app.get('/auth/oauth/:provider/start', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    const { provider } = req.params as { provider: 'google' | 'apple' };
    const redirectUri = `${config.app.publicUrl.replace(/\/$/, '')}/auth/oauth/${provider}/callback`;
    const state = newToken(24);
    const verifier = newToken(48);

    // The PKCE verifier and state live in a short-lived challenge row, because
    // there is no session yet and we must not trust a client-side cookie alone.
    db().prepare(`
      INSERT INTO challenges (id, kind, token_hash, channel, attempts, max_attempts, created_at, expires_at, context_json)
      VALUES (?, 'recovery', ?, ?, 0, 5, ?, ?, ?)
    `).run(newId(), keyedHash(state, 'oauth-state'), provider, nowMs(), nowMs() + 600_000,
      JSON.stringify({ verifier, redirectUri, provider }));

    const url = provider === 'google'
      ? googleAuthorizeUrl(state, pkceChallenge(verifier), redirectUri)
      : (await import('../adapters/oauth/index.js')).appleAuthorizeUrl(state, redirectUri);
    return reply.redirect(url);
  });

  app.post('/auth/oauth/:provider/callback', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const { provider } = req.params as { provider: 'google' | 'apple' };
    const body = z.object({
      code: z.string().max(4096),
      state: z.string().max(128),
      idToken: z.string().max(16_384).optional(),
      device: deviceSchema,
    }).parse(await req.body);

    const row = db().prepare("SELECT * FROM challenges WHERE kind = 'recovery' AND channel = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?")
      .get(provider, keyedHash(body.state, 'oauth-state'), nowMs()) as Record<string, unknown> | undefined;
    if (!row) throw err.badRequest('That sign-in attempt expired. Start again.', 'oauth_state_invalid');
    db().prepare('UPDATE challenges SET consumed_at = ? WHERE id = ?').run(nowMs(), String(row.id));
    const ctxRow = JSON.parse(String(row.context_json ?? '{}')) as { verifier: string; redirectUri: string };
    if (!ctxRow.verifier) throw err.badRequest('That sign-in attempt is not valid', 'oauth_state_invalid');

    const result = await register({
      method: provider,
      idToken: body.idToken,
      oauthCode: body.code,
      redirectUri: ctxRow.redirectUri,
      codeVerifier: ctxRow.verifier,
    }, {
      ip: clientIp(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
      device: body.device,
    });

    if ('step' in result) throw err.badRequest('That provider asked for an extra step we do not support');
    return reply.send({
      accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken, expiresIn: result.tokens.expiresIn,
      session: result.tokens.session, profile: result.profile, created: result.created, method: result.method,
      flags: getFlags(),
    });
  });

  /* ── Token lifecycle ─────────────────────────────────────────── */

  const refreshSchema = z.object({ refreshToken: z.string().max(256), device: deviceSchema });
  app.post('/auth/refresh', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const body = refreshSchema.parse(await req.body);
    const tokens = rotateRefreshToken(body.refreshToken, body.device, {
      ipHash: keyedHash(clientIp(req), 'client-ip'),
      userAgent: (req.headers['user-agent'] as string) ?? undefined,
    });
    return reply.send({
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn, session: tokens.session,
    });
  });

  app.post('/auth/logout', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ refreshToken: z.string().max(256).optional(), all: z.boolean().optional() }).parse(await req.body ?? {});
    if (body.all) {
      revokeEveryOtherSession(auth.userId, '');
      revokeSession(auth.sessionId, 'user_signout');
    } else {
      revokeSession(auth.sessionId, 'user_signout');
    }
    audit({ actorId: auth.userId, action: 'auth.signed_out', target: { type: 'session', id: auth.sessionId }, ipHash: auth.ipHash });
    void body.refreshToken;
    return reply.send({ ok: true });
  });

  /** 60-second ticket the client exchanges for a WebSocket connection. */
  app.post('/auth/realtime-ticket', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const body = z.object({ deviceId: z.string().max(128).optional() }).parse(await req.body ?? {});
    const ticket = issueRealtimeTicket(auth.userId, auth.sessionId, body.deviceId ?? auth.device.deviceId);
    return reply.send({ ticket, expiresIn: 60 });
  });

  /* ── Verification for an existing account ────────────────────── */

  app.post('/auth/verify/start', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ method: z.enum(['email', 'phone']) }).parse(await req.body);
    const { recoverIdentifier } = await import('../services/users.js');
    const value = await recoverIdentifier(auth.userId, body.method);
    if (!value) throw err.badRequest(`This account has no ${body.method} on file`);
    const challengeId = await startVerification(auth.userId, body.method, value);
    return reply.status(202).send({ challengeId });
  });

  app.post('/auth/verify/confirm', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ challengeId: z.string().max(64), code: z.string().max(12) }).parse(await req.body);
    confirmVerification(body.challengeId, body.code, auth.userId);
    return reply.send({ ok: true, profile: toPrivateProfile(getUser(auth.userId)) });
  });

  /* ── Password ────────────────────────────────────────────────── */

  app.post('/auth/password/change', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ currentPassword: z.string().max(256).nullish(), newPassword: z.string().min(8).max(256) }).parse(await req.body);
    changePassword(auth.userId, body.currentPassword ?? null, body.newPassword);
    const revoked = revokeEveryOtherSession(auth.userId, auth.sessionId);
    return reply.send({ ok: true, sessionsRevoked: revoked });
  });

  app.post('/auth/password/strength', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const body = z.object({ password: z.string().max(256) }).parse(await req.body);
    return reply.send(strengthOf(body.password));
  });

  /**
   * Account recovery without a password: prove control of a verified identifier.
   * This is the only recovery path, and it is deliberately the same strength as
   * sign-in — no security questions, no email-only reset that a SIM swap beats.
   */
  const recoverStartSchema = z.object({ identifier: z.string().max(254) });
  app.post('/auth/recover/start', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const { identifier } = recoverStartSchema.parse(await req.body);
    const isEmail = identifier.includes('@');
    // Always answer 202 with a challenge id, whether or not the account exists,
    // so this endpoint is not an oracle.
    const challengeId = await startOtpChallenge(isEmail ? 'otp_email' : 'otp_sms', identifier);
    return reply.status(202).send({ challengeId });
  });

  const recoverConfirmSchema = z.object({ challengeId: z.string().max(64), code: z.string().max(12), device: deviceSchema });
  app.post('/auth/recover/confirm', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    noStore(reply);
    const body = recoverConfirmSchema.parse(await req.body);
    const row = db().prepare('SELECT kind, target_hash FROM challenges WHERE id = ? AND consumed_at IS NULL').get(body.challengeId) as
      | { kind: string; target_hash: string | null }
      | undefined;
    if (!row) throw err.badRequest('That recovery request has expired');
    const result = await signIn(
      {
        method: row.kind === 'otp_email' ? 'otp_email' : 'otp_sms',
        challengeId: body.challengeId,
        code: body.code,
      },
      { ip: clientIp(req), device: body.device },
    );
    if ('step' in result) throw err.unauthorized('That code is not correct');
    return reply.send({
      accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken,
      expiresIn: result.tokens.expiresIn, profile: result.profile, recovered: true,
    });
  });

  /* ── Two-factor ──────────────────────────────────────────────── */

  app.post('/auth/2fa/enroll', { config: { rateLimit: rateLimitConfig('auth') } }, async (req) => {
    const auth = requireAuth(req);
    return enrollTwoFactor(auth.userId);
  });

  app.post('/auth/2fa/confirm', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ code: z.string().min(6).max(8) }).parse(await req.body);
    const user = getUser(auth.userId);
    if (!user.two_factor_secret) throw err.badRequest('Two-factor authentication is not enrolled');
    if (!verifyTotp(user.two_factor_secret, body.code)) throw err.unauthorized('That code is not correct');
    confirmTwoFactor(auth.userId, body.code);
    return reply.send({ ok: true });
  });

  app.post('/auth/2fa/disable', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ password: z.string().max(256) }).parse(await req.body);
    disableTwoFactor(auth.userId, body.password);
    return reply.send({ ok: true });
  });

  /* ── Sessions ────────────────────────────────────────────────── */

  app.get('/auth/sessions', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    return { sessions: listSessions(auth.userId, auth.sessionId) };
  });

  app.delete('/auth/sessions/:id', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    const owned = db().prepare('SELECT user_id FROM sessions WHERE id = ?').get(id) as { user_id: string } | undefined;
    if (!owned || owned.user_id !== auth.userId) throw err.notFound('Session');
    revokeSession(id, 'user_signout');
    audit({ actorId: auth.userId, action: 'auth.session_revoked', target: { type: 'session', id }, ipHash: auth.ipHash });
    return reply.send({ ok: true });
  });

  app.post('/auth/sessions/revoke-all', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const count = revokeEveryOtherSession(auth.userId, auth.sessionId);
    return reply.send({ ok: true, revoked: count });
  });
}
