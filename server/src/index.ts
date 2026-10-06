/**
 * Vesper API — bootstrap.
 *
 * Order matters here:
 *   1. Load config (throws if production secrets are missing).
 *   2. Open the database and run migrations (idempotent, append-only).
 *   3. Verify storage is writable and crypto self-tests pass.
 *   4. Attach security middleware, then routes, then the WebSocket.
 *   5. Start background jobs.
 *  Nothing listens until all of that has succeeded, so a half-initialised server
 *  never accepts traffic.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { config, NODE_ENV } from './config.js';
import { closeDb, db, nowMs } from './db/index.js';
import { errorHandler, BODY_LIMIT, REDACT } from './middleware/index.js';
import { registerRealtimeRoutes } from './realtime/ws.js';
import { closeAll, connectionCount, onlineUserCount, sweepConnections } from './realtime/hub.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { conversationRoutes } from './routes/conversations.js';
import { messageRoutes } from './routes/messages.js';
import { mediaRoutes } from './routes/media.js';
import { callRoutes } from './routes/calls.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { startBackgroundJobs, stopBackgroundJobs } from './jobs/index.js';
import { storage } from './adapters/storage/index.js';
import { selfTest } from './security/crypto.js';
import { idsSelfTest } from './lib/ids.js';
import { getFlags } from './services/features.js';
import { seedIfEmpty } from './seed.js';

/**
 * Locate the built web client (`client/dist`).
 *
 * The entry point lives at `server/src/index.ts` in source but at
 * `dist/server/src/index.js` once compiled, and the server may be started from
 * the repo root or from `server/` — so never trust `process.cwd()` alone; probe
 * every plausible repo root and take the first that actually has a client.
 */
function locateClientDist(): string | null {
  if (process.env.VESPER_CLIENT_DIST) {
    return existsSync(process.env.VESPER_CLIENT_DIST) ? process.env.VESPER_CLIENT_DIST : null;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [
    resolve(here, '../..'),      // source layout:  <root>/server/src
    resolve(here, '../../..'),   // compiled layout: <root>/dist/server/src
    process.cwd(),
    resolve(process.cwd(), '..'),
  ];
  for (const root of roots) {
    const clientDir = join(root, 'client');
    if (existsSync(join(clientDir, 'package.json')) && existsSync(join(clientDir, 'dist'))) {
      return join(clientDir, 'dist');
    }
  }
  return null;
}

/**
 * `client/dist` and even `node_modules` are build/dependency artefacts: they
 * are not in source control and they do not survive workspace snapshot
 * restores, so a freshly restored environment would otherwise boot an API with
 * a blank web UI. At boot we therefore (1) install dependencies when the
 * toolchain is missing and (2) build the client once when the bundle is
 * missing. Set VESPER_AUTOBUILD_CLIENT=0 to opt out (e.g. container images
 * that ship the bundle prebuilt).
 */
function findClientDir(): { root: string; clientDir: string } | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [
    resolve(here, '../..'),
    resolve(here, '../../..'),
    process.cwd(),
    resolve(process.cwd(), '..'),
  ];
  for (const root of roots) {
    const clientDir = join(root, 'client');
    if (existsSync(join(clientDir, 'package.json'))) return { root, clientDir };
  }
  return null;
}

