/**
 * Session tokens.
 *
 * Two-token design:
 *   - Access token: short-lived JWT (15 min default), sent as `Authorization:
 *     Bearer`. Stateless, so the API and every WebSocket gateway can verify it
 *     without a database round-trip.
 *   - Refresh token: long-lived, opaque, stored *hashed*. Rotated on every use.
 *
 * Rotation with reuse detection: if a refresh token that has already been
 * consumed is presented again, the whole token family is revoked. That is the
 * standard defence against a stolen refresh token, and it turns theft into a
 * forced re-login for the attacker and an alert for the user.
 *
 * Sessions are revocable server-side: a row in `sessions` is written at issue
 * time, and `revoked_at` is checked on refresh and on WebSocket connect. Access
 * tokens are therefore valid for at most their TTL after a revocation, which is
 * why the TTL is short.
 */
import jwt from 'jsonwebtoken';
import type { DeviceInfo, Platform, Session } from '../../../shared/types.js';
import { config } from '../config.js';
import { db, nowMs } from '../db/index.js';
import { base64url, randomBytes, sha256Hex } from '../security/crypto.js';
import { newId } from '../lib/ids.js';
import { err, getUser } from './users.js';
import { audit } from './audit.js';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  role: string;
  handle: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  session: Session;
  expiresIn: number;
}

const hashToken = (t: string) => sha256Hex(t);

export function issueTokens(
  userId: string,
  device: DeviceInfo,
  context: { ipHash?: string | null; country?: string | null; userAgent?: string | null } = {},
): IssuedTokens {
  const user = getUser(userId);
  if (user.status === 'deleted') throw err.forbidden('This account no longer exists');
  if (user.status === 'suspended') {
    const until = user.suspension_until ? new Date(user.suspension_until).toISOString() : 'an administrator lifts it';
    throw err.forbidden(`This account is suspended until ${until}`);
  }

  const now = nowMs();
  const sessionId = newId();
  const accessTokenTtl = config.auth.accessTokenTtlSeconds;
  const refreshTokenTtlMs = config.auth.refreshTokenTtlDays * 86_400_000;

  const accessToken = jwt.sign(
    {
      sub: userId,
      sid: sessionId,
      role: user.role,
      handle: user.handle,
    },
    config.secrets.jwtSecret,
    {
      issuer: config.auth.jwtIssuer,
      audience: config.auth.jwtAudience,
      expiresIn: accessTokenTtl,
      algorithm: 'HS256',
    },
  );

  // Refresh tokens are opaque and high-entropy. Only the hash is stored, so a
  // database leak does not hand an attacker usable credentials.
  const refreshToken = `${base64url(randomBytes(32))}.${base64url(randomBytes(16))}`;
  const family = newId();

  const write = db().transaction(() => {
    db().prepare(`
      INSERT INTO devices (id, user_id, platform, app_version, os_version, model, push_token, push_provider, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET
        platform = excluded.platform,
        app_version = excluded.app_version,
        os_version = excluded.os_version,
        model = excluded.model,
        push_token = COALESCE(excluded.push_token, devices.push_token),
        push_provider = CASE WHEN excluded.push_token IS NOT NULL THEN excluded.push_provider ELSE devices.push_provider END,
        last_seen_at = excluded.last_seen_at
    `).run(
      device.deviceId, userId, device.platform, device.appVersion, device.osVersion,
      device.model, device.pushToken, device.pushProvider, now, now,
    );

    db().prepare(`
      INSERT INTO sessions (id, user_id, device_id, token_hash, ip_hash, country, user_agent, created_at, last_active_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, userId, device.deviceId, hashToken(accessToken),
      context.ipHash ?? null, context.country ?? null,
      context.userAgent?.slice(0, 256) ?? null,
      now, now, now + Math.max(accessTokenTtl * 1000, refreshTokenTtlMs),
    );

    db().prepare(`
      INSERT INTO refresh_tokens (id, user_id, session_id, token_hash, family, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId(), userId, sessionId, hashToken(refreshToken), family, now, now + refreshTokenTtlMs);
  });
  write();

  return {
    accessToken,
    refreshToken,
    session: {
      id: sessionId,
      userId,
      device,
      ipHash: context.ipHash ?? '',
      country: context.country ?? null,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + refreshTokenTtlMs,
      revokedAt: null,
      current: true,
    },
    expiresIn: accessTokenTtl,
  };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, config.secrets.jwtSecret, {
      issuer: config.auth.jwtIssuer,
      audience: config.auth.jwtAudience,
      algorithms: ['HS256'],
    }) as AccessTokenClaims;
    return decoded;
  } catch (e) {
    const reason = e instanceof Error ? e.name : 'Error';
    if (reason === 'TokenExpiredError') throw err.unauthorized('Your session has expired. Sign in again.');
    throw err.unauthorized('That session token is not valid');
  }
}

