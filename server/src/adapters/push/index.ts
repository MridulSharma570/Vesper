/**
 * Push notification adapter — FCM (Android), APNs (iOS), Web Push (browser),
 * WNS (Windows) and a `noop` driver for development.
 *
 * Privacy rule that shapes the whole design: push payloads never carry message
 * content unless the recipient's `notifications.previewInNotification` setting
 * allows it. Otherwise the payload contains only an opaque conversation id and
 * the client renders "New message". APNs and FCM both log payload metadata, so
 * this is not a theoretical concern for an anonymous messenger.
 *
 * Token handling: push tokens are stored per device and are treated as secrets —
 * they are never logged and never returned by the API.
 */
import { config } from '../../config.js';
import { db, nowMs } from '../../db/index.js';
import type { DeviceInfo, Platform } from '../../../../shared/types.js';

export interface PushPayload {
  userId: string;
  /** Stable collapse key so a burst of messages produces one notification. */
  collapseKey: string;
  title: string;
  body: string;
  data: Record<string, string>;
  /** Higher priority wakes a dozing device; used for calls only. */
  urgent?: boolean;
  badge?: number;
  sound?: string;
}

export interface PushResult {
  ok: boolean;
  provider: string;
  error?: string;
  /** True when the token is permanently dead and should be deleted. */
  invalidToken?: boolean;
}

interface PushDriver {
  readonly name: string;
  send(token: string, payload: PushPayload): Promise<PushResult>;
}

/* ── FCM (HTTP v1) ──────────────────────────────────────────────── */

class FcmDriver implements PushDriver {
  readonly name = 'fcm';
  private cachedToken: { value: string; expiresAt: number } | null = null;

  private async accessToken(): Promise<string | null> {
    const raw = config.providers.push.fcm.serviceAccountJson;
    if (!raw) return null;
    if (this.cachedToken && this.cachedToken.expiresAt > nowMs() + 60_000) return this.cachedToken.value;
    try {
      const sa = JSON.parse(raw.startsWith('{') ? raw : (await import('node:fs')).readFileSync(raw, 'utf8')) as {
        client_email: string;
        private_key: string;
        token_uri: string;
      };
      const jwt = await this.signJwt(sa.client_email, sa.private_key, sa.token_uri);
      const res = await fetch(sa.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { access_token: string; expires_in: number };
      this.cachedToken = { value: json.access_token, expiresAt: nowMs() + json.expires_in * 1000 };
      return json.access_token;
    } catch {
      return null;
    }
  }

  private async signJwt(iss: string, privateKeyPem: string, aud: string): Promise<string> {
    const { createSign } = await import('node:crypto');
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(nowMs() / 1000);
    const header = b64({ alg: 'RS256', typ: 'JWT' });
    const claims = b64({ iss, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud, iat: now, exp: now + 3600 });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    return `${header}.${claims}.${signer.sign(privateKeyPem).toString('base64url')}`;
  }

  async send(token: string, payload: PushPayload): Promise<PushResult> {
    const projectId = config.providers.push.fcm.projectId;
    const accessToken = await this.accessToken();
    if (!projectId || !accessToken) {
      return { ok: false, provider: this.name, error: 'FCM is not configured' };
    }
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: payload.title, body: payload.body },
            data: payload.data,
            android: {
              priority: payload.urgent ? 'high' : 'normal',
              collapse_key: payload.collapseKey,
              notification: { sound: payload.sound ?? 'default', channel_id: 'vesper_messages' },
            },
          },
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          provider: this.name,
          error: text.slice(0, 200),
          invalidToken: res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text),
        };
      }
      return { ok: true, provider: this.name };
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/* ── APNs (token-based, HTTP/2) ─────────────────────────────────── */

class ApnsDriver implements PushDriver {
  readonly name = 'apns';
  private cachedJwt: { value: string; issuedAt: number } | null = null;

  private async token(): Promise<string | null> {
    const { keyId, teamId, privateKey } = config.providers.push.apns;
    if (!keyId || !teamId || !privateKey) return null;
    // The JWT is valid for an hour; refresh every 50 minutes.
    if (this.cachedJwt && nowMs() - this.cachedJwt.issuedAt < 50 * 60_000) return this.cachedJwt.value;
    try {
      const { createSign } = await import('node:crypto');
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(nowMs() / 1000);
      const header = b64({ alg: 'ES256', kid: keyId });
      const claims = b64({ iss: teamId, iat: now });
      const signer = createSign('SHA256');
      signer.update(`${header}.${claims}`);
      const value = `${header}.${claims}.${signer.sign(privateKey).toString('base64url')}`;
      this.cachedJwt = { value, issuedAt: nowMs() };
      return value;
    } catch {
      return null;
    }
  }

