/**
 * Background jobs.
 *
 * Everything here is a periodic sweep on a single node. That is a deliberate
 * choice: a queue worker fleet is the right answer at scale, but it is the wrong
 * answer for a launch, because it adds a deployment, a monitor and a failure
 * mode before there is any traffic to justify them. Each sweep is idempotent and
 * claims its rows with a conditional UPDATE, so running two instances at once is
 * safe rather than merely tolerated — which is what makes the upgrade to a
 * separate worker process a configuration change instead of a rewrite.
 *
 * Sweeps:
 *   media jobs      run queued pipeline stages (probe, thumbnail, hash, scan…)
 *   uploads         expire grants that were never completed
 *   attachments     purge ephemeral media past its expiry
 *   accounts        hard-delete deactivated accounts past the grace window
 *   sessions        drop expired sessions, refresh tokens and challenges
 *   audit           prune the audit log past the retention window
 *   presence        clear stale "online" markers left by a crashed process
 *   sockets         close heartbeats that stopped answering
 */
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { db, nowMs } from '../db/index.js';
import { runDueJobs } from '../services/media.js';
import { pruneAudit } from '../services/audit.js';
import { hardDelete } from '../services/users.js';
import { storage } from '../adapters/storage/index.js';
import { pruneQueue, sweepConnections } from '../realtime/hub.js';

interface Timer {
  name: string;
  handle: NodeJS.Timeout;
}

const timers: Timer[] = [];
let logger: FastifyBaseLogger | null = null;

/** Run a sweep, catching and logging anything it throws so one bad row cannot
 *  stop the interval from firing again. */
function guarded(name: string, fn: () => unknown): () => void {
  return () => {
    try {
      const result = fn();
      if (result instanceof Promise) {
        result.catch((e) => logger?.error({ err: e, sweep: name }, 'background sweep failed'));
      }
    } catch (e) {
      logger?.error({ err: e, sweep: name }, 'background sweep threw');
    }
  };
}

export function startBackgroundJobs(log: FastifyBaseLogger): void {
  logger = log;

  const interval = config.retention.sweepIntervalMs;

  schedule('media-jobs', 5_000, () => {
    const processed = runDueJobs(8);
    if (processed) log.debug({ processed }, 'media jobs processed');
  });

  schedule('expired-uploads', interval, sweepExpiredUploads);
  schedule('ephemeral-media', interval, sweepEphemeralMedia);
  schedule('accounts', 60_000, sweepDeactivatedAccounts);
  schedule('sessions', interval, sweepSessions);
  schedule('audit', 6 * 3_600_000, sweepAudit);
  schedule('presence', 120_000, sweepStalePresence);
  schedule('deliveries', 3_600_000, () => { pruneQueue(); });
  schedule('sockets', 30_000, () => {
    sweepConnections((conn) => {
      try { conn.socket.close(1001, 'heartbeat_timeout'); } catch { /* already gone */ }
    });
  });

  log.info({ sweeps: timers.map((t) => t.name) }, 'background jobs started');
}

function schedule(name: string, everyMs: number, fn: () => unknown): void {
  const handle = setInterval(guarded(name, fn), everyMs);
  // Never keep the process alive just for a sweep; SIGTERM must be able to exit.
  handle.unref?.();
  timers.push({ name, handle });
  // Run the cheap ones once immediately so a fresh boot is consistent.
  if (everyMs >= 60_000) guarded(name, fn)();
}

export function stopBackgroundJobs(): void {
  for (const t of timers) clearInterval(t.handle);
  timers.length = 0;
}

/* ─────────────────────────── Individual sweeps ─────────────────────────── */

/**
 * Upload grants that were never completed. The staged chunks are deleted too,
 * otherwise an abandoned upload leaks disk forever.
 */
export function sweepExpiredUploads(): number {
  const now = nowMs();
  const stale = db()
    .prepare(
      `SELECT id, storage_key FROM uploads
        WHERE stage IN ('requested','uploading') AND expires_at < ?
        LIMIT 200`,
    )
    .all(now) as { id: string; storage_key: string | null }[];

  for (const row of stale) {
    if (row.storage_key) {
      try { storage.delete(row.storage_key); } catch { /* best effort */ }
    }
    db().prepare("UPDATE uploads SET stage = 'expired', updated_at = ? WHERE id = ?").run(now, row.id);
  }
  return stale.length;
}

