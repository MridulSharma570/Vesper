/**
 * Baseline suite for the 2026-10-06 change batch.
 *
 * Written BEFORE touching anything, per the working agreement: it pins the
 * CURRENT behaviour of every surface about to change, so we can prove the
 * suite passes today and then watch each assertion flip to its new
 * expectation in the commit that changes it.
 *
 *   area A  official admin credentials   -> login must FAIL today (no such account)
 *   area B  email/phone linking          -> endpoints do not exist today (404)
 *   area C  site surface (SEO/legal/404) -> robots/sitemap/og missing today (404)
 *   area D  conversation list paging     -> no cursor support today
 *
 * Usage: node tests/baseline-batch.mjs [baseUrl]
 */
const B = process.argv[2] ?? 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}`); };
const dev = (id) => ({ deviceId: id, platform: 'web', appVersion: '1.0.0', osVersion: null, model: null, pushToken: null, pushProvider: 'none' });

/* ── area A: the official admin account does not exist yet ── */
const login = await fetch(`${B}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'passkey', handle: 'Administrator', password: 'SuperHero1234', device: dev('baseline-a1') }),
});
ok('A1 login as Administrator is refused today (401)', login.status === 401);

/* ── area B: identifier linking endpoints do not exist yet ── */
const linkStart = await fetch(`${B}/users/me/link/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ok('B1 /users/me/link/start is 404 today', linkStart.status === 404);
const linkVerify = await fetch(`${B}/users/me/link/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ok('B2 /users/me/link/verify is 404 today', linkVerify.status === 404);

/* ── area C: site surface missing today ── */
// Today the SPA fallback swallows these: HTML 200 where machines expect
// text/plain, application/xml and image/png. That is the bug being fixed.
const robots = await fetch(`${B}/robots.txt`);
ok('C1 /robots.txt today returns HTML (wrong type)', robots.status === 200 && (robots.headers.get('content-type') ?? '').includes('text/html'));
const sitemap = await fetch(`${B}/sitemap.xml`);
ok('C2 /sitemap.xml today returns HTML (wrong type)', sitemap.status === 200 && (sitemap.headers.get('content-type') ?? '').includes('text/html'));
const og = await fetch(`${B}/og-image.png`);
ok('C3 /og-image.png today returns HTML (wrong type)', og.status === 200 && (og.headers.get('content-type') ?? '').includes('text/html'));

/* ── area D: conversation list has no cursor paging today ── */
// Sign in anonymously to get a token for authenticated reads.
const reg = await fetch(`${B}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'device_key', identityKey: `baseline-${Date.now()}`, device: dev('baseline-d1') }),
});
const regBody = await reg.json();
const tok = regBody.accessToken ?? '';
ok('D0 anonymous sign-in works today', reg.status === 201 && !!tok);
const convs = await fetch(`${B}/conversations?limit=2`, { headers: { Authorization: `Bearer ${tok}` } });
const convBody = convs.status === 200 ? await convs.json() : null;
ok('D1 /conversations returns a list today', convs.status === 200 && Array.isArray(convBody?.conversations));
ok('D2 /conversations has no nextCursor field today', convBody !== null && !('nextCursor' in convBody));

/* ── area E: password change already exists (must keep passing) ── */
const noAuth = await fetch(`${B}/users/me/password`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }) });
ok('E1 password change requires auth today (401)', noAuth.status === 401);

console.log(`\n${pass}/${pass + fail} baseline assertions passed (today's behaviour)`);
process.exit(fail ? 1 : 0);

/* ── area F: malformed bodies 500 today (zod errors unmapped) ── */
const malformed = await fetch(`${B}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'device_key', identityKey: 'baseline-f1', device: { deviceId: 'short', platform: 'web', appVersion: '1.0.0', osVersion: null, model: null, pushToken: null, pushProvider: 'none' } }),
});
ok('F1 malformed register body 500s today (should be 400)', malformed.status === 500);
