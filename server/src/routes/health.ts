/**
 * /health — liveness, readiness and version.
 *
 * Three endpoints because they answer three different questions and a load
 * balancer must be able to ask each one separately:
 *
 *   GET /health/live   "is the process up?"      — never touches the database.
 *                                                If this fails, restart the pod.
 *   GET /health/ready  "can it serve traffic?"   — checks the database and
 *                                                storage. If this fails, take it
 *                                                out of rotation but do NOT
 *                                                restart it (a restart will not
 *                                                fix a full disk, and it will
 *                                                hide the problem).
 *   GET /health        public summary for the status page.
 *
 * `/health/ready` deliberately reports *degraded* rather than failing outright
 * when a non-essential provider (email, SMS, push) is unconfigured, because the
 * core product still works without them.
 */
import type { FastifyInstance } from 'fastify';
import { config, NODE_ENV } from '../config.js';
import { db, nowMs } from '../db/index.js';
import { storage } from '../adapters/storage/index.js';
import { emailConfigured, emailDriver } from '../adapters/email/index.js';
import { smsConfigured, smsDriver } from '../adapters/sms/index.js';
import { pushConfigured } from '../adapters/push/index.js';
import { callAdaptersStatus } from '../adapters/calls/index.js';
import { getFlags } from '../services/features.js';
import { connectionCount, onlineUserCount } from '../realtime/hub.js';
import { serverStats } from '../index.js';
import { noStore } from '../middleware/index.js';

const startedAt = nowMs();

export function healthRoutes(app: FastifyInstance): void {
  /** Liveness. Must be cheap and must not depend on anything external. */
  app.get('/health/live', async (_req, reply) => {
    noStore(reply);
    return reply.send({ status: 'ok', uptimeSeconds: Math.round((nowMs() - startedAt) / 1000) });
  });

  /** Readiness. Touches the database and storage; that is the point. */
  app.get('/health/ready', async (_req, reply) => {
    noStore(reply);
    const checks: Record<string, 'ok' | 'degraded' | 'failed'> = {};

    try {
      const row = db().prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      checks.database = row?.ok === 1 ? 'ok' : 'failed';
    } catch {
      checks.database = 'failed';
    }

    try {
      const key = `.health/ready-${nowMs()}`;
      await storage.put(key, Buffer.from('ok'), 'text/plain');
      checks.storage = storage.exists(key) ? 'ok' : 'failed';
      storage.delete(key);
    } catch {
      checks.storage = 'failed';
    }

    // Providers are advisory: an unconfigured mailer does not make the API
    // unable to serve chat, it just means verification emails cannot be sent.
    checks.email = emailConfigured() ? 'ok' : 'degraded';
    checks.sms = smsConfigured() ? 'ok' : 'degraded';
    checks.push = pushConfigured() ? 'ok' : 'degraded';

    const failed = Object.values(checks).filter((v) => v === 'failed').length > 0;
    const degraded = Object.values(checks).filter((v) => v === 'degraded').length > 0;
    const status = failed ? 'failed' : degraded ? 'degraded' : 'ok';

    return reply.status(failed ? 503 : 200).send({ status, checks });
  });

  /**
   * Public summary. Safe to expose: versions and coarse availability only, with
   * no counts, no timings and no internal component names beyond what a user
   * would already infer from using the app.
   */
  app.get('/health', async (_req, reply) => {
    noStore(reply);
    const flags = getFlags();
    let databaseOk = false;
    try {
      databaseOk = (db().prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
    } catch {
      databaseOk = false;
    }
    return reply.send({
      status: databaseOk ? (flags.maintenance ? 'maintenance' : 'ok') : 'degraded',
      app: config.app.name,
      version: config.app.version,
      maintenance: flags.maintenance,
      time: new Date().toISOString(),
    });
  });

  /**
   * Operator detail. Not mounted in production unless explicitly enabled, since
   * it discloses component and provider names that help an attacker map the
   * deployment.
   */
  if (NODE_ENV !== 'production' || config.env === 'staging') {
    app.get('/health/detail', async (_req, reply) => {
      noStore(reply);
      const flags = getFlags();
      return reply.send({
        ...serverStats(),
        env: NODE_ENV,
        node: process.version,
        startedAt: new Date(startedAt).toISOString(),
        storage: { driver: storage.driverName, presigned: storage.supportsPresignedUrls() },
        providers: {
          email: { driver: emailDriver, configured: emailConfigured() },
          sms: { driver: smsDriver, configured: smsConfigured() },
          push: { configured: pushConfigured() },
          calls: callAdaptersStatus(),
        },
        flags,
        realtime: { sockets: connectionCount(), onlineUsers: onlineUserCount() },
      });
    });
  }
}