/**
 * Rotate a refresh token. Returns new tokens, or throws — including when reuse
 * of an already-consumed token is detected, which revokes the whole family.
 */
export function rotateRefreshToken(
  presented: string,
  device: DeviceInfo,
  context: { ipHash?: string | null; country?: string | null; userAgent?: string | null } = {},
): IssuedTokens {
  const hash = hashToken(presented);
  const row = db()
    .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
    .get(hash) as
    | { id: string; user_id: string; session_id: string; family: string; used_at: number | null; revoked_at: number | null; expires_at: number }
    | undefined;

  if (!row) throw err.unauthorized('That refresh token is not recognised');

  // Reuse detection: a token that was already spent should never come back.
  if (row.used_at || row.revoked_at) {
    revokeFamily(row.family, 'refresh_token_reuse');
    audit({
      actorId: row.user_id,
      action: 'security.refresh_token_reuse',
      target: { type: 'user', id: row.user_id },
      severity: 'critical',
      ipHash: context.ipHash ?? null,
      meta: { family: row.family, sessionsRevoked: true },
    });
    throw err.unauthorized('This session was reused and has been signed out everywhere for your safety');
  }

  if (row.expires_at < nowMs()) throw err.unauthorized('That refresh token has expired');

  const user = getUser(row.user_id);
  if (user.status === 'suspended' || user.status === 'deleted' || user.status === 'deactivated') {
    throw err.forbidden('This account cannot start a session');
  }

  const session = db()
    .prepare('SELECT revoked_at, expires_at FROM sessions WHERE id = ?')
    .get(row.session_id) as { revoked_at: number | null; expires_at: number } | undefined;
  if (session?.revoked_at) throw err.unauthorized('That session has been signed out');

  const now = nowMs();
  db().prepare('UPDATE refresh_tokens SET used_at = ?, replaced_by = NULL WHERE id = ?').run(now, row.id);
  db().prepare('UPDATE sessions SET last_active_at = ?, expires_at = ? WHERE id = ?')
    .run(now, now + config.auth.refreshTokenTtlDays * 86_400_000, row.session_id);

  // Issue within the same family so future reuse of any ancestor is detectable.
  const issued = issueTokensIntoFamily(row.user_id, row.family, row.session_id, device, context);
  return issued;
}

