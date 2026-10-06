#!/usr/bin/env node
/**
 * Vesper dev runner: API + web dev server together.
 *
 * The API (Fastify, :8787) also serves client/dist same-origin when a build
 * exists, but in dev the Vite server (:5173) proxies /api and /realtime to it,
 * giving HMR plus a same-origin browser surface (no CORS, no localhost calls
 * from the preview iframe).
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';
const procs = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 300);
}

function launch(name, cmd, args, cwd) {
  const p = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell,
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  p.on('exit', (code) => {
    console.log(`[dev] ${name} exited with code ${code}`);
    shutdown(code ?? 0);
  });
  procs.push(p);
  return p;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

launch('api', 'npx', ['tsx', 'watch', 'src/index.ts'], join(root, 'server'));
launch('web', 'npx', ['vite'], join(root, 'client'));

console.log('[dev] API  -> http://localhost:8787');
console.log('[dev] web  -> http://localhost:5173 (proxies /api and /realtime)');
console.log('[dev] Ctrl-C stops both.');
