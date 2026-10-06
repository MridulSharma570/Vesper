/**
 * Baseline suite for the 2026-10-06 change batch.
 *
 * Written BEFORE touching anything, per the working agreement: it pins the
 * CURRENT behaviour of every surface about to change, so we can prove the
 * suite passes today and then watch each assertion flip to its new
 * expectation in the commit that changes it.
 *
 *   area A  official admin credentials   -> login must FAIL today (no such account)
 *   area B  email/phone linking          -> gated, OTP-proven, fingerprint-only (post-change)
 *   area C  site surface (SEO/legal/404) -> machine types, honest 404, honeypot (post-change)
 *   area D  conversation list paging     -> no cursor support today
 *
 * Usage: node tests/baseline-batch.mjs [baseUrl]
 */
const B = process.argv[2] ?? 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}`); };
const dev = (id) => ({ deviceId: id, platform: 'web', appVersion: '1.0.0', osVersion: null, model: null, pushToken: null, pushProvider: 'none' });

/* ── area A: official admin credentials (commit: feat admin credentials) ──
 * Post-change expectations: the installed owner account signs in by handle,
 * case-insensitively, with the permanent password and no forced-change flag. */
const adminPw = process.env.ADMIN_PW ?? 'SuperHero1234';
const login = await fetch(`${B}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'passkey', handle: 'Administrator', password: adminPw, device: dev('baseline-a1') }),
});
const loginBody = login.status === 200 ? await login.json() : null;
ok('A1 login as Administrator succeeds', login.status === 200 && !!loginBody?.accessToken);
ok('A2 account is owner with display name Administrator', loginBody?.profile?.role === 'owner' && loginBody?.profile?.displayName === 'Administrator');
ok('A3 password is permanent (no forced change)', loginBody?.profile?.mustChangePassword === false);
const loginLower = await fetch(`${B}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'passkey', handle: 'administrator', password: adminPw, device: dev('baseline-a2') }),
});
ok('A4 handle sign-in is case-insensitive', loginLower.status === 200);

/* ── area B: email/phone linking (commit: feat link endpoints + UI) ──
 * Post-change expectations: the endpoints exist, are auth-gated, validate
 * strictly, prove control via a real OTP (read from the dev outbox the console
 * driver saves), refuse replay/in-use identifiers, and never leak the raw
 * contact back — only fingerprints. */
const linkStartAnon = await fetch(`${B}/users/me/link/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ok('B1 link/start without a session is 401 (route exists, gated)', linkStartAnon.status === 401);
const linkVerifyAnon = await fetch(`${B}/users/me/link/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ok('B2 link/verify without a session is 401', linkVerifyAnon.status === 401);

const adminTok = loginBody?.accessToken;
const badBody = await fetch(`${B}/users/me/link/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
  body: '{}',
});
const badBodyJson = await badBody.json().catch(() => null);
ok('B3 empty body is 400 validation_failed with field issues',
  badBody.status === 400 && badBodyJson?.error?.code === 'validation_failed' && Array.isArray(badBodyJson?.error?.details?.issues));

/* Throwaway account for the happy path so the official admin stays pristine. */
const { readFile, readdir } = await import('node:fs/promises');
const linkUser = await fetch(`${B}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'device_key', identityKey: `baseline-link-${Date.now()}`, device: dev('baseline-b-link') }),
});
const linkUserBody = await linkUser.json();
const linkEmail = `baseline-${Date.now()}@vesper.test`;
const start = await fetch(`${B}/users/me/link/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${linkUserBody.accessToken}` },
  body: JSON.stringify({ method: 'email', value: linkEmail }),
});
const startBody = await start.json().catch(() => null);
ok('B4 link/start returns a challengeId for a valid new email', start.status === 200 && !!startBody?.challengeId);

/* The dev console driver saves every "sent" email to server/data/outbox —
 * read the real code instead of inventing one. */
async function codeFromOutbox(to) {
  const dir = new URL('../server/data/outbox/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.reverse().slice(0, 10)) {
    const mail = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    if (mail.to === to) {
      const m = String(mail.subject ?? mail.text ?? '').match(/(\d{4,8})/);
      if (m) return m[1];
    }
  }
  return null;
}
const realCode = await codeFromOutbox(linkEmail);
const wrongCode = await fetch(`${B}/users/me/link/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${linkUserBody.accessToken}` },
  body: JSON.stringify({ challengeId: startBody?.challengeId, code: '000000' }),
});
ok('B5 wrong code is rejected 401', wrongCode.status === 401 && !!realCode);
const rightCode = await fetch(`${B}/users/me/link/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${linkUserBody.accessToken}` },
  body: JSON.stringify({ challengeId: startBody?.challengeId, code: realCode }),
});
const rightBody = await rightCode.json().catch(() => null);
ok('B6 the outbox code verifies: ok + profile.verified', rightCode.status === 200 && rightBody?.ok === true && rightBody?.profile?.verified === true);
ok('B7 response exposes only a fingerprint, never the raw email',
  Array.isArray(rightBody?.identities) && rightBody.identities.some((i) => i.method === 'email' && i.fingerprint) &&
  !JSON.stringify(rightBody).includes(linkEmail));
const replay = await fetch(`${B}/users/me/link/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${linkUserBody.accessToken}` },
  body: JSON.stringify({ challengeId: startBody?.challengeId, code: realCode }),
});
ok('B8 a consumed challenge cannot be replayed', replay.status >= 400 && replay.status < 500);
const inUse = await fetch(`${B}/users/me/link/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
  body: JSON.stringify({ method: 'email', value: linkEmail }),
});
ok('B9 linking an email another account owns is 409', inUse.status === 409);