function issueTokensIntoFamily(
  userId: string,
  family: string,
  sessionId: string,
  device: DeviceInfo,
  context: { ipHash?: string | null; country?: string | null; userAgent?: string | null },
): IssuedTokens {
  const user = getUser(userId);
  const now = nowMs();
  const accessTokenTtl = config.auth.accessTokenTtlSeconds;

  const accessToken = jwt.sign(
    { sub: userId, sid: sessionId, role: user.role, handle: user.handle },
    config.secrets.jwtSecret,
    { issuer: config.auth.jwtIssuer, audience: config.auth.jwtAudience, expiresIn: accessTokenTtl, algorithm: 'HS256' },
  );
  const refreshToken = `${base64url(randomBytes(32))}.${base64url(randomBytes(16))}`;

  db().prepare(`
    INSERT INTO refresh_tokens (id, user_id, session_id, token_hash, family, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId(), userId, sessionId, hashToken(refreshToken), family, now, now + config.auth.refreshTokenTtlDays * 86_400_000);

  db().prepare(`
    INSERT INTO devices (id, user_id, platform, app_version, os_version, model, push_token, push_provider, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET last_seen_at = excluded.last_seen_at, app_version = excluded.app_version
  `).run(device.deviceId, userId, device.platform, device.appVersion, device.osVersion, device.model, device.pushToken, device.pushProvider, now, now);

  if (context.ipHash) {
    db().prepare('UPDATE sessions SET ip_hash = ?, country = ?, user_agent = ? WHERE id = ?')
      .run(context.ipHash, context.country ?? null, context.userAgent?.slice(0, 256) ?? null, sessionId);
  }

  const row = db().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown>;
  return {
    accessToken,
    refreshToken,
    session: {
      id: sessionId,
      userId,
      device,
      ipHash: String(row.ip_hash ?? ''),
      country: (row.country as string | null) ?? null,
      createdAt: Number(row.created_at),
      lastActiveAt: now,
      expiresAt: Number(row.expires_at),
      revokedAt: null,
      current: true,
    },
    expiresIn: accessTokenTtl,
  };
}

export function revokeSession(sessionId: string, reason = 'user_signout'): void {
  const now = nowMs();
  db().prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, reason, sessionId);
  db().prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL')
    .run(now, sessionId);
}

export function revokeAllSessions(userId: string, reason = 'user_request', exceptSessionId?: string): number {
  const now = nowMs();
  const sessions = db()
    .prepare(
      `UPDATE sessions SET revoked_at = ?, revoke_reason = ?
        WHERE user_id = ? AND revoked_at IS NULL ${exceptSessionId ? 'AND id != ?' : ''}`,
    )
    .run(now, reason, userId, ...(exceptSessionId ? [exceptSessionId] : []));
  db().prepare(
    `UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL ${exceptSessionId ? 'AND session_id != ?' : ''}`,
  ).run(now, userId, ...(exceptSessionId ? [exceptSessionId] : []));
  return sessions.changes;
}

function revokeFamily(family: string, reason: string): void {
  const now = nowMs();
  const rows = db().prepare('SELECT DISTINCT session_id FROM refresh_tokens WHERE family = ?').all(family) as {
    session_id: string;
  }[];
  for (const r of rows) revokeSession(r.session_id, reason);
  db().prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(now, family);
}

export function sessionIsLive(sessionId: string): boolean {
  const row = db()
    .prepare('SELECT revoked_at, expires_at FROM sessions WHERE id = ?')
    .get(sessionId) as { revoked_at: number | null; expires_at: number } | undefined;
  if (!row) return false;
  return !row.revoked_at && row.expires_at > nowMs();
}

export function listSessions(userId: string, currentSessionId?: string): Session[] {
  const rows = db()
    .prepare(
      `SELECT s.*, d.platform, d.app_version, d.os_version, d.model, d.id AS did
         FROM sessions s LEFT JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
        WHERE s.user_id = ?
        ORDER BY s.last_active_at DESC LIMIT 100`,
    )
    .all(userId) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    userId: String(r.user_id),
    device: {
      deviceId: String(r.did ?? r.device_id ?? ''),
      platform: (r.platform as Platform) ?? 'unknown',
      appVersion: String(r.app_version ?? ''),
      osVersion: (r.os_version as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      pushToken: null,
      pushProvider: 'none',
    },
    ipHash: String(r.ip_hash ?? ''),
    country: (r.country as string | null) ?? null,
    createdAt: Number(r.created_at),
    lastActiveAt: Number(r.last_active_at),
    expiresAt: Number(r.expires_at),
    revokedAt: (r.revoked_at as number | null) ?? null,
    current: String(r.id) === currentSessionId,
  }));
}

/** Short-lived, single-purpose token used for WebSocket handshakes. */
export function issueRealtimeTicket(userId: string, sessionId: string, deviceId: string): string {
  return jwt.sign({ sub: userId, sid: sessionId, did: deviceId, scope: 'realtime' }, config.secrets.jwtSecret, {
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
    expiresIn: 60,
    algorithm: 'HS256',
  });
}

export function verifyRealtimeTicket(ticket: string): { userId: string; sessionId: string; deviceId: string } {
  const decoded = jwt.verify(ticket, config.secrets.jwtSecret, {
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
    algorithms: ['HS256'],
  }) as { sub: string; sid: string; did: string; scope: string };
  if (decoded.scope !== 'realtime') throw err.unauthorized('That ticket is not valid for realtime connections');
  if (!sessionIsLive(decoded.sid)) throw err.unauthorized('That session has been signed out');
  return { userId: decoded.sub, sessionId: decoded.sid, deviceId: decoded.did };
}
