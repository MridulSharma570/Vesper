/**
 * HTTP middleware: auth guard, error mapping, rate limits, request context.
 *
 * The auth guard decorates the request with `req.auth` and throws `AppError`
 * otherwise, so route handlers never repeat token parsing. Role checks use the
 * rank ordering from shared/types.ts, which means "moderator or above" is one
 * comparison rather than a list that drifts.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceInfo, Platform, Role } from '../../../shared/types.js';
import { ROLE_RANK } from '../../../shared/types.js';
import { AppError, err } from '../services/users.js';
import { verifyAccessToken } from '../services/tokens.js';
import { getUser } from '../services/users.js';
import { getFlags } from '../services/features.js';
import { audit } from '../services/audit.js';
import { keyedHash } from '../security/crypto.js';
import { db, nowMs } from '../db/index.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  role: Role;
  handle: string;
  ipHash: string;
  ip: string;
  userAgent: string | null;
  device: DeviceInfo;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

const RANK = ROLE_RANK;

export function requireAuth(req: FastifyRequest): AuthContext {
  if (req.auth) return req.auth;
  const header = req.headers.authorization ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw err.unauthorized('Sign in to continue');

  const claims = verifyAccessToken(token);
  const user = getUser(claims.sub);
  if (user.status === 'deleted') throw err.forbidden('This account no longer exists');
  if (user.status === 'suspended') throw err.forbidden('This account is suspended');
  if (user.status === 'deactivated') throw err.forbidden('This account is deactivated. Sign in again to restore it.');

  // The session must still be live: an access token alone is not enough after a
  // revocation, which is what makes "sign out everywhere" actually work.
  const session = db().prepare('SELECT revoked_at FROM sessions WHERE id = ?').get(claims.sid) as
    | { revoked_at: number | null }
    | undefined;
  if (session && session.revoked_at) throw err.unauthorized('That session has been signed out');

  const ip = clientIp(req);
  const ua = req.headers['user-agent'] ?? null;
  const device = deviceFromHeaders(req);

  req.auth = {
    userId: claims.sub,
    sessionId: claims.sid,
    role: user.role,
    handle: user.handle,
    ipHash: keyedHash(ip, 'client-ip'),
    ip,
    userAgent: ua,
    device,
  };
  return req.auth;
}

/** Assert the caller is at least `role`. */
export function requireRole(req: FastifyRequest, role: Role): AuthContext {
  const auth = requireAuth(req);
  if ((RANK[auth.role] ?? 0) < (RANK[role] ?? 0)) {
    audit({
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'admin.access_denied',
      target: { type: 'role', id: role },
      severity: 'warning',
      ipHash: auth.ipHash,
    });
    throw err.forbidden(`That action needs ${role} access or higher`);
  }
  return auth;
}

export function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : String(forwarded ?? '').split(',')[0];
  const ip = (first ?? '').trim() || req.ip || '0.0.0.0';
  // Strip an IPv6 zone or a port suffix so the hash is stable.
  return ip.replace(/^\[|\]$/g, '').replace(/:\d+$/, '');
}

export function deviceFromHeaders(req: FastifyRequest): DeviceInfo {
  const h = req.headers as Record<string, string | string[] | undefined>;
  const platform = String(h['x-vesper-platform'] ?? h['x-platform'] ?? inferPlatform(req.headers['user-agent'])) as Platform;
  return {
    deviceId: String(h['x-vesper-device-id'] ?? h['x-device-id'] ?? 'unknown'),
    platform,
    appVersion: String(h['x-vesper-app-version'] ?? '0.0.0'),
    osVersion: h['x-vesper-os-version'] ? String(h['x-vesper-os-version']) : null,
    model: h['x-vesper-model'] ? String(h['x-vesper-model']) : null,
    pushToken: null,
    pushProvider: 'none',
  };
}

function inferPlatform(ua?: string): Platform {
  const s = String(ua ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('vesper-desktop') || s.includes('electron')) return 'windows';
  if (s.includes('vesper-ios') || (s.includes('iphone') || s.includes('ipad'))) return 'ios';
  if (s.includes('vesper-android') || s.includes('android')) return 'android';
  if (s.includes('mac os') || s.includes('macintosh')) return 'macos';
  if (s.includes('linux')) return 'linux';
  return 'web';
}

/** Refuse non-staff traffic while maintenance mode is on. */
export function assertNotMaintenance(req: FastifyRequest): void {
  if (!getFlags().maintenance) return;
  const role = req.auth?.role;
  if (role && ['admin', 'owner', 'developer', 'controller'].includes(role)) return;
  throw new AppError('maintenance', 'Vesper is briefly offline for maintenance. Please try again shortly.', 503);
}

/* ─────────────────────────── Error mapping ─────────────────────────── */

/**
 * Turn any thrown value into a clean HTTP response. The shape is always
 * `{ error: { code, message, details? } }` so the client has one parser, and
 * internal errors are logged in full but never leaked to the caller.
 */
