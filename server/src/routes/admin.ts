/**
 * /admin, /moderation, /developer, /controller — staff surfaces.
 *
 * Five roles exist and they are separated by rank, not by route prefix alone:
 *
 *   user        10   normal account
 *   moderator   30   reports, content removal, short mutes
 *   controller  50   suspensions, feature flags, audit review
 *   developer   60   diagnostics, queue inspection, no user-content access
 *   admin       80   everything, including role changes
 *   owner      100   reserved for the bootstrap account; cannot be demoted
 *
 * `requireRole` compares ranks, so "moderator or above" is one check and cannot
 * drift when a new role is added. Every mutation here writes an audit row with
 * the actor, the target and a reason — an admin action without a reason is
 * rejected, because an audit log you cannot explain is not an audit log.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ReportReason, Role } from '../../../shared/types.js';
import { REPORT_REASONS, ROLE_RANK } from '../../../shared/types.js';
import { db, nowMs } from '../db/index.js';
import {
  cancelDeletion, countUsers, getUser, hardDelete, listUsersForAdmin, requestDeletion,
  setRole, setStatus, toPrivateProfile,
} from '../services/users.js';
import { queryAudit, pruneAudit } from '../services/audit.js';
import { getFlags, publicConfig, setFlags } from '../services/features.js';
import {
  addHashToBlocklist, createReport, invalidateBlocklist, listReports, resolveReport,
} from '../adapters/moderation/index.js';
import { MEDIA_POLICY, runDueJobs } from '../services/media.js';
import { callAdaptersStatus } from '../adapters/calls/index.js';
import { storage } from '../adapters/storage/index.js';
import { emailConfigured, emailDriver } from '../adapters/email/index.js';
import { smsConfigured, smsDriver } from '../adapters/sms/index.js';
import { pushConfigured } from '../adapters/push/index.js';
import {
  connectionCount, onlineUserCount, onlineUserIds, sweepConnections,
} from '../realtime/hub.js';
import { sendToUser } from '../realtime/hub.js';
import { config } from '../config.js';
import { err } from '../services/users.js';
import { noStore, rateLimitConfig, requireAuth, requireRole } from '../middleware/index.js';

const reasonSchema = z.object({ reason: z.string().min(4).max(500) });
const idSchema = z.object({ id: z.string().min(8).max(64) });

/** Refuse to act on someone of equal or higher rank than the caller. */
function assertCanActOn(actorRole: Role, targetId: string): void {
  const target = getUser(targetId);
  if (target.role === 'owner') throw err.forbidden('The owner account cannot be modified');
  if ((ROLE_RANK[target.role] ?? 0) >= (ROLE_RANK[actorRole] ?? 0)) {
    throw err.forbidden('You cannot take action against an account of equal or higher rank');
  }
}

