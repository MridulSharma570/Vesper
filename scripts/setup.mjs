#!/usr/bin/env node
/**
 * Vesper one-time workspace setup.
 *
 * Installs every workspace's dependencies (server, client, desktop) from the
 * monorepo root using npm workspaces, then prints the exact next commands.
 * Safe to re-run; npm install is idempotent.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  console.error(`Vesper needs Node >= 20.11 (found ${process.versions.node}).`);
  process.exit(1);
}

console.log('[setup] installing workspace dependencies (this can take a minute)...');
const res = spawnSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell });
if (res.status !== 0) {
  console.error('[setup] npm install failed.');
  process.exit(res.status ?? 1);
}

console.log(`
[setup] done. Next:
  npm run dev        API (http://localhost:8787) + web dev server (http://localhost:5173)
  npm start          API only, serving the built web client from client/dist
  npm run dist:all   build everything, then package native shells if scaffolded
  npm test           server unit + e2e suites
`);
