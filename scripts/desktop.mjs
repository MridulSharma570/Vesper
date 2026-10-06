#!/usr/bin/env node
/**
 * Windows (Electron) shell bridge: `npm run windows`.
 *
 * Builds the web client, then builds/packages the Electron app in desktop/.
 * If the Electron shell is not scaffolded in this checkout yet, we print the
 * exact scaffolding commands instead of pretending it worked.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(root, 'desktop');
const shell = process.platform === 'win32';

const scaffolded = existsSync(join(desktopDir, 'package.json'))
  && existsSync(join(desktopDir, 'electron', 'main.ts'));

if (!scaffolded) {
  console.error(`The Electron (Windows) shell is not scaffolded in this checkout yet. To add it:
  cd desktop
  npm i -D electron electron-builder tsx
  # electron/main.ts loads ../client/dist/index.html via file:// with a
  # session-wide CSP and routes API calls to the packaged/local server.
then re-run: npm run windows
Packaging (NSIS installer + appx) is configured in desktop/electron-builder.yml
and documented in docs/PLATFORMS.md.`);
  process.exit(1);
}

const buildWeb = spawnSync('npm', ['run', 'build', '--workspace', 'client'], { cwd: root, stdio: 'inherit', shell });
if (buildWeb.status !== 0) process.exit(buildWeb.status ?? 1);

const buildDesktop = spawnSync('npm', ['run', 'dist'], { cwd: desktopDir, stdio: 'inherit', shell });
if (buildDesktop.status !== 0) process.exit(buildDesktop.status ?? 1);

console.log('\n[desktop] installer written to desktop/release/ (see docs/PLATFORMS.md for signing).');