  async send(token: string, payload: PushPayload): Promise<PushResult> {
    const jwt = await this.token();
    const { bundleId, production } = config.providers.push.apns;
    if (!jwt) return { ok: false, provider: this.name, error: 'APNS is not configured' };
    const host = production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    try {
      const res = await fetch(`${host}/3/device/${token}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': bundleId,
          'apns-push-type': 'alert',
          'apns-priority': payload.urgent ? '10' : '5',
          'apns-collapse-id': payload.collapseKey,
        },
        body: JSON.stringify({
          aps: {
            alert: { title: payload.title, body: payload.body },
            badge: payload.badge,
            sound: payload.sound ?? 'default',
            'mutable-content': 1,
          },
          ...payload.data,
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { reason?: string };
        return {
          ok: false,
          provider: this.name,
          error: json.reason ?? `HTTP ${res.status}`,
          invalidToken: json.reason === 'BadDeviceToken' || json.reason === 'Unregistered',
        };
      }
      return { ok: true, provider: this.name };
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/* ── Web Push (VAPID) ───────────────────────────────────────────── */

class WebPushDriver implements PushDriver {
  readonly name = 'web';

  async send(token: string, payload: PushPayload): Promise<PushResult> {
    const { vapidPublicKey, vapidPrivateKey, subject } = config.providers.push.web;
    if (!vapidPublicKey || !vapidPrivateKey) {
      return { ok: false, provider: this.name, error: 'VAPID keys are not set' };
    }
    try {
      // token is JSON: { endpoint, keys: { p256dh, auth } }
      const sub = JSON.parse(token) as { endpoint: string; keys: { p256dh: string; auth: string } };
      const encrypted = await encryptWebPush(sub.keys.p256dh, sub.keys.auth, JSON.stringify({
        title: payload.title,
        body: payload.body,
        data: payload.data,
      }));
      const vapidHeader = await vapidAuthHeader(sub.endpoint, vapidPublicKey, vapidPrivateKey, subject);
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          TTL: payload.urgent ? '30' : '2419200',
          Urgency: payload.urgent ? 'high' : 'normal',
          Topic: payload.collapseKey,
          Authorization: vapidHeader,
        },
        body: Buffer.from(encrypted),
      });
      if (!res.ok) {
        return { ok: false, provider: this.name, error: `HTTP ${res.status}`, invalidToken: res.status === 404 || res.status === 410 };
      }
      return { ok: true, provider: this.name };
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** RFC 8291 encrypted payload using aes128gcm content encoding. */
async function encryptWebPush(p256dh: string, auth: string, plaintext: string): Promise<ArrayBuffer> {
  const crypto = globalThis.crypto;
  const publicKey = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(p256dh),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const localPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const localPublicRaw = await crypto.subtle.exportKey('raw', localPair.publicKey);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    localPair.privateKey,
    256,
  );
  const authSecret = base64ToBytes(auth);
  const ikm = await hkdf(authSecret, new Uint8Array(sharedBits), 'WebPush: info\0'.length
    ? concatBytes(strToBytes('Content-Encoding: auth\0'), new Uint8Array(0))
    : new Uint8Array(0), 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, strToBytes('Content-Encoding: aesgcm\0'), 16);
  const nonce = await hkdf(ikm, salt, strToBytes('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const padded = concatBytes(strToBytes(plaintext), new Uint8Array([2]));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded);

  // aes128gcm header: salt(16) | rs(4) | idlen(1) | keyid(idlen)
  const header = new Uint8Array(16 + 4 + 1 + localPublicRaw.byteLength);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = localPublicRaw.byteLength;
  header.set(new Uint8Array(localPublicRaw), 21);
  return concatBytes(header, new Uint8Array(ciphertext)).buffer as ArrayBuffer;
}

async function vapidAuthHeader(endpoint: string, publicKey: string, privateKey: string, subject: string): Promise<string> {
  const { createSign } = await import('node:crypto');
  const url = new URL(endpoint);
  const now = Math.floor(nowMs() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ typ: 'JWT', alg: 'ES256' });
  const claims = b64({ aud: `${url.protocol}//${url.host}`, exp: now + 43_200, sub: subject });
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(privateKey).toString('base64url');
  void publicKey;
  return `vapid t=${header}.${claims}.${signature}, k=${publicKey}`;
}

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}
function strToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/* ── WNS (Windows) ──────────────────────────────────────────────── */

class WnsDriver implements PushDriver {
  readonly name = 'wns';

  async send(token: string, payload: PushPayload): Promise<PushResult> {
    // WNS requires an app registered in Partner Center plus an OAuth token from
    // the Store. The channel URI is the `token`; the body is a toast XML payload.
    void config.providers.push;
    const xml =
      `<toast><visual><binding template="ToastGeneric">` +
      `<text>${escapeXml(payload.title)}</text><text>${escapeXml(payload.body)}</text>` +
      `</binding></visual></toast>`;
    try {
      const res = await fetch(token, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml', 'X-WNS-Type': 'wns/toast' },
        body: xml,
      });
      return { ok: res.ok, provider: this.name, error: res.ok ? undefined : `HTTP ${res.status}`, invalidToken: res.status === 410 };
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c);
}

/* ── Noop (development) ─────────────────────────────────────────── */

class NoopDriver implements PushDriver {
  readonly name = 'noop';
  async send(_token: string, payload: PushPayload): Promise<PushResult> {
    // eslint-disable-next-line no-console
    console.log(`[push:noop] ${payload.title} — ${payload.body}`);
    return { ok: true, provider: this.name };
  }
}

function driverFor(platform: Platform, provider: string): PushDriver {
  const configured = config.providers.push.driver;
  if (configured === 'noop') return new NoopDriver();
  const explicit = provider === 'fcm' ? new FcmDriver()
    : provider === 'apns' ? new ApnsDriver()
    : provider === 'web' ? new WebPushDriver()
    : provider === 'wns' ? new WnsDriver()
    : null;
  if (explicit) return explicit;
  if (configured === 'fcm' && platform === 'android') return new FcmDriver();
  if (configured === 'apns' && platform === 'ios') return new ApnsDriver();
  if (configured === 'web' && platform === 'web') return new WebPushDriver();
  return new NoopDriver();
}

/* ── Public API ─────────────────────────────────────────────────── */

/** Raw shape of the device+settings join. Column names are snake_case. */
interface PushDeviceRow {
  id: string;
  user_id: string;
  platform: Platform;
  push_token: string | null;
  push_provider: string;
  settings_json: string;
}

export async function sendPush(payload: PushPayload): Promise<void> {
  const devices = db()
    .prepare(
      "SELECT d.*, u.settings_json FROM devices d JOIN users u ON u.id = d.user_id WHERE d.user_id = ? AND d.push_token IS NOT NULL AND u.status = 'active'",
    )
    .all(payload.userId) as PushDeviceRow[];

  for (const device of devices) {
    const settings = safeSettings(device.settings_json);
    if (!settings.notifications.enabled) continue;
    if (device.platform === 'web' && !settings.notifications.desktop) continue;
    if (device.platform !== 'web' && !settings.notifications.mobile) continue;
    if (!device.push_token) continue;

    // Enforce the preview policy: if the user has not allowed previews, strip
    // the body down to a generic string before it reaches the provider.
    const allowPreview =
      settings.notifications.previewInNotification === 'always' ||
      (settings.notifications.previewInNotification === 'contacts' && payload.data.isContact === '1');

    const delivered: PushPayload = allowPreview
      ? payload
      : { ...payload, title: 'Vesper', body: 'You have a new message', data: { ...payload.data, redacted: '1' } };

    const driver = driverFor(device.platform, device.push_provider);
    const result = await driver.send(device.push_token, delivered);
    if (result.invalidToken) {
      // A rejected token is dead forever; clear it so we stop paying for retries.
      db().prepare("UPDATE devices SET push_token = NULL, push_provider = 'none' WHERE id = ?")
        .run(device.id);
    }
  }
}

function safeSettings(raw: string): { notifications: { enabled: boolean; desktop: boolean; mobile: boolean; previewInNotification: string } } {
  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const n = parsed.notifications ?? {};
    return {
      notifications: {
        enabled: n.enabled !== false,
        desktop: n.desktop !== false,
        mobile: n.mobile !== false,
        previewInNotification: String(n.previewInNotification ?? 'contacts'),
      },
    };
  } catch {
    return { notifications: { enabled: true, desktop: true, mobile: true, previewInNotification: 'contacts' } };
  }
}

export function pushConfigured(): boolean {
  return config.providers.push.driver !== 'noop';
}