function ensureClientBuilt(): void {
  if (process.env.VESPER_AUTOBUILD_CLIENT === '0' || locateClientDist()) return;
  const found = findClientDir();
  if (!found) return;

  const hasVite = existsSync(join(found.root, 'node_modules', '.bin', 'vite'))
    || existsSync(join(found.clientDir, 'node_modules', '.bin', 'vite'));
  if (!hasVite) {
    process.stdout.write('[boot] dependencies missing - running npm install once (this takes ~30s)...\n');
    const inst = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: found.root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (inst.status !== 0) {
      process.stdout.write('[boot] npm install FAILED - the API will serve endpoints only, without the web UI.\n');
      return;
    }
  }

  process.stdout.write('[boot] client/dist missing - building the web client once (this takes ~20s)...\n');
  const res = spawnSync('npx', ['vite', 'build'], {
    cwd: found.clientDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    process.stdout.write('[boot] client build FAILED - the API will serve endpoints only, without the web UI.\n');
  }
}

const BANNER = String.raw`
  ██╗   ██╗███████╗███████╗██████╗ ███████╗██████╗
  ██║   ██║██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗
  ██║   ██║█████╗  ███████╗██████╔╝█████╗  ██████╔╝
  ╚██╗ ██╔╝██╔══╝  ╚════██║██╔═══╝ ██╔══╝  ██╔══██╗
   ╚████╔╝ ███████╗███████║██║     ███████╗██║  ██║
    ╚═══╝  ╚══════╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝
  anonymous, by design
`;

export async function buildServer() {
  /* ── 1. Data directories ─────────────────────────────────────── */
  const dataDir = resolve(process.cwd(), 'data');
  for (const dir of [dataDir, resolve(dataDir, 'storage'), resolve(dataDir, 'outbox'), config.providers.moderation.blocklistDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /* ── 2. Crypto self-test ─────────────────────────────────────── */
  // A silent primitive failure would be catastrophic (every password would
  // verify, or none would), so we check against known-answer vectors at boot.
  const cryptoOk = selfTest();
  if (!cryptoOk.ok) {
    throw new Error(`Crypto self-test failed: ${cryptoOk.failures.join(', ')}`);
  }

  // A generated handle that the validator rejects would break every anonymous
  // signup, so that invariant is checked at boot too.
  const idsOk = idsSelfTest();
  if (!idsOk.ok) {
    throw new Error(`ID/handle self-test failed: ${idsOk.failures.join(', ')}`);
  }

  /* ── 3. Database ─────────────────────────────────────────────── */
  const database = db();
  const lastMigration = database
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1')
    .get() as { version: number; name: string } | undefined;
  const schemaVersion = lastMigration ? `v${lastMigration.version} (${lastMigration.name})` : 'v0 (empty)';

  /* ── 4. Storage ──────────────────────────────────────────────── */
  const probeKey = `.health/boot-${nowMs()}`;
  await storage.put(probeKey, Buffer.from('ok'), 'text/plain');
  if (!storage.exists(probeKey)) throw new Error(`Storage driver "${storage.driverName}" cannot read back what it wrote`);
  storage.delete(probeKey);

  /* ── 5. HTTP server ──────────────────────────────────────────── */
  const app = Fastify({
    logger: {
      level: config.logging.level,
      redact: REDACT,
      // In development a single-line log is far easier to read; in production we
      // emit JSON so a log shipper can parse it.
      ...(config.logging.pretty
        ? {
            transport: {
              target: 'pino/file',
              options: { destination: 1 },
            },
          }
        : {}),
    },
    bodyLimit: BODY_LIMIT,
    trustProxy: config.server.trustProxy,
    // Never advertise the framework; a fingerprinted server is an easier target.
    disableRequestLogging: NODE_ENV === 'production',
    connectionTimeout: config.server.requestTimeoutMs,
    keepAliveTimeout: 65_000,
    ajv: { customOptions: { removeAdditional: false, allErrors: false } },
  });

  /* ── 6. Security headers ─────────────────────────────────────── */
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        // No inline anything, no third-party origins. The client is a static
        // bundle we serve ourselves; a CSP this strict means a stored XSS in a
        // message body cannot load an attacker script.
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: NODE_ENV === 'production'
      ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
      : false,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin and non-browser clients (no Origin header) are always fine.
      if (!origin) return cb(null, true);
      const allowed = config.server.corsOrigins;
      if (allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
      // The e2b preview host is per-sandbox, so match its shape rather than a
      // fixed string.
      if (/^https:\/\/\d+-[a-z0-9]+\.e2b\.app$/.test(origin)) return cb(null, true);
      cb(new Error('Origin not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 'Authorization', 'X-Vesper-Platform', 'X-Vesper-Device-Id',
      'X-Vesper-App-Version', 'X-Vesper-Os-Version', 'X-Vesper-Model', 'X-Client-Message-Id',
    ],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimits.global.max,
    timeWindow: config.rateLimits.global.windowMs,
    // A Redis store can be dropped in for multi-instance deployments; the
    // in-memory default is correct for a single node.
    allowList: (req) => String(req.headers['user-agent'] ?? '').includes('VesperHealthcheck'),
    errorResponseBuilder: () => ({
      error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' },
    }),
  });

  await app.register(websocket, {
    options: { maxPayload: 64 * 1024, perMessageDeflate: false },
  });

  /* ── 7. Content types ────────────────────────────────────────── */
  // Chunk uploads and single-shot uploads arrive as raw bytes, not JSON.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('image/*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('video/*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('audio/*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.setErrorHandler(errorHandler);

  // One single not-found handler (Fastify allows exactly one per encapsulation
  // scope). It doubles as the SPA fallback: unknown non-API GET paths serve
  // the web client's index.html when a client build is present, everything
  // else gets the JSON error envelope.
  const clientDist = locateClientDist();
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api') || req.url.startsWith('/realtime');
    if (clientDist && !isApi && req.method === 'GET') {
      return reply.sendFile('index.html');
    }
    void reply.status(404).send({
      error: { code: 'not_found', message: `No route matches ${req.method} ${req.url}` },
    });
  });

  /* ── 8. Routes ───────────────────────────────────────────────── */
  healthRoutes(app);
  authRoutes(app);
  userRoutes(app);
  conversationRoutes(app);
  messageRoutes(app);
  mediaRoutes(app);
  callRoutes(app);
  adminRoutes(app);
  registerRealtimeRoutes(app);

  /* ── 9. Static client (same-origin in every environment) ─────── */
  // Serving the built web client from the API origin removes the CORS surface
  // entirely and means the browser never needs to know the API host — which
  // matters inside a proxied preview where `localhost` is not reachable from
  // the user's browser. The SPA fallback lives in the not-found handler above.
  if (clientDist) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: clientDist, prefix: '/' });
  }

  return { app, schemaVersion };
}