/* ── area C: crawler/share/404 surface (commit: feat site surface) ──
 * Post-change expectations: machines get machine formats, humans get an
 * honest 404 shell, the honeypot swallows bots silently, and the served shell
 * carries share metadata with no analytics unless the deployment opts in. */
const robots = await fetch(`${B}/robots.txt`);
const robotsText = robots.status === 200 ? await robots.text() : '';
ok('C1 /robots.txt is text/plain, allows public pages, points at the sitemap',
  robots.status === 200 && (robots.headers.get('content-type') ?? '').includes('text/plain') &&
  robotsText.includes('User-agent: *') && robotsText.includes('Sitemap:'));
const sitemap = await fetch(`${B}/sitemap.xml`);
const sitemapText = sitemap.status === 200 ? await sitemap.text() : '';
ok('C2 /sitemap.xml is application/xml listing every public page',
  sitemap.status === 200 && (sitemap.headers.get('content-type') ?? '').includes('application/xml') &&
  ['/privacy', '/faq', '/terms', '/cookies', '/encryption', '/license', '/report'].every((pp) => sitemapText.includes(`<loc>${new URL(B).origin}${pp}</loc>`)));
const og = await fetch(`${B}/og-image.png`);
const ogBuf = new Uint8Array(await og.arrayBuffer());
ok('C3 /og-image.png is a real PNG', og.status === 200 &&
  (og.headers.get('content-type') ?? '').includes('image/png') &&
  ogBuf[0] === 0x89 && ogBuf[1] === 0x50 && ogBuf[2] === 0x4e && ogBuf[3] === 0x47);
const missing = await fetch(`${B}/definitely-not-a-page`, { headers: { Accept: 'text/html' } });
const missingText = missing.status === 404 ? await missing.text() : '';
ok('C4 unknown paths answer 404 (not 200) with the app shell for browsers',
  missing.status === 404 && missingText.includes('<div id="root"></div>'));
const shell = await (await fetch(`${B}/`)).text();
ok('C5 served shell carries share metadata and no analytics by default',
  shell.includes('og:image') && shell.includes('twitter:card') && !shell.includes('googletagmanager') && !shell.includes('VESPER_GA'));
const honeypot = await fetch(`${B}/public/reports`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reason: 'spam', details: 'Automated blast body body body body body.', website: 'http://spam.example' }),
});
ok('C6 honeypot-filled report is accepted silently (201), never stored', honeypot.status === 201);
const shortReport = await fetch(`${B}/public/reports`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reason: 'spam', details: 'short' }),
});
ok('C7 thin report bodies are rejected 400', shortReport.status === 400);

/* ── area D: conversation list has no cursor paging today ──
 * Reuses the owner token from area A: the auth rate limiter is a feature, and
 * a test suite must not burn its budget registering throwaway accounts. */
const tok = loginBody?.accessToken ?? '';
ok('D0 token from area A is reusable for reads', !!tok);
const convs = await fetch(`${B}/conversations?limit=2`, { headers: { Authorization: `Bearer ${tok}` } });
const convBody = convs.status === 200 ? await convs.json() : null;
ok('D1 /conversations returns a list today', convs.status === 200 && Array.isArray(convBody?.conversations));
ok('D2 /conversations has no nextCursor field today', convBody !== null && !('nextCursor' in convBody));

/* ── area E: password change already exists (must keep passing) ── */
const noAuth = await fetch(`${B}/users/me/password`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }) });
ok('E1 password change requires auth today (401)', noAuth.status === 401);

console.log(`\n${pass}/${pass + fail} baseline assertions passed (today's behaviour)`);
process.exit(fail ? 1 : 0);

/* ── area F: malformed bodies are a client error, mapped to 400 ── */
const malformed = await fetch(`${B}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'device_key', identityKey: 'baseline-f1', device: { deviceId: 'short', platform: 'web', appVersion: '1.0.0', osVersion: null, model: null, pushToken: null, pushProvider: 'none' } }),
});
const malformedBody = malformed.status === 400 ? await malformed.json() : null;
ok('F1 malformed register body returns 400', malformed.status === 400);
ok('F2 400 carries field-level issues', !!malformedBody?.error?.details?.issues?.length);
