#!/usr/bin/env node
/**
 * Capacitor bridge for Android/iOS shells: `npm run android` / `npm run ios`.
 *
 * Builds the web client first (that is what gets wrapped), then syncs the
 * native project. If Capacitor has not been added to this checkout yet, we
 * print the exact scaffolding commands instead of pretending it worked.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(root, 'client');
const shell = process.platform === 'win32';
const platform = process.argv[2];

if (platform !== 'android' && platform !== 'ios') {
  console.error('usage: node scripts/mobile.mjs <android|ios>');
  process.exit(2);
}

const hasCapConfig = ['capacitor.config.ts', 'capacitor.config.json']
  .some((f) => existsSync(join(clientDir, f)));
const hasCapCli = existsSync(join(root, 'node_modules', '@capacitor', 'cli'))
  || existsSync(join(clientDir, 'node_modules', '@capacitor', 'cli'));

if (!hasCapConfig || !hasCapCli) {
  console.error(`Capacitor is not scaffolded in this checkout yet. To add the ${platform} shell:
  cd client
  npm i -D @capacitor/cli && npm i @capacitor/core @capacitor/${platform}
  npx cap init Vesper app.vesper.anonymous --web-dir=dist
  npx cap add ${platform}
then re-run: npm run ${platform === 'android' ? 'android' : 'ios'}
The web app itself needs no changes: it uses relative URLs and Capacitor
serves it from the native asset bundle, same-origin.`);
  process.exit(1);
}

const build = spawnSync('npm', ['run', 'build', '--workspace', 'client'], { cwd: root, stdio: 'inherit', shell });
if (build.status !== 0) process.exit(build.status ?? 1);

const sync = spawnSync('npx', ['cap', 'sync', platform], { cwd: clientDir, stdio: 'inherit', shell });
if (sync.status !== 0) process.exit(sync.status ?? 1);

console.log(`\n[mobile] ${platform} project synced. Open the IDE with: cd client && npx cap open ${platform}`);
console.log('[mobile] Release signing/keystore steps are documented in docs/PLATFORMS.md.');