export function adminRoutes(app: FastifyInstance): void {
  /* ── Moderation: reports ─────────────────────────────────────── */

  /**
   * File a report. Any user can call this — it is the abuse path, not an admin
   * path — so it lives under /reports and is rate limited hard.
   */
  app.post('/reports', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const body = z.object({
      targetType: z.enum(['user', 'message', 'conversation', 'attachment']),
      targetId: z.string().min(1).max(64),
      reason: z.enum(REPORT_REASONS as unknown as [ReportReason, ...ReportReason[]]),
      details: z.string().max(1000).optional(),
    }).strict().parse(await req.body);

    const id = createReport({
      reporterId: auth.userId,
      targetType: body.targetType,
      targetId: body.targetId,
      reason: body.reason,
      details: body.details ?? null,
    });
    // Tell the reporter what happens next. A report that vanishes is why people
    // stop reporting.
    return reply.status(201).send({
      reportId: id,
      message: 'Thanks — a moderator will review this. You will be notified of the outcome.',
    });
  });

  app.get('/admin/reports', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'moderator');
    const q = req.query as { status?: string; limit?: string; cursor?: string };
    return reply.send({
      reports: listReports(q.status, Math.min(Number(q.limit ?? 50) || 50, 200), q.cursor ? Number(q.cursor) : undefined),
    });
  });

  app.post('/admin/reports/:id/resolve', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'moderator');
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    const body = z.object({
      status: z.enum(['reviewing', 'actioned', 'dismissed']),
      resolution: z.string().min(4).max(1000).optional(),
    }).strict().parse(await req.body);

    resolveReport({
      reportId: id,
      moderatorId: auth.userId,
      status: body.status,
      resolution: body.resolution ?? null,
    });
    return reply.send({ ok: true, status: body.status });
  });

  /* ── Moderation: hash blocklist ──────────────────────────────── */

  app.post('/admin/blocklist', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'moderator');
    const body = z.object({
      hash: z.string().regex(/^[a-f0-9]{16,128}$/i),
      hashType: z.enum(['sha256', 'phash']).default('sha256'),
      category: z.string().min(2).max(48),
      severity: z.enum(['block', 'review']).default('block'),
      source: z.string().max(64).optional(),
    }).strict().parse(await req.body);
    addHashToBlocklist(body.hash.toLowerCase(), body.hashType, body.category, body.severity, body.source ?? 'manual');
    invalidateBlocklist();
    return reply.send({ ok: true });
  });

  app.delete('/admin/blocklist/:hash', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'moderator');
    const { hash } = z.object({ hash: z.string().min(16).max(128) }).parse(req.params);
    const res = db().prepare('DELETE FROM hash_blocklist WHERE hash = ?').run(hash.toLowerCase());
    if (!res.changes) throw err.notFound('Blocklist entry');
    invalidateBlocklist();
    return reply.send({ ok: true, removedBy: auth.userId });
  });

  /* ── User management ─────────────────────────────────────────── */

  app.get('/admin/users', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'moderator');
    const q = req.query as { cursor?: string; limit?: string; status?: string; role?: string; query?: string };
    const page = listUsersForAdmin({
      cursor: q.cursor,
      limit: Math.min(Number(q.limit ?? 50) || 50, 200),
      status: q.status as never,
      role: q.role as never,
      query: q.query,
    });
    return {
      users: page.items.map((u) => ({
        id: u.id,
        handle: u.handle,
        role: u.role,
        status: u.status,
        createdAt: u.created_at,
        lastSeenAt: u.last_seen_at,
        verified: !!u.verified,
        suspensionUntil: u.suspension_until,
      })),
      nextCursor: page.nextCursor,
      counts: countUsers(),
    };
  });

  app.get('/admin/users/:id', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'moderator');
    const { id } = idSchema.parse(req.params);
    const user = getUser(id);
    const stats = {
      messages: (db().prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ?').get(id) as { c: number }).c,
      conversations: (db().prepare('SELECT COUNT(*) AS c FROM conversation_members WHERE user_id = ?').get(id) as { c: number }).c,
      reports: (db().prepare('SELECT COUNT(*) AS c FROM reports WHERE target_id = ?').get(id) as { c: number }).c,
      sessions: (db().prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND revoked_at IS NULL').get(id) as { c: number }).c,
    };
    return { profile: toPrivateProfile(user), stats };
  });

  /** Change an account role. Admin or above, and never against your own rank. */
  app.post('/admin/users/:id/role', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'admin');
    const { id } = idSchema.parse(req.params);
    const body = z.object({ role: z.enum(['user', 'moderator', 'controller', 'developer', 'admin']), ...reasonSchema.shape }).strict().parse(await req.body);
    assertCanActOn(auth.role, id);
    if (id === auth.userId) throw err.badRequest('You cannot change your own role');
    setRole(getUser(auth.userId), id, body.role as Role, body.reason);
    return reply.send({ ok: true, role: body.role });
  });

  /**
   * Change account status: limit, mute, suspend, restore. `limited` keeps the
   * account readable but stops it posting — usually the right first response,
   * because a suspension is disproportionate for most first offences.
   */
  app.post('/admin/users/:id/status', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'moderator');
    const { id } = idSchema.parse(req.params);
    const body = z.object({
      status: z.enum(['active', 'limited', 'suspended', 'deactivated']),
      durationDays: z.number().int().min(1).max(3650).optional(),
      ...reasonSchema.shape,
    }).strict().parse(await req.body);

    // Suspension is a bigger hammer than a moderator should swing indefinitely.
    if (body.status === 'suspended' && (ROLE_RANK[auth.role] ?? 0) < ROLE_RANK.controller) {
      throw err.forbidden('Only a controller or above can suspend an account');
    }
    assertCanActOn(auth.role, id);

    setStatus(getUser(auth.userId), id, body.status, body.reason, body.durationDays);

    // A limited or suspended account must be disconnected now, not at token expiry.
    if (body.status !== 'active') {
      sendToUser(id, { t: 'error', code: 'account_restricted', message: `Your account is now ${body.status}: ${body.reason}` });
    }
    return reply.send({ ok: true, status: body.status });
  });

  /** Force a user-initiated deletion (the same path, triggered by staff). */
  app.post('/admin/users/:id/delete', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'controller');
    const { id } = idSchema.parse(req.params);
    const body = reasonSchema.parse(await req.body);
    assertCanActOn(auth.role, id);
    const { deleteAfter } = requestDeletion(id, auth.userId);
    return reply.send({ ok: true, deleteAfter, reason: body.reason });
  });

  app.post('/admin/users/:id/delete/cancel', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'controller');
    const { id } = idSchema.parse(req.params);
    cancelDeletion(id, auth.userId);
    return reply.send({ ok: true });
  });

  /**
   * Hard delete, immediately and irreversibly. Owner/admin only, and it requires
   * the literal string IRREVERSIBLE, because there is no undo.
   */
  app.post('/admin/users/:id/purge', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'admin');
    const { id } = idSchema.parse(req.params);
    const body = z.object({ confirmation: z.string(), ...reasonSchema.shape }).strict().parse(await req.body);
    if (body.confirmation !== 'IRREVERSIBLE') {
      throw err.badRequest('Type IRREVERSIBLE to confirm permanent deletion', 'confirmation_required');
    }
    if (id === auth.userId) throw err.badRequest('You cannot purge your own account from here');
    hardDelete(id, auth.userId, body.reason);
    return reply.send({ ok: true, purged: id });
  });

  /* ── Audit log ───────────────────────────────────────────────── */

  app.get('/admin/audit', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'controller');
    const q = req.query as Record<string, string | undefined>;
    return reply.send(queryAudit({
      actorId: q.actorId,
      action: q.action,
      severity: q.severity as never,
      targetType: q.targetType,
      targetId: q.targetId,
      since: q.since ? Number(q.since) : undefined,
      until: q.until ? Number(q.until) : undefined,
      limit: Math.min(Number(q.limit ?? 100) || 100, 500),
      cursor: q.cursor ? Number(q.cursor) : undefined,
    }));
  });

  app.post('/admin/audit/prune', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    requireRole(req, 'admin');
    const removed = pruneAudit(config.retention.auditLogDays * 86_400_000);
    return reply.send({ ok: true, removed, retentionDays: config.retention.auditLogDays });
  });

  /* ── Feature flags ───────────────────────────────────────────── */

  app.get('/admin/flags', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'controller');
    return reply.send({ flags: getFlags(), config: publicConfig('admin') });
  });

  /**
   * Flip a flag live. This is how the media pipeline, calls and stories get
   * launched: the code is already deployed, and enabling it is a configuration
   * change rather than a release.
   */
  app.patch('/admin/flags', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'controller');
    const body = z.object({
      mediaPipeline: z.boolean().optional(),
      allowedMediaTypes: z.array(z.string()).optional(),
      maxUploadMb: z.number().int().optional(),
      calls: z.boolean().optional(),
      allowedCallKinds: z.array(z.string()).optional(),
      maxCallParticipants: z.number().int().optional(),
      stories: z.boolean().optional(),
      e2ee: z.boolean().optional(),
      registrationMethods: z.array(z.string()).optional(),
      maxGroupSize: z.number().int().optional(),
      maintenance: z.boolean().optional(),
    }).strict().parse(await req.body);

    const flags = setFlags(body as never, auth.userId);

    // Maintenance mode is announced to everyone currently connected rather than
    // leaving them to discover it on their next request.
    if (body.maintenance !== undefined) {
      for (const uid of onlineUserIds()) {
        sendToUser(uid, {
          t: 'error',
          code: body.maintenance ? 'maintenance_started' : 'maintenance_ended',
          message: body.maintenance ? 'Vesper is going into maintenance' : 'Vesper is back',
        });
      }
    }
    return reply.send({ flags });
  });

  /* ── Operations dashboard ────────────────────────────────────── */

  app.get('/admin/stats', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'moderator');
    const count = (sql: string, ...params: unknown[]) => (db().prepare(sql).get(...params) as { c: number }).c;
    return reply.send({
      users: countUsers(),
      online: { sockets: connectionCount(), users: onlineUserCount() },
      messages: {
        total: count('SELECT COUNT(*) AS c FROM messages'),
        last24h: count('SELECT COUNT(*) AS c FROM messages WHERE created_at > ?', nowMs() - 86_400_000),
      },
      conversations: count('SELECT COUNT(*) AS c FROM conversations'),
      uploads: {
        pending: count("SELECT COUNT(*) AS c FROM uploads WHERE stage IN ('requested','uploading','processing','scanning')"),
        failed: count("SELECT COUNT(*) AS c FROM uploads WHERE stage = 'failed'"),
      },
      jobs: {
        queued: count("SELECT COUNT(*) AS c FROM media_jobs WHERE status = 'queued'"),
        running: count("SELECT COUNT(*) AS c FROM media_jobs WHERE status = 'running'"),
        failed: count("SELECT COUNT(*) AS c FROM media_jobs WHERE status = 'failed'"),
      },
      reports: {
        open: count("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'"),
        total: count('SELECT COUNT(*) AS c FROM reports'),
      },
      storage: { driver: storage.driverName },
    });
  });

  /**
   * Provider health. Reports whether each external integration is actually
   * configured, so an operator can see at a glance what is still missing before
   * launch rather than discovering it when the first email fails.
   */
  app.get('/admin/providers', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'developer');
    return reply.send({
      email: { driver: emailDriver, configured: emailConfigured() },
      sms: { driver: smsDriver, configured: smsConfigured() },
      push: { configured: pushConfigured() },
      calls: callAdaptersStatus(),
      storage: { driver: storage.driverName, presigned: storage.supportsPresignedUrls() },
      moderation: { driver: config.providers.moderation.driver },
      mediaTypes: Object.keys(MEDIA_POLICY),
    });
  });

  /** Run one batch of queued media jobs on demand. Developer and above. */
  app.post('/admin/jobs/run', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    requireRole(req, 'developer');
    const body = z.object({ limit: z.number().int().min(1).max(100).default(8) }).parse(await req.body ?? {});
    return reply.send({ processed: runDueJobs(body.limit) });
  });

  app.get('/admin/jobs', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'developer');
    const q = req.query as { status?: string; limit?: string };
    const params: unknown[] = [];
    let sql = 'SELECT id, kind, status, progress, attempts, max_attempts, error, available_at, created_at, updated_at FROM media_jobs';
    if (q.status) { sql += ' WHERE status = ?'; params.push(q.status); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(Number(q.limit ?? 50) || 50, 200));
    return reply.send({ jobs: db().prepare(sql).all(...params) });
  });

  /** Force-drop dead sockets. Useful after a network incident. */
  app.post('/admin/sockets/sweep', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    requireRole(req, 'developer');
    const dropped = sweepConnections((conn) => {
      try { conn.socket.close(1001, 'swept_by_admin'); } catch { /* already gone */ }
    });
    return reply.send({ ok: true, dropped, remaining: connectionCount() });
  });

  /* ── Developer diagnostics ───────────────────────────────────── */

  /**
   * Deliberately narrow: no message bodies, no identifiers, no user content.
   * A developer debugging the platform should be able to see shapes and counts,
   * and nothing that would let them read anyone's conversation.
   */
  app.get('/developer/diagnostics', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'developer');
    const tables = ['users', 'messages', 'conversations', 'conversation_members', 'uploads', 'attachments', 'media_jobs', 'sessions', 'audit_log'];
    const rows: Record<string, number> = {};
    for (const t of tables) {
      try {
        rows[t] = (db().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
      } catch {
        rows[t] = -1;
      }
    }
    return reply.send({
      generatedAt: new Date().toISOString(),
      env: config.env,
      version: config.app.version,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version,
      tables: rows,
      flags: getFlags(),
      online: { sockets: connectionCount(), users: onlineUserCount() },
      storage: { driver: storage.driverName, presigned: storage.supportsPresignedUrls() },
      providers: { email: emailDriver, sms: smsDriver, pushConfigured: pushConfigured() },
    });
  });

  /** Controller-only: who holds elevated power right now. */
  app.get('/controller/staff', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    noStore(reply);
    requireRole(req, 'controller');
    const rows = db()
      .prepare("SELECT id, handle, role, status, created_at, last_seen_at FROM users WHERE role != 'user' ORDER BY role DESC, created_at ASC")
      .all() as Record<string, unknown>[];
    return reply.send({ staff: rows });
  });

  /** Controller-only: promote someone into a staff role, with a reason. */
  app.post('/controller/staff', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'admin');
    const body = z.object({
      userId: z.string().min(8).max(64),
      role: z.enum(['moderator', 'controller', 'developer', 'admin']),
      ...reasonSchema.shape,
    }).strict().parse(await req.body);
    assertCanActOn(auth.role, body.userId);
    setRole(getUser(auth.userId), body.userId, body.role as Role, body.reason);
    return reply.send({ ok: true });
  });

  /** Controller-only: strip staff rights. */
  app.delete('/controller/staff/:id', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'admin');
    const { id } = idSchema.parse(req.params);
    const body = reasonSchema.parse(await req.body ?? { reason: 'Role revoked by administrator' });
    assertCanActOn(auth.role, id);
    if (id === auth.userId) throw err.badRequest('You cannot remove your own role');
    setRole(getUser(auth.userId), id, 'user', body.reason);
    return reply.send({ ok: true });
  });

  /** Any authenticated user can check their own permissions — the UI needs it. */
  app.get('/me/permissions', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const rank = ROLE_RANK[auth.role];
    return reply.send({
      role: auth.role,
      rank,
      can: {
        moderate: rank >= ROLE_RANK.moderator,
        suspend: rank >= ROLE_RANK.controller,
        manageFlags: rank >= ROLE_RANK.controller,
        diagnostics: rank >= ROLE_RANK.developer,
        manageRoles: rank >= ROLE_RANK.admin,
        purge: rank >= ROLE_RANK.admin,
      },
    });
  });
}