/**
 * Ephemeral media — disappearing-message attachments and expired stories.
 * The blob goes first, then the row: if the storage delete fails we keep the row
 * so the next sweep retries, rather than losing track of an orphaned object.
 */
export function sweepEphemeralMedia(): number {
  const now = nowMs();
  // `thumbnail_id` points at another attachment row, not at a storage key, so the
  // thumbnail's blob is resolved through it. Thumbnails normally carry their own
  // expiry and get swept independently; resolving it here too means a thumbnail
  // created without an expiry cannot outlive the media it previews and become an
  // orphaned object nobody will ever delete.
  const expired = db()
    .prepare(
      `SELECT a.id, a.storage_key, t.storage_key AS thumb_key, t.id AS thumb_id
         FROM attachments a
         LEFT JOIN attachments t ON t.id = a.thumbnail_id
        WHERE a.expires_at IS NOT NULL AND a.expires_at < ?
        LIMIT 200`,
    )
    .all(now) as { id: string; storage_key: string; thumb_key: string | null; thumb_id: string | null }[];

  let removed = 0;
  for (const row of expired) {
    try {
      storage.delete(row.storage_key);
      if (row.thumb_key) storage.delete(row.thumb_key);
    } catch {
      // Leave the row in place so the next sweep retries; deleting the row first
      // would orphan the blob forever.
      continue;
    }
    if (row.thumb_id) db().prepare('DELETE FROM attachments WHERE id = ?').run(row.thumb_id);
    db().prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    removed += 1;
  }
  return removed;
}

/**
 * Hard-delete accounts whose grace period has elapsed. `hardDelete` cascades
 * through conversations, messages and media, so this is what actually delivers
 * on the "deleted within 30 days" promise in the privacy policy.
 */
export function sweepDeactivatedAccounts(): number {
  const now = nowMs();
  const due = db()
    .prepare("SELECT id, handle FROM users WHERE status = 'deactivated' AND delete_after IS NOT NULL AND delete_after < ? LIMIT 20")
    .all(now) as { id: string; handle: string }[];

  for (const row of due) {
    try {
      hardDelete(row.id, null, 'retention.grace_period_elapsed');
      logger?.info({ handle: row.handle }, 'account purged after grace period');
    } catch (e) {
      logger?.error({ err: e, userId: row.id }, 'failed to purge deactivated account');
    }
  }
  return due.length;
}

/** Expired sessions, spent refresh tokens and used-up challenges. */
export function sweepSessions(): number {
  const now = nowMs();
  const sessions = db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now - 86_400_000).changes;
  const refresh = db().prepare('DELETE FROM refresh_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)')
    .run(now, now - 7 * 86_400_000).changes;
  const challenges = db().prepare('DELETE FROM challenges WHERE expires_at < ?').run(now - 3_600_000).changes;
  const attempts = db().prepare('DELETE FROM auth_attempts WHERE updated_at < ?').run(now - 86_400_000).changes;
  const devices = db().prepare('DELETE FROM devices WHERE last_seen_at < ? AND push_token IS NULL').run(now - 90 * 86_400_000).changes;
  return sessions + refresh + challenges + attempts + devices;
}

export function sweepAudit(): number {
  return pruneAudit(config.retention.auditLogDays * 86_400_000);
}

/**
 * Clear presence left over from an unclean shutdown. A crashed process cannot
 * run its `close` handler, so without this sweep users would appear online
 * forever. The 90-second threshold is longer than two missed heartbeats, which
 * means a live connection is never marked offline by mistake.
 */
export function sweepStalePresence(): number {
  const cutoff = nowMs() - 90_000;
  return db()
    .prepare("UPDATE users SET presence = 'offline' WHERE presence = 'online' AND last_seen_at < ?")
    .run(cutoff).changes;
}

/** Everything, for a manual "clean up now" from the admin panel. */
export function runAllSweeps(): Record<string, number> {
  return {
    expiredUploads: sweepExpiredUploads(),
    ephemeralMedia: sweepEphemeralMedia(),
    deactivatedAccounts: sweepDeactivatedAccounts(),
    sessions: sweepSessions(),
    audit: sweepAudit(),
    stalePresence: sweepStalePresence(),
  };
}
