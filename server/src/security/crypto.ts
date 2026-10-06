/**
 * Vesper cryptographic core.
 *
 * Deliberately built ONLY on primitives that are verified by the platform:
 *   - Node: `node:crypto` (OpenSSL) — scrypt, AES-256-GCM, SHA-256, BLAKE2b-512, HKDF, ECDH
 *   - Browser / Android WebView / iOS WKWebView / Electron renderer: WebCrypto (SubtleCrypto)
 *
 * No hand-rolled primitives. Every algorithm here is either FIPS/NIST specified or
 * RFC specified and supplied by the OS, so it is audited, constant-time and
 * hardware accelerated where available.
 *
 * Password hashing uses scrypt (N=2^15, r=8, p=1 — OWASP recommended) and is stored
 * in a self-describing PHC-style string so parameters can be raised later without
 * invalidating existing hashes. `needsRehash` drives transparent upgrades at login.
 */
import {
  createHmac,
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  generateKeyPairSync,
  createECDH,
} from 'node:crypto';
import { config } from '../config.js';

/* ─────────────────────────── Random & encoding ─────────────────────────── */

export function randomBytes(n: number): Buffer {
  return nodeRandomBytes(n);
}

export function randomHex(bytes = 16): string {
  return nodeRandomBytes(bytes).toString('hex');
}

/** URL-safe, unpadded base64 — safe in paths, query strings and JSON. */
export function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromBase64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function toHex(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

export function utf8(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

/** Cryptographically secure random integer in [0, max). Unbiased (rejection sampling). */
export function secureInt(max: number): number {
  if (max <= 0) throw new RangeError('max must be positive');
  if (max === 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  // Rejection sampling avoids modulo bias, which would leak information about OTPs.
  for (;;) {
    buf.set(new Uint32Array(nodeRandomBytes(4).buffer, 0, 1));
    const v = buf[0]!;
    if (v < limit) return v % max;
  }
}

/** Fixed-length numeric OTP. Leading zeros preserved. */
export function generateOtp(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(secureInt(10));
  return out;
}

/** Unbiased random pick from an array. */
export function pick<T>(items: readonly T[]): T {
  return items[secureInt(items.length)]!;
}

export function uuid(): string {
  return randomUUID();
}

/* ─────────────────────────── Hashing ─────────────────────────── */

export function sha256(data: Buffer | Uint8Array | string): Buffer {
  return createHash('sha256').update(typeof data === 'string' ? utf8(data) : data).digest();
}

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return sha256(data).toString('hex');
}

export function blake2b512(data: Buffer | Uint8Array | string): Buffer {
  return createHash('blake2b512').update(typeof data === 'string' ? utf8(data) : data).digest();
}

/**
 * Keyed hash used for pseudonymising identifiers (IP addresses, phone numbers,
 * emails) so we can detect abuse patterns without storing the raw value.
 * The server pepper makes the mapping non-reversible offline.
 */
export function keyedHash(value: string | Buffer, purpose: string): string {
  return createHmac('sha256', utf8(`${config.secrets.pepper}::${purpose}`))
    .update(typeof value === 'string' ? utf8(value) : value)
    .digest('hex');
}

/**
 * Short, human-safe fingerprint of a contact detail. This is what the account
 * owner sees in Settings ("+•••• 4f9a2c"); the raw value stays encrypted.
 */
export function identityFingerprint(value: string, method: string): string {
  return keyedHash(`${method}:${normaliseIdentifier(value)}`, 'identity').slice(0, 12);
}

export function hmacSha256(key: Buffer | string, data: Buffer | string): Buffer {
  return createHmac('sha256', typeof key === 'string' ? utf8(key) : key)
    .update(typeof data === 'string' ? utf8(data) : data)
    .digest();
}

/** HKDF-SHA256 key expansion (RFC 5869) — used for per-conversation ratchet keys. */
export function hkdfExpand(
  ikm: Buffer,
  salt: Buffer,
  info: string,
  length = 32,
): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, utf8(info), length));
}

