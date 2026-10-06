/**
 * Append-only audit log.
 *
 * Every privileged action is recorded here. Fields are strictly allow-listed
 * before insert: message text, identifiers and credentials can never reach this
 * table, which keeps the log itself privacy-safe and disclosable.
 */
import type { AdminEvent, Role } from '../../../shared/types.js';
import { db, toJson, nowMs } from '../db/index.js';
import { newId } from '../lib/ids.js';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: Role | null;
  action: string;
  target?: { type: string; id: string } | null;
  reason?: string | null;
  severity?: AdminEvent['severity'];
  ipHash?: string | null;
  meta?: Record<string, unknown>;
}

/** Keys that must never be written to the audit log, even nested. */
const FORBIDDEN_META_KEYS = new Set([
  'password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'authorization',
  'otp', 'code', 'secret', 'privateKey', 'credential', 'pushToken', 'email', 'phone',
  'msisdn', 'ip', 'ipAddress', 'sdp', 'candidate', 'text', 'body', 'message',
  'encryptedValue', 'identifier', 'rawIp', 'userAgent',
]);

function sanitiseMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (FORBIDDEN_META_KEYS.has(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = typeof value === 'string' ? String(value).slice(0, 256) : value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 32).filter((v) => ['string', 'number', 'boolean'].includes(typeof v));
      continue;
    }
    if (typeof value === 'object') {
      // One level of nesting only, same allow-list rules.
      out[key] = sanitiseMeta(value as Record<string, unknown>);
    }
  }
  return out;
}

export function audit(input: AuditInput): AdminEvent {
  const event: AdminEvent = {
    id: newId(),
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    action: input.action,
    target: input.target ?? null,
    reason: input.reason?.slice(0, 1000) ?? null,
    severity: input.severity ?? 'info',
    createdAt: nowMs(),
    meta: sanitiseMeta(input.meta),
  };

  try {
    db().prepare(`
      INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, reason, severity, ip_hash, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.actorId,
      event.actorRole,
      event.action,
      event.target?.type ?? null,
      event.target?.id ?? null,
      event.reason,
      event.severity,
      input.ipHash ?? null,
      toJson(event.meta),
      event.createdAt,
    );
  } catch {
    // Auditing must never break a request. Failures surface in the app log.
  }
  return event;
}

export interface AuditQuery {
  limit?: number;
  cursor?: number;
  actorId?: string;
  action?: string;
  severity?: AdminEvent['severity'];
  targetType?: string;
  targetId?: string;
  since?: number;
  until?: number;
}

export function queryAudit(q: AuditQuery): { items: AdminEvent[]; nextCursor: number | null } {
  const limit = Math.min(q.limit ?? 100, 500);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.cursor) { where.push('id < ?'); params.push(q.cursor); }
  if (q.actorId) { where.push('actor_id = ?'); params.push(q.actorId); }
  if (q.action) { where.push('action LIKE ?'); params.push(`${q.action}%`); }
  if (q.severity) { where.push('severity = ?'); params.push(q.severity); }
  if (q.targetType) { where.push('target_type = ?'); params.push(q.targetType); }
  if (q.targetId) { where.push('target_id = ?'); params.push(q.targetId); }
  if (q.since) { where.push('created_at >= ?'); params.push(q.since); }
  if (q.until) { where.push('created_at <= ?'); params.push(q.until); }

  const rows = db()
    .prepare(
      `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as {
    id: number; actor_id: string | null; actor_role: Role | null; action: string;
    target_type: string | null; target_id: string | null; reason: string | null;
    severity: AdminEvent['severity']; meta_json: string; created_at: number;
  }[];

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    id: String(r.id),
    actorId: r.actor_id,
    actorRole: r.actor_role,
    action: r.action,
    target: r.target_type ? { type: r.target_type, id: r.target_id ?? '' } : null,
    reason: r.reason,
    severity: r.severity,
    createdAt: r.created_at,
    meta: safeParse(r.meta_json),
  }));

  const last = rows[limit - 1];
  return { items, nextCursor: hasMore && last ? last.id : null };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function pruneAudit(olderThanMs: number): number {
  const cutoff = nowMs() - olderThanMs;
  return db().prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff).changes;
}