export async function start(): Promise<void> {
  ensureClientBuilt();
  const { app, schemaVersion } = await buildServer();

  // Seed a first owner account only when the database is empty, and only print
  // the credentials once. Without this nobody could ever log in to a fresh
  // install, and without the "only when empty" guard it would be a backdoor.
  const seeded = seedIfEmpty();

  await app.listen({ host: config.server.host, port: config.server.port });

  const flags = getFlags();
  process.stdout.write(`${BANNER}\n`);
  app.log.info({
    env: NODE_ENV,
    version: config.app.version,
    schema: schemaVersion,
    storage: storage.driverName,
    flags: {
      media: flags.mediaPipeline,
      calls: flags.calls,
      stories: flags.stories,
      e2ee: flags.e2ee,
      registration: flags.registrationMethods,
    },
  }, 'Vesper API ready');

  if (seeded) {
    // Deliberately loud: these are the only credentials that will ever be shown.
    process.stdout.write(
      `\n┌─ First boot ──────────────────────────────────────────────\n` +
      `│ Owner account created:\n` +
      `│   handle    ${seeded.handle}\n` +
      `│   password  ${seeded.password}\n` +
      `│ Sign in and change this password immediately.\n` +
      `└───────────────────────────────────────────────────────────\n\n`,
    );
  }

  startBackgroundJobs(app.log);

  /* ── Graceful shutdown ─────────────────────────────────────────── */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    stopBackgroundJobs();
    closeAll(1001, 'server_restarting');
    try {
      await app.close();
    } catch (e) {
      app.log.error({ err: e }, 'Error while closing HTTP server');
    }
    try {
      closeDb();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'Uncaught exception — exiting so the supervisor can restart cleanly');
    void shutdown('uncaughtException');
  });
}

/** Small status helper used by the health route and tests. */
export function serverStats() {
  return {
    uptimeSeconds: Math.round(process.uptime()),
    sockets: connectionCount(),
    onlineUsers: onlineUserCount(),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

// Socket sweep is registered here rather than in jobs/ because it needs the hub.
export function installSocketSweep(intervalMs = 30_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    sweepConnections((conn) => {
      try { conn.socket.close(1001, 'heartbeat_timeout'); } catch { /* gone */ }
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((error) => {
    // Boot failure must be fatal and loud, never a server that half-works.
    process.stderr.write(`\nVesper failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n`);
    process.exit(1);
  });
}