export function errorHandler(
  error: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const ip = clientIp(req);
  const ipHash = keyedHash(ip, 'client-ip');

  if (error instanceof AppError) {
    if (error.status >= 500) {
      req.log.error({ err: error, code: error.code }, 'internal error');
      audit({ actorId: req.auth?.userId, action: 'server.error', severity: 'critical', ipHash, meta: { code: error.code, route: req.routeOptions?.url ?? req.url } });
    }
    void reply.status(error.status).send({
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    });
    return;
  }

  // Fastify's own validation errors (zod/schema failures, bad JSON).
  const anyErr = error as { validation?: unknown; statusCode?: number; message?: string; code?: string; name?: string; issues?: unknown };
  if (anyErr?.validation) {
    void reply.status(400).send({
      error: { code: 'validation_failed', message: 'Some of the data you sent is not valid', details: { validation: anyErr.validation } },
    });
    return;
  }

  // Handlers parse bodies with zod directly; a rejected schema is the client's
  // mistake, not a server fault. Without this mapping a typo'd field burns a
  // 500, an audit row and an operator's patience.
  if (anyErr?.name === 'ZodError' && anyErr.issues) {
    void reply.status(400).send({
      error: {
        code: 'validation_failed',
        message: 'Some of the data you sent is not valid',
        details: { issues: (anyErr.issues as { path?: (string | number)[]; message?: string }[])
          .map((i) => ({ field: (i.path ?? []).join('.') || '(root)', message: i.message })) },
      },
    });
    return;
  }

  if (anyErr?.statusCode === 429) {
    void reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' } });
    return;
  }
  if (anyErr?.statusCode && anyErr.statusCode >= 400 && anyErr.statusCode < 500) {
    void reply.status(anyErr.statusCode).send({
      error: { code: anyErr.code ?? 'bad_request', message: anyErr.message ?? 'That request could not be processed' },
    });
    return;
  }

  req.log.error({ err: error, url: req.url }, 'unhandled error');
  audit({
    actorId: req.auth?.userId,
    action: 'server.unhandled_error',
    severity: 'critical',
    ipHash,
    meta: { route: req.routeOptions?.url ?? req.url, message: String(anyErr?.message ?? '').slice(0, 300) },
  });
  void reply.status(500).send({
    error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' },
  });
}

/* ─────────────────────────── Rate limit tiers ─────────────────────────── */

/**
 * Named tiers rather than a single global limit: a chatty client should be able
 * to poll presence without burning its budget for sending messages, and
 * authentication endpoints need to be far stricter than everything else.
 */
export const RATE_TIERS = {
  /** Password and OTP attempts — strict, and keyed per identifier+IP. */
  auth: { max: 12, timeWindow: '1 minute' },
  /** Message sends — generous for humans, impossible for a bot to sustain. */
  message: { max: 120, timeWindow: '1 minute' },
  /** Upload requests. */
  upload: { max: 40, timeWindow: '1 minute' },
  /** Directory lookups. */
  lookup: { max: 40, timeWindow: '1 minute' },
  /** Everything else. */
  api: { max: 300, timeWindow: '1 minute' },
  /** Admin mutations. */
  admin: { max: 200, timeWindow: '1 minute' },
} as const;

export type RateTier = keyof typeof RATE_TIERS;

/**
 * The rate-limit key includes the user id when authenticated and the IP hash
 * otherwise. Keying on a raw IP alone would punish a whole NAT (a university
 * dorm, a mobile carrier) for one person's behaviour; keying on the user alone
 * would let an unauthenticated attacker hammer the auth endpoints.
 */
export function rateKeyGenerator(tier: RateTier) {
  return (req: FastifyRequest): string => {
    const ipHash = keyedHash(clientIp(req), 'client-ip');
    const userId = req.auth?.userId;
    return `${tier}:${userId ?? ipHash}`;
  };
}

/**
 * Test escape hatch, development only: the e2e and admin suites legitimately
 * burn the strict auth tier (12/min) in seconds. VESPER_TEST_NO_RATELIMIT=1
 * lifts every tier so suites can run back-to-back; the flag is ignored in
 * production, so a misconfigured deploy cannot disable its own protection.
 */
export const TEST_NO_RATELIMIT =
  process.env.NODE_ENV !== 'production' && process.env.VESPER_TEST_NO_RATELIMIT === '1';

export function rateLimitConfig(tier: RateTier) {
  if (TEST_NO_RATELIMIT) {
    return { max: 1_000_000, timeWindow: '1 minute', keyGenerator: rateKeyGenerator(tier) };
  }
  return { ...RATE_TIERS[tier], keyGenerator: rateKeyGenerator(tier) };
}

/* ─────────────────────────── Request hygiene ─────────────────────────── */

/**
 * Strip anything that looks like a credential from the audit trail of a request.
 * Fastify's logger would otherwise serialise request bodies.
 */
export const REDACT = [
  'password', 'currentPassword', 'newPassword', 'token', 'accessToken', 'refreshToken',
  'idToken', 'code', 'otp', 'secret', 'privateKey', 'authorization', 'cookie',
  'req.headers.authorization', 'req.headers.cookie',
];

/** Cap a JSON body so one request cannot exhaust memory. */
export const BODY_LIMIT = 1 * 1024 * 1024;

/** Short cache header for GET responses that are safe to cache briefly. */
export function shortCache(reply: FastifyReply, seconds = 30): void {
  void reply.header('Cache-Control', `private, max-age=${seconds}`);
}

/** No-store for anything identity-bearing. */
export function noStore(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
}

export function touchActivity(userId: string): void {
  db().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowMs(), userId);
}
