#!/usr/bin/env node
/**
 * Build every Vesper target that is scaffolded in this checkout.
 *
 * Always builds: server (tsc) and web client (vite).
 * Conditionally: Windows shell (desktop/ with Electron) and mobile shells
 * (client/ with Capacitor) — these are wired but optional; when their tooling
 * is not installed we say so plainly instead of failing the whole build.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';
let failed = false;

function run(label, cmd, args, cwd) {
  console.log(`\n[build-all] ${label}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell });
  if (r.status !== 0) {
    failed = true;
    console.error(`[build-all] ${label} FAILED`);
  }
  return r.status === 0;
}

run('server (tsc)', 'npm', ['run', 'build', '--workspace', 'server'], root);
run('web client (vite)', 'npm', ['run', 'build', '--workspace', 'client'], root);

const capConfig = ['capacitor.config.ts', 'capacitor.config.json']
  .some((f) => existsSync(join(root, 'client', f)));
if (capConfig && existsSync(join(root, 'node_modules', '@capacitor', 'cli'))) {
  run('capacitor sync (android)', 'npx', ['cap', 'sync', 'android'], join(root, 'client'));
  run('capacitor sync (ios)', 'npx', ['cap', 'sync', 'ios'], join(root, 'client'));
} else {
  console.log('\n[build-all] mobile shells not scaffolded here - skipped (see docs/PLATFORMS.md).');
}

if (existsSync(join(root, 'desktop', 'package.json')) && existsSync(join(root, 'desktop', 'electron', 'main.ts'))) {
  run('windows shell (electron)', 'npm', ['run', 'build', '--workspace', 'desktop'], root);
} else {
  console.log('[build-all] windows shell not scaffolded here - skipped (see docs/PLATFORMS.md).');
}

console.log(failed ? '\n[build-all] finished WITH ERRORS' : '\n[build-all] all scaffolded targets built.');
process.exit(failed ? 1 : 0);
