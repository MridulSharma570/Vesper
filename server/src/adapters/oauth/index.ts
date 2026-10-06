/**
 * Federated sign-in: Google and Apple.
 *
 * Two flows per provider, because the clients differ:
 *
 *  - Mobile & desktop (Android, iOS, Windows): the native SDK returns an
 *    `id_token` (a signed JWT). We verify the signature against the provider's
 *    published keys and check `aud`, `iss` and `exp` ourselves. No browser
 *    round-trip, no redirect URI to maintain per platform.
 *  - Web: standard authorization-code flow with PKCE.
 *
 * We store the provider `subject` only. The provider email is hashed with the
 * server pepper and kept solely for account-linking detection; it is never
 * shown to other users and never written to a log.
 */
import { createPublicKey, createSign, createVerify, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import { db, nowMs } from '../../db/index.js';
import { base64url, keyedHash, normaliseEmail, sha256Hex, utf8 } from '../../security/crypto.js';
import { createUser, err } from '../../services/users.js';

export interface VerifiedFederatedIdentity {
  provider: 'google' | 'apple';
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

interface Jwks {
  keys: { kty: string; kid: string; n?: string; e?: string; alg?: string; use?: string; x5c?: string[] }[];
}

const jwksCache = new Map<string, { jwks: Jwks; fetchedAt: number }>();

async function fetchJwks(url: string): Promise<Jwks> {
  const cached = jwksCache.get(url);
  if (cached && nowMs() - cached.fetchedAt < 3_600_000) return cached.jwks;
  const res = await fetch(url);
  if (!res.ok) throw err.unavailable(`Could not reach the identity provider (${res.status})`);
  const jwks = (await res.json()) as Jwks;
  jwksCache.set(url, { jwks, fetchedAt: nowMs() });
  return jwks;
}

function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signature: Buffer; signedData: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw err.badRequest('Malformed identity token', 'invalid_token');
  const [h, p, s] = parts as [string, string, string];
  try {
    return {
      header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>,
      payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>,
      signature: Buffer.from(s, 'base64url'),
      signedData: `${h}.${p}`,
    };
  } catch {
    throw err.badRequest('Malformed identity token', 'invalid_token');
  }
}

function rsaPublicKeyFromJwk(key: { n?: string; e?: string }): string {
  if (!key.n || !key.e) throw err.badRequest('Provider key is not an RSA key', 'invalid_token');
  const jwk = { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256' };
  return createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString();
}

async function verifyRs256(token: string, jwksUrl: string, expectedAud: string[], expectedIss: string[]): Promise<Record<string, unknown>> {
  const { header, payload, signature, signedData } = decodeJwt(token);
  if (header.alg !== 'RS256') throw err.badRequest('Unsupported token signature algorithm', 'invalid_token');

  const jwks = await fetchJwks(jwksUrl);
  const kid = String(header.kid ?? '');
  const key = jwks.keys.find((k) => k.kid === kid) ?? jwks.keys.find((k) => k.use === 'sig' || !k.use);
  if (!key) throw err.badRequest('Provider signing key not found', 'invalid_token');

  const verifier = createVerify('RSA-SHA256');
  verifier.update(signedData);
  const ok = verifier.verify(rsaPublicKeyFromJwk(key), signature);
  if (!ok) throw err.badRequest('Identity token signature is invalid', 'invalid_token');

  const now = Math.floor(nowMs() / 1000);
  const exp = Number(payload.exp ?? 0);
  const iat = Number(payload.iat ?? 0);
  if (!exp || exp < now - 60) throw err.badRequest('Identity token has expired', 'invalid_token');
  // Allow a small clock-skew window on issuance.
  if (iat && iat > now + 300) throw err.badRequest('Identity token issued in the future', 'invalid_token');

  const aud = Array.isArray(payload.aud) ? (payload.aud as string[]) : [String(payload.aud ?? '')];
  if (!aud.some((a) => expectedAud.includes(a))) {
    throw err.badRequest('Identity token audience does not match this app', 'invalid_token');
  }
  if (!expectedIss.includes(String(payload.iss ?? ''))) {
    throw err.badRequest('Identity token issuer is not trusted', 'invalid_token');
  }
  return payload;
}

/* ── Google ─────────────────────────────────────────────────────── */

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedFederatedIdentity> {
  if (!config.providers.oauth.google.clientId) {
    throw err.unavailable('Google sign-in is not configured on this server');
  }
  const audiences = config.providers.oauth.google.allowedAudiences.length
    ? config.providers.oauth.google.allowedAudiences
    : [config.providers.oauth.google.clientId];

  const payload = await verifyRs256(
    idToken,
    'https://www.googleapis.com/oauth2/v3/certs',
    audiences,
    ['https://accounts.google.com', 'accounts.google.com'],
  );

  const subject = String(payload.sub ?? '');
  if (!subject) throw err.badRequest('Google token has no subject', 'invalid_token');

  return {
    provider: 'google',
    subject,
    email: payload.email ? normaliseEmail(String(payload.email)) : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: payload.name ? String(payload.name).slice(0, 64) : null,
  };
}

/** Web authorization-code flow with PKCE. */
export function googleAuthorizeUrl(state: string, codeChallenge: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: config.providers.oauth.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    // Never ask for offline access: we do not want a long-lived Google refresh
    // token, and holding one would be a data-minimisation failure.
    access_type: 'online',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(code: string, codeVerifier: string, redirectUri: string): Promise<VerifiedFederatedIdentity> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.providers.oauth.google.clientId,
      client_secret: config.providers.oauth.google.clientSecret,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw err.badRequest('Google rejected the authorization code', 'oauth_failed');
  const json = (await res.json()) as { id_token?: string; error?: string };
  if (!json.id_token) throw err.badRequest('Google did not return an identity token', 'oauth_failed');
  return verifyGoogleIdToken(json.id_token);
}

/* ── Apple (Sign in with Apple) ─────────────────────────────────── */

/**
 * Apple's client_secret is itself a short-lived JWT we sign with the .p8 key.
 * Cached for 50 minutes; Apple allows up to 6 months but short is safer.
 */
let appleSecretCache: { value: string; issuedAt: number } | null = null;

export function appleClientSecret(): string {
  const { clientId, teamId, keyId, privateKey } = config.providers.oauth.apple;
  if (!clientId || !teamId || !keyId || !privateKey) {
    throw err.unavailable('Apple sign-in is not configured on this server');
  }
  if (appleSecretCache && nowMs() - appleSecretCache.issuedAt < 50 * 60_000) return appleSecretCache.value;

  const now = Math.floor(nowMs() / 1000);
  const header = base64url(utf8(JSON.stringify({ alg: 'ES256', kid: keyId })));
  const claims = base64url(utf8(JSON.stringify({
    iss: teamId,
    iat: now,
    exp: now + 3600,
    aud: 'https://appleid.apple.com',
    sub: clientId,
  })));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(privateKey).toString('base64url');
  const value = `${header}.${claims}.${signature}`;
  appleSecretCache = { value, issuedAt: nowMs() };
  return value;
}

/** Apple id_tokens are ES256, so verification uses the EC path. */
async function verifyEs256(token: string, jwksUrl: string, expectedAud: string[], expectedIss: string[]): Promise<Record<string, unknown>> {
  const { header, payload, signature, signedData } = decodeJwt(token);
  if (header.alg !== 'ES256') throw err.badRequest('Unsupported token signature algorithm', 'invalid_token');

  const jwks = await fetchJwks(jwksUrl);
  const kid = String(header.kid ?? '');
  const key = jwks.keys.find((k) => k.kid === kid) ?? jwks.keys[0];
  if (!key) throw err.badRequest('Provider signing key not found', 'invalid_token');

  // JWK EC → DER signature conversion: the JWT carries r||s, node needs DER.
  const der = ecSignatureToDer(signature);
  const pem = createPublicKey({
    key: { kty: key.kty, crv: 'P-256', x: (key as { x?: string }).x, y: (key as { y?: string }).y },
    format: 'jwk',
  }).export({ type: 'spki', format: 'pem' }).toString();

  const verifier = createVerify('SHA256');
  verifier.update(signedData);
  if (!verifier.verify(pem, der)) throw err.badRequest('Identity token signature is invalid', 'invalid_token');

  const now = Math.floor(nowMs() / 1000);
  if (Number(payload.exp ?? 0) < now - 60) throw err.badRequest('Identity token has expired', 'invalid_token');
  const aud = Array.isArray(payload.aud) ? (payload.aud as string[]) : [String(payload.aud ?? '')];
  if (!aud.some((a) => expectedAud.includes(a))) throw err.badRequest('Identity token audience mismatch', 'invalid_token');
  if (!expectedIss.includes(String(payload.iss ?? ''))) throw err.badRequest('Identity token issuer mismatch', 'invalid_token');
  return payload;
}

function ecSignatureToDer(sig: Buffer): Buffer {
  if (sig.length !== 64) return sig;
  const r = trimLeadingZeros(sig.subarray(0, 32));
  const s = trimLeadingZeros(sig.subarray(32, 64));
  const encodeInt = (b: Buffer): Buffer => {
    const needsPad = b[0]! & 0x80;
    const body = needsPad ? Buffer.concat([Buffer.from([0]), b]) : b;
    return Buffer.concat([Buffer.from([0x02, body.length]), body]);
  };
  const seq = Buffer.concat([encodeInt(r), encodeInt(s)]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

function trimLeadingZeros(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}

export async function verifyAppleIdToken(idToken: string): Promise<VerifiedFederatedIdentity> {
  const clientId = config.providers.oauth.apple.clientId;
  if (!clientId) throw err.unavailable('Apple sign-in is not configured on this server');
  const payload = await verifyEs256(idToken, 'https://appleid.apple.com/auth/keys', [clientId], ['https://appleid.apple.com']);

  const subject = String(payload.sub ?? '');
  if (!subject) throw err.badRequest('Apple token has no subject', 'invalid_token');

  return {
    provider: 'apple',
    subject,
    email: payload.email ? normaliseEmail(String(payload.email)) : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    // Apple only returns a name on the very first authorization, so the client
    // must forward it explicitly; we never rely on it for identity.
    name: payload.name ? String(payload.name).slice(0, 64) : null,
  };
}

export function appleAuthorizeUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: config.providers.oauth.apple.clientId,
    redirect_uri: redirectUri,
    response_type: 'code id_token',
    scope: 'name email',
    state,
    response_mode: 'form_post',
  });
  return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
}

export async function exchangeAppleCode(code: string, redirectUri: string): Promise<VerifiedFederatedIdentity> {
  const res = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.providers.oauth.apple.clientId,
      client_secret: appleClientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw err.badRequest('Apple rejected the authorization code', 'oauth_failed');
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw err.badRequest('Apple did not return an identity token', 'oauth_failed');
  return verifyAppleIdToken(json.id_token);
}

/* ── Account linking ────────────────────────────────────────────── */

/**
 * Resolve a federated login to a user id, creating the account if this is the
 * first sign-in with that subject.
 *
 * Linking rule: we link to an existing account by hashed email ONLY when the
 * provider asserts the address is verified. Otherwise an attacker who controls a
 * provider account with someone else's unverified email could take it over.
 */
export function resolveFederatedUser(identity: VerifiedFederatedIdentity): { userId: string; created: boolean } {
  const existing = db()
    .prepare('SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?')
    .get(identity.provider, identity.subject) as { user_id: string } | undefined;
  if (existing) {
    db().prepare('UPDATE oauth_identities SET last_login_at = ? WHERE provider = ? AND subject = ?')
      .run(nowMs(), identity.provider, identity.subject);
    return { userId: existing.user_id, created: false };
  }

  // Attempt verified-email linking.
  if (identity.email && identity.emailVerified) {
    const hash = keyedHash(`${'email'}:${identity.email}`, 'identity');
    const linked = db()
      .prepare('SELECT user_id FROM identities WHERE method = ? AND identifier_hash = ? AND verified = 1')
      .get('email', hash) as { user_id: string } | undefined;
    if (linked) {
      db().prepare(`
        INSERT INTO oauth_identities (provider, subject, user_id, email_hash, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(identity.provider, identity.subject, linked.user_id, sha256Hex(identity.email), nowMs(), nowMs());
      return { userId: linked.user_id, created: false };
    }
  }

  // New pseudonymous account. The provider's display name is deliberately NOT
  // used: it would break anonymity for anyone who signs in with Google.
  const user = createUser({
    oauth: { provider: identity.provider, subject: identity.subject, email: identity.email },
    verified: identity.emailVerified,
  });
  return { userId: user.id, created: true };
}

/** PKCE helpers shared by the web OAuth routes. */
export function pkceChallenge(verifier: string): string {
  return base64url(sha256Hex(verifier).length ? Buffer.from(sha256Hex(verifier), 'hex') : utf8(verifier));
}

export function safeEqual(a: string, b: string): boolean {
  const ba = utf8(a);
  const bb = utf8(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function federatedProvidersEnabled(): { google: boolean; apple: boolean } {
  return {
    google: !!config.providers.oauth.google.clientId && config.features.registrationMethods.includes('google'),
    apple: !!config.providers.oauth.apple.clientId && config.features.registrationMethods.includes('apple'),
  };
}

export function invalidateJwksCache(): void {
  jwksCache.clear();
}
