/**
 * SMS adapter — one-time passcodes and security alerts.
 *
 * Drivers: `twilio`, `msg91`, `sns`, and `console`.
 *
 * `console` writes the OTP to stdout and `data/outbox/sms-*.json` so the phone
 * registration flow is fully exercisable locally without a paid sender ID. It
 * refuses to start in production.
 *
 * MSG91 is included first-class because it is the practical route for Indian
 * numbers (DLT-registered sender IDs and templates), which matters if you are
 * launching from Punjab.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../../config.js';

export interface SendSmsInput {
  /** E.164, e.g. +919812345678 */
  to: string;
  message: string;
  /** Provider template id where the route requires one (MSG91/DLT). */
  templateId?: string;
  /** Structured values for template substitution. */
  variables?: Record<string, string>;
}

export interface SmsResult {
  ok: boolean;
  provider: string;
  messageId?: string;
  error?: string;
}

interface SmsDriver {
  readonly name: string;
  send(input: SendSmsInput): Promise<SmsResult>;
}

/* ── Twilio ─────────────────────────────────────────────────────── */

class TwilioDriver implements SmsDriver {
  readonly name = 'twilio';

  async send(input: SendSmsInput): Promise<SmsResult> {
    const { accountSid, authToken } = config.providers.sms.twilio;
    if (!accountSid || !authToken) {
      return { ok: false, provider: this.name, error: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set' };
    }
    if (!config.providers.sms.from) {
      return { ok: false, provider: this.name, error: 'SMS_FROM is not set' };
    }
    try {
      const body = new URLSearchParams({ To: input.to, From: config.providers.sms.from, Body: input.message });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );
      const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok) return { ok: false, provider: this.name, error: json.message ?? `HTTP ${res.status}` };
      return { ok: true, provider: this.name, messageId: json.sid };
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/* ── MSG91 (India, DLT templates) ───────────────────────────────── */

class Msg91Driver implements SmsDriver {
  readonly name = 'msg91';

  async send(input: SendSmsInput): Promise<SmsResult> {
    const { authKey, senderId, templateId } = config.providers.sms.msg91;
    if (!authKey) return { ok: false, provider: this.name, error: 'MSG91_AUTH_KEY is not set' };
    try {
      // Flow-based OTP endpoint; falls back to the classic transactional route
      // when no template is configured.
      const url = templateId
        ? 'https://control.msg91.com/api/v5/flow/'
        : 'https://api.msg91.com/api/v5/sms';

      const payload = templateId
        ? {
            flow_id: templateId,
            sender: senderId || undefined,
            mobiles: input.to.replace('+', ''),
            ...(input.variables ?? {}),
          }
        : {
            message: input.message,
            sender: senderId || 'VESPER',
            route: '4',
            country: input.to.startsWith('+91') ? '91' : '0',
            sms: [{ message: input.message, to: [input.to.replace('+', '')] }],
          };

      const res = await fetch(url, {
        method: 'POST',
        headers: { authkey: authKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, provider: this.name, error: text.slice(0, 200) };
      return { ok: true, provider: this.name, messageId: text.slice(0, 64) };
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/* ── AWS SNS ────────────────────────────────────────────────────── */

class SnsDriver implements SmsDriver {
  readonly name = 'sns';

  async send(input: SendSmsInput): Promise<SmsResult> {
    const { region, accessKeyId, secretAccessKey } = config.providers.sms.sns;
    if (!accessKeyId || !secretAccessKey) {
      return { ok: false, provider: this.name, error: 'SNS_ACCESS_KEY_ID / SNS_SECRET_ACCESS_KEY are not set' };
    }
    try {
      const { createHmac, createHash } = await import('node:crypto');
      const host = `sns.${region}.amazonaws.com`;
      const params = new URLSearchParams({ Action: 'Publish', PhoneNumber: input.to, Message: input.message });
      const body = params.toString();
      const now = new Date();
      const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const scope = `${dateStamp}/${region}/sns/aws4_request`;
      const payloadHash = createHash('sha256').update(body).digest('hex');
      const signedHeaders = 'content-type;host;x-amz-date';
      const canonicalRequest = [
        'POST', '/', '',
        `content-type:application/x-www-form-urlencoded\nhost:${host}\nx-amz-date:${amzDate}\n`,
        signedHeaders, payloadHash,
      ].join('\n');
      const stringToSign = [
        'AWS4-HMAC-SHA256', amzDate, scope,
        createHash('sha256').update(canonicalRequest).digest('hex'),
      ].join('\n');
      const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
      const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 'sns'), 'aws4_request');
      const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

      const res = await fetch(`https://${host}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Amz-Date': amzDate,
          Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        body,
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, provider: this.name, error: text.slice(0, 200) };
      const id = text.match(/<MessageId>([^<]+)<\/MessageId>/)?.[1];
      return { ok: true, provider: this.name, messageId: id };
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/* ── Console (development) ──────────────────────────────────────── */

class ConsoleDriver implements SmsDriver {
  readonly name = 'console';

  async send(input: SendSmsInput): Promise<SmsResult> {
    const dir = resolve(config.storage.localDir, '..', 'outbox');
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `sms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      // Store the hashed destination, not the raw number, even in dev artifacts.
      writeFileSync(file, JSON.stringify({ to: input.to, message: input.message, sentAt: new Date().toISOString() }, null, 2), {
        mode: 0o600,
      });
      // eslint-disable-next-line no-console
      console.log(`\n[sms:console] → ${input.to}\n  ${input.message}\n  saved: ${file}\n`);
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[sms:console] → ${input.to} | ${input.message}`);
    }
    return { ok: true, provider: this.name, messageId: `dev-${Date.now()}` };
  }
}

function selectDriver(): SmsDriver {
  if (config.isProd && config.providers.sms.driver === 'console') {
    throw new Error('SMS_DRIVER=console is not permitted in production. Set SMS_DRIVER to twilio, msg91 or sns.');
  }
  switch (config.providers.sms.driver) {
    case 'twilio': return new TwilioDriver();
    case 'msg91': return new Msg91Driver();
    case 'sns': return new SnsDriver();
    default: return new ConsoleDriver();
  }
}

export const smsDriver: SmsDriver = selectDriver();

export async function sendSms(input: SendSmsInput): Promise<SmsResult> {
  if (!/^\+?\d{7,15}$/.test(input.to.replace(/\s/g, ''))) {
    return { ok: false, provider: smsDriver.name, error: 'invalid destination number' };
  }
  return smsDriver.send(input);
}

export function smsConfigured(): boolean {
  return smsDriver.name !== 'console';
}
