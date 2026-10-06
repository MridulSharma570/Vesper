/**
 * Admin / staff regression probe.
 *
 * Exercises the staff surface end to end against a running server:
 *   rank-gated login by handle, must-change-password enforcement, the
 *   password-change flow (wrong current rejected, other devices revoked,
 *   calling device kept), moderator-vs-controller gates, owner permissions.
 *
 * Usage:
 *   OWNER_PW=… WARDEN_PW=… node tests/admin-probe.mjs [baseUrl]
 * or place the passwords in probe/owner-pw.txt and probe/warden-pw.txt.
 *
 * The warden account must be in must-change state (freshly seeded) for the
 * first assertions to hold.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const B = process.argv[2] ?? 'http://127.0.0.1:8787';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Self-preparing fixture: this probe changes the moderator password as part
 * of its assertions, so it seeds a fresh warden on every run instead of
 * depending on leftover state from the previous one. */
const wardenPw = randomBytes(15).toString('base64url');
const seeded = spawnSync('npx', ['tsx', 'src/tools/seed.ts', `--handle=warden`, `--password=${wardenPw}`, '--role=moderator'], {
  cwd: resolve(root, 'server'),
  stdio: 'pipe',
  shell: process.platform === 'win32',
});
if (seeded.status !== 0) {
  console.error('could not seed the warden fixture:', seeded.stderr?.toString() || seeded.stdout?.toString());
  process.exit(1);
}

function secret(envName, filePath) {
  if (process.env[envName]) return process.env[envName];
  try { return readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}
const ownerPw = secret('OWNER_PW', '/home/user/probe/owner-pw.txt');

const dev = (id) => ({ deviceId: id, platform: 'web', appVersion: '1.0.0', osVersion: null, model: null, pushToken: null, pushProvider: 'none' });
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}`); };

async function login(handle, password, deviceId) {
  const r = await fetch(`${B}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'passkey', handle, password, device: dev(deviceId) }),
  });
  return { status: r.status, body: await r.json() };
}

/* 1. moderator login, must-change flag present */
const l1 = await login('warden', wardenPw, 'probe-w1');
ok('warden login 200', l1.status === 200);
ok('warden mustChangePassword true', l1.body.profile?.mustChangePassword === true);
ok('warden role moderator', l1.body.profile?.role === 'moderator');
const t1 = l1.body.accessToken;

// A second device signs in BEFORE the change; it must not survive it.
const lOther = await login('warden', wardenPw, 'probe-w3');
const tOther = lOther.body.accessToken;

/* 2. rank gates */
const f1 = await fetch(`${B}/admin/flags`, { headers: { Authorization: `Bearer ${t1}` } });
ok('moderator blocked from flags (403)', f1.status === 403);
const s1 = await fetch(`${B}/admin/stats`, { headers: { Authorization: `Bearer ${t1}` } });
ok('moderator can read stats', s1.status === 200);

/* 3. password change */
const newPw = 'Violet-Meadow-77!sun';
const bad = await fetch(`${B}/users/me/password`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t1}` },
  body: JSON.stringify({ currentPassword: 'wrong-password', newPassword: newPw }),
});
ok('wrong current password rejected', bad.status === 401);
const ch = await fetch(`${B}/users/me/password`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t1}` },
  body: JSON.stringify({ currentPassword: wardenPw, newPassword: newPw }),
});
ok('password change ok', ch.status === 200);

/* 4. re-login: flag cleared, sibling session revoked, caller kept */
const l2 = await login('warden', newPw, 'probe-w2');
ok('re-login with new password', l2.status === 200);
ok('mustChangePassword cleared', l2.body.profile?.mustChangePassword === false);
const meOther = await fetch(`${B}/users/me`, { headers: { Authorization: `Bearer ${tOther}` } });
ok('other device revoked after change', meOther.status === 401);
const meCur = await fetch(`${B}/users/me`, { headers: { Authorization: `Bearer ${t1}` } });
ok('changing device stays signed in', meCur.status === 200);

/* 5. owner untouched, still forced-change, full perms */
const l3 = await login('helm', ownerPw, 'probe-h1');
ok('owner login 200', l3.status === 200);
ok('owner mustChangePassword still true (forced dialog)', l3.body.profile?.mustChangePassword === true);
const perms = await (await fetch(`${B}/me/permissions`, { headers: { Authorization: `Bearer ${l3.body.accessToken}` } })).json();
ok('owner rank 100 with purge', perms.rank === 100 && perms.can?.purge === true);

/* 6. the official installed owner credential (case-insensitive handle) */
const officialPw = process.env.ADMIN_PW ?? '';
if (!officialPw) {
  console.log('- official-credential section skipped (set ADMIN_PW)');
} else {
  const l4 = await login('Administrator', officialPw, 'probe-official');
  ok('official Administrator credential signs in', l4.status === 200);
  ok('official account is owner, permanent password', l4.body.profile?.role === 'owner' && l4.body.profile?.mustChangePassword === false);
  ok('official display name preserves case', l4.body.profile?.displayName === 'Administrator');
}

console.log(`\n  ${pass}/${pass + fail} admin probes passed`);
process.exit(fail ? 1 : 0);