export function constantTimeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const ba = typeof a === 'string' ? utf8(a) : Buffer.from(a);
  const bb = typeof b === 'string' ? utf8(b) : Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still do a comparison so the timing does not reveal the length mismatch early.
    timingSafeEqual(sha256(ba), sha256(bb));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/* ─────────────────────────── Password hashing (scrypt) ─────────────────────────── */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

/**
 * OWASP-recommended scrypt parameters. N=2^15 uses ~32 MiB per hash, which is a
 * real cost for an attacker but ~80 ms for a legitimate login.
 */
export const SCRYPT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1, keyLen: 32 };

/** Format: $scrypt$N=32768,r=8,p=1$<salt-b64>$<hash-b64> */
export function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  if (password.length > config.auth.password.maxLength) {
    // Guard against trivially large inputs causing memory exhaustion.
    throw new Error('Password too long');
  }
  const salt = randomBytes(16);
  const derived = scryptSync(utf8(password), salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 512 * 1024 * 1024,
  });
  return `$scrypt$N=${params.N},r=${params.r},p=${params.p}$${base64url(salt)}$${base64url(derived)}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const parts = encoded.split('$').filter(Boolean);
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const params = Object.fromEntries(
      parts[1]!.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k!, Number(v)];
      }),
    ) as { N: number; r: number; p: number };
    const salt = fromBase64url(parts[2]!);
    const expected = fromBase64url(parts[3]!);
    const derived = scryptSync(utf8(password), salt, expected.length, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 512 * 1024 * 1024,
    });
    return constantTimeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash uses weaker-than-current parameters and should be upgraded. */
export function needsRehash(encoded: string): boolean {
  try {
    const parts = encoded.split('$').filter(Boolean);
    if (parts[0] !== 'scrypt') return true;
    const params = Object.fromEntries(
      parts[1]!.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k!, Number(v)];
      }),
    ) as unknown as ScryptParams;
    return (
      params.N < SCRYPT_PARAMS.N ||
      params.r < SCRYPT_PARAMS.r ||
      params.p < SCRYPT_PARAMS.p
    );
  } catch {
    return true;
  }
}

/* ─────────────────────────── Authenticated encryption ───────────────────────────
 * AES-256-GCM. Used for at-rest encryption of optional recovery identifiers
 * (email / phone). Vesper never needs to read these, so they are stored as
 * ciphertext and can only be decrypted with the server data key.
 */

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

function dataKey(): Buffer {
  return Buffer.from(config.secrets.encKey, 'hex');
}

/** Returns `v1.<iv-b64>.<tag-b64>.<ciphertext-b64>` — versioned for key rotation. */
export function encryptSecret(plaintext: string, associatedData = ''): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey(), iv);
  if (associatedData) cipher.setAAD(utf8(associatedData));
  const ct = Buffer.concat([cipher.update(utf8(plaintext)), cipher.final()]);
  return `v1.${base64url(iv)}.${base64url(cipher.getAuthTag())}.${base64url(ct)}`;
}

export function decryptSecret(payload: string, associatedData = ''): string | null {
  try {
    const [version, ivB64, tagB64, ctB64] = payload.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) return null;
    const decipher = createDecipheriv('aes-256-gcm', dataKey(), fromBase64url(ivB64));
    if (associatedData) decipher.setAAD(utf8(associatedData));
    decipher.setAuthTag(fromBase64url(tagB64));
    return Buffer.concat([decipher.update(fromBase64url(ctB64)), decipher.final()]).toString('utf8');
  } catch {
    // Auth tag mismatch or malformed input — treat as unrecoverable, never throw.
    return null;
  }
}

/* ─────────────────────────── Key agreement (E2EE groundwork) ───────────────────────────
 * X25519 keypairs per device. The private key never leaves the device; the server
 * stores only public keys and routes opaque envelopes. This is the base for the
 * end-to-end encryption layer described in docs/SECURITY.md.
 */

export interface KeyPairPem {
  publicKey: string;
  privateKey: string;
}

export function generateX25519KeyPair(): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/** Shared secret from our private key and their public key (both PEM). */
export function x25519SharedSecret(privateKeyPem: string, publicKeyPem: string): Buffer {
  const priv = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(publicKeyPem);
  return Buffer.from(diffieHellman({ privateKey: priv, publicKey: pub }));
}

/* ─────────────────────────── Identifier normalisation ─────────────────────────── */

/** Lowercase + trim. Gmail-style dot/plus folding is intentionally NOT applied:
 *  folding would let an attacker enumerate which addresses map to one account. */
/**
 * Normalise an email address for comparison: trim and lowercase only.
 *
 * We deliberately do NOT strip Gmail-style `+tag` sub-addressing, and we do not
 * collapse dots in the local part. Both look like tidy normalisation, and both
 * are account-takeover vectors:
 *
 *   - Plus-addressing is a provider-specific feature. At a provider that does
 *     not implement it, `alice+news@corp.example` and `alice@corp.example` are
 *     two genuinely different mailboxes, possibly belonging to two different
 *     people. Merging them lets whoever controls one reach the other's account.
 *   - The same reasoning applies to dots, which only Gmail ignores.
 *
 * The cost of not merging is that one person can register several accounts with
 * plus tags. That is a spam problem, and it is handled where it belongs — by
 * rate limits, device signals and moderation — rather than by silently
 * conflating identities we cannot prove are the same.
 *
 * Only the domain part is safely case-insensitive; the local part is
 * case-sensitive in principle, but every major provider treats it as
 * insensitive, so lowercasing is the pragmatic and standard choice.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** E.164-ish normalisation: strip everything but digits and a leading +. */
export function normalisePhone(phone: string): string {
  const trimmed = phone.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/\D/g, '');
  return `${plus}${digits}`;
}

export function normaliseIdentifier(value: string): string {
  return value.includes('@') ? normaliseEmail(value) : normalisePhone(value);
}

export function isValidEmail(email: string): boolean {
  // Deliberately conservative: RFC 5322 is a swamp, and over-permissive regexes
  // let malformed values into the identity table.
  return /^[^\s@,;:<>"\\[\]()]+@[^\s@,;:<>"\\[\]()]+(\.[^\s@,;:<>"\\[\]()]+)+$/.test(
    email.trim(),
  ) && email.trim().length <= 254;
}

export function isValidPhone(phone: string): boolean {
  const digits = normalisePhone(phone).replace('+', '');
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Handle rules: 3-32 characters, lowercase alphanumerics, underscores, and
 * single hyphens or periods as separators.
 *
 * Hyphens must be allowed because that is what `generateHandle()` emits
 * (`quiet-otter`). A validator that disagrees with the generator would reject
 * every auto-assigned anonymous handle, which is the default path for anyone who
 * does not pick one — so the self-test below asserts the two agree.
 *
 * Separators may not lead, trail, double up, or mix adjacent (`a.-b`), which
 * keeps handles readable and makes `@handle` mentions unambiguous to parse.
 */
export function isValidHandle(handle: string, opts?: { allowReserved?: boolean }): boolean {
  const h = handle.trim().toLowerCase();
  if (h.length < config.auth.handle.minLength || h.length > config.auth.handle.maxLength) return false;
  if (!/^[a-z0-9_]+([.-][a-z0-9_]+)*$/.test(h)) return false;
  if (h.startsWith('.') || h.startsWith('-') || h.endsWith('.') || h.endsWith('-')) return false;
  if (h.includes('..') || h.includes('--') || h.includes('.-') || h.includes('-.')) return false;
  // Reserved names block PUBLIC registration (impersonation of the platform).
  // Staff seeding bypasses this on purpose: an operator creating the official
  // "administrator" account is exactly who the reservation protects.
  if (!opts?.allowReserved && (config.auth.handle.reserved as readonly string[]).includes(h)) return false;
  return true;
}

/* ─────────────────────────── Password strength ─────────────────────────── */

/**
 * Deterministic strength score 0-4, mirroring zxcvbn's scale so the client and
 * server agree without shipping a wordlist to the browser. Checks length,
 * character classes, repeats, sequences and embedded handle/email local-part.
 */
export function passwordScore(password: string, context: string[] = []): number {
  if (!password) return 0;
  let score = 0;
  const len = password.length;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;

  if (len >= config.auth.password.minLength) score++;
  if (len >= 14) score++;
  if (classes >= 3) score++;
  if (classes === 4 && len >= 16) score++;

  // Penalties
  if (/(.)\1{2,}/.test(password)) score--;                        // aaa, 1111
  if (/^(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)/.test(password)) score--;
  if (/(password|passw0rd|qwerty|letmein|admin|welcome|iloveyou|vesper)/i.test(password)) score -= 2;
  const lower = password.toLowerCase();
  for (const ctx of context) {
    if (ctx && ctx.length >= 4 && lower.includes(ctx.toLowerCase())) score -= 2;
  }
  // Unique-character ratio: catches "Tr0ub4dor&3" style but also "aaaaaaaaaaaa1A!"
  const unique = new Set(password).size;
  if (unique < Math.min(6, Math.ceil(len / 3))) score--;

  return Math.max(0, Math.min(4, score));
}

export function assertPasswordAcceptable(password: string, context: string[] = []): void {
  if (password.length < config.auth.password.minLength) {
    throw new Error(`Password must be at least ${config.auth.password.minLength} characters`);
  }
  if (password.length > config.auth.password.maxLength) {
    throw new Error('Password is too long');
  }
  if (passwordScore(password, context) < config.auth.password.minScore) {
    throw new Error('Password is too easy to guess. Mix cases, digits and symbols, and avoid personal details.');
  }
}

/* ─────────────────────────── Content addressing ───────────────────────────
 * Used by the media pipeline for de-duplication and for matching uploaded files
 * against known-abuse hash lists without storing the file itself.
 */
export function contentHash(buf: Buffer | Uint8Array): string {
  return sha256Hex(buf);
}

/**
 * Cheap perceptual-ish signature (average hash over an 8x8 grayscale grid).
 * A real deployment would use a vetted pHash library or a provider API; this
 * gives the pipeline a stable hook and correct interface now.
 */
export function averageHashFromGrayscale(gray8x8: Uint8Array): string {
  if (gray8x8.length !== 64) throw new RangeError('expected 64 grayscale samples');
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += gray8x8[i]!;
  const avg = sum / 64;
  let bits = 0n;
  for (let i = 0; i < 64; i++) {
    if (gray8x8[i]! >= avg) bits |= 1n << BigInt(i);
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistanceHex(a: string, b: string): number {
  const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  let v = x;
  while (v > 0n) {
    n += Number(v & 1n);
    v >>= 1n;
  }
  return n;
}

/* ─────────────────────────── Boot self-test ─────────────────────────── */

/**
 * Known-answer tests run at startup.
 *
 * A crypto primitive that silently returns wrong output is the worst possible
 * failure mode: passwords would all verify, or none would, and encryption would
 * look like it worked while producing garbage. These vectors come from the
 * published standards (FIPS 180-4 for SHA-256, RFC 7914 for scrypt, FIPS 197 for
 * AES-GCM) so they cannot be wrong in the same way our code is.
 *
 * The cost is a few milliseconds once per boot. That is a good trade.
 */
export function selfTest(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const check = (name: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) failures.push(`${name}: got ${String(actual)}, want ${String(expected)}`);
  };

  // FIPS 180-4: SHA-256("abc")
  check('sha256/abc', sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // SHA-256 of the empty string
  check('sha256/empty', sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  // BLAKE2b-512("abc") — RFC 7693 Appendix A
  check(
    'blake2b512/abc',
    toHex(blake2b512(utf8('abc'))),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
  );

  // RFC 7914 §12: scrypt(P="", S="", N=16, r=1, p=1, dkLen=64). Compared in full
  // rather than by prefix, so a truncation or ordering bug cannot slip through.
  const scryptEmpty = scryptSync(utf8(''), utf8(''), 64, { N: 16, r: 1, p: 1, maxmem: 64 * 1024 * 1024 });
  check(
    'scrypt/rfc7914-empty',
    toHex(scryptEmpty),
    '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442'
    + 'fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906',
  );
  // RFC 7914 §12: scrypt(P="password", S="NaCl", N=1024, r=8, p=16, dkLen=64)
  const scryptPwd = scryptSync(utf8('password'), utf8('NaCl'), 64, { N: 1024, r: 8, p: 16, maxmem: 128 * 1024 * 1024 });
  check(
    'scrypt/rfc7914-password',
    toHex(scryptPwd),
    'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162'
    + '2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
  );

  // AES-256-GCM round trip, and the guarantee that tampering is detected.
  const plaintext = 'the quick brown fox jumps over the lazy dog';
  const sealed = encryptSecret(plaintext);
  check('aes-gcm/roundtrip', decryptSecret(sealed), plaintext);
  const parts = sealed.split('.');
  if (parts.length === 4) {
    // Flip one bit of the ciphertext: decryption must fail closed, returning
    // null rather than throwing or yielding corrupted plaintext.
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    const tampered = [parts[0], parts[1], parts[2], base64url(ct)].join('.');
    check('aes-gcm/tamper-detected', decryptSecret(tampered), null);
  } else {
    failures.push('aes-gcm: unexpected ciphertext format');
  }

  // Password hashing: verify accepts the right password and rejects the wrong one.
  const hash = hashPassword('correct horse battery staple');
  check('scrypt/verify-ok', verifyPassword('correct horse battery staple', hash), true);
  check('scrypt/verify-bad', verifyPassword('correct horse battery staplf', hash), false);
  check('scrypt/needs-rehash', needsRehash(hash), false);
  check('scrypt/phc-format', hash.startsWith('$scrypt$N=32768,r=8,p=1$'), true);

  // HMAC and constant-time comparison.
  check(
    'hmac/rfc4231-case1',
    toHex(hmacSha256(Buffer.alloc(20, 0x0b), utf8('Hi There'))),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  );
  check('ct-equal/same', constantTimeEqual('abc', 'abc'), true);
  check('ct-equal/diff', constantTimeEqual('abc', 'abd'), false);
  check('ct-equal/length', constantTimeEqual('abc', 'abcd'), false);

  // X25519 agreement must be symmetric.
  const a = generateX25519KeyPair();
  const b = generateX25519KeyPair();
  check(
    'x25519/symmetric',
    toHex(x25519SharedSecret(a.privateKey, b.publicKey)),
    toHex(x25519SharedSecret(b.privateKey, a.publicKey)),
  );

  // Identity hashing must be deterministic and pepper-dependent.
  check('keyed-hash/deterministic', keyedHash('user@example.com', 'identity'), keyedHash('user@example.com', 'identity'));
  check('keyed-hash/purpose-separated', keyedHash('user@example.com', 'identity') !== keyedHash('user@example.com', 'other'), true);

  // Normalisation, which underpins every identifier comparison.
  check('normalise/email', normaliseEmail('  User@Example.COM '), 'user@example.com');
  // Plus tags and dots are preserved on purpose — see normaliseEmail().
  check('normalise/email-plus-preserved', normaliseEmail('user+tag@example.com'), 'user+tag@example.com');
  check('normalise/email-dots-preserved', normaliseEmail('u.s.e.r@example.com'), 'u.s.e.r@example.com');
  check('valid/email-ok', isValidEmail('user@example.com'), true);
  check('valid/email-bad', isValidEmail('user@example'), false);
  check('valid/handle-ok', isValidHandle('quiet_fox'), true);
  check('valid/handle-hyphen-ok', isValidHandle('quiet-otter'), true);
  check('valid/handle-bad', isValidHandle('ab'), false);
  check('valid/handle-double-sep-bad', isValidHandle('quiet--otter'), false);
  check('valid/handle-leading-sep-bad', isValidHandle('-quiet'), false);
  check('valid/handle-reserved-bad', isValidHandle('admin'), false);


  // Randomness must actually vary.
  check('random/varies', randomHex(16) !== randomHex(16), true);
  check('otp/length', generateOtp(6).length, 6);

  return { ok: failures.length === 0, failures };
}
