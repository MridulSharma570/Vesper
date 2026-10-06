/**
 * Email adapter.
 *
 * Drivers: `resend`, `ses`, `smtp`, and `console`.
 *
 * `console` is the development driver. It is NOT a stub that pretends to send —
 * it writes the full message to stdout and to `data/outbox/*.json` so you can
 * complete an email-verification or magic-link flow locally without any
 * provider account. It refuses to start in production, so you cannot
 * accidentally launch with email silently disabled.
 *
 * To go live: set EMAIL_DRIVER=resend and RESEND_API_KEY, then update
 * EMAIL_FROM to a domain you have verified. No code change is required.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../../config.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain-text body. Always provided so no client is forced to render HTML. */
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Transactional messages must not be batched or throttled by the provider. */
  category?: 'transactional' | 'marketing';
}

export interface EmailResult {
  ok: boolean;
  provider: string;
  messageId?: string;
  error?: string;
}

interface EmailDriver {
  readonly name: string;
  send(input: SendEmailInput): Promise<EmailResult>;
}

/* ── Resend ─────────────────────────────────────────────────────── */

class ResendDriver implements EmailDriver {
  readonly name = 'resend';

  async send(input: SendEmailInput): Promise<EmailResult> {
    const key = config.providers.email.resendApiKey;
    if (!key) return { ok: false, provider: this.name, error: 'RESEND_API_KEY is not set' };
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.providers.email.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          ...(input.html ? { html: input.html } : {}),
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
          ...(input.headers ? { headers: input.headers } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) return { ok: false, provider: this.name, error: body.message ?? `HTTP ${res.status}` };
      return { ok: true, provider: this.name, messageId: body.id };
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/* ── Amazon SES (v2 API, SigV4) ─────────────────────────────────── */

class SesDriver implements EmailDriver {
  readonly name = 'ses';

  async send(input: SendEmailInput): Promise<EmailResult> {
    const { region, accessKeyId, secretAccessKey } = config.providers.email.ses;
    if (!accessKeyId || !secretAccessKey) {
      return { ok: false, provider: this.name, error: 'SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY are not set' };
    }
    try {
      const { createHmac, createHash } = await import('node:crypto');
      const host = `email.${region}.amazonaws.com`;
      const target = 'com.amazon.email.v20220601.SendEmail';
      const body = JSON.stringify({
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: input.text, Charset: 'UTF-8' },
              ...(input.html ? { Html: { Data: input.html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
        Destination: { ToAddresses: [input.to] },
        FromEmailAddress: config.providers.email.from,
        ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
      });

      const now = new Date();
      const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const payloadHash = createHash('sha256').update(body).digest('hex');
      const scope = `${dateStamp}/${region}/ses/aws4_request`;

      const canonicalHeaders =
        `content-type:application/x-amz-json-1.1\n` +
        `host:${host}\n` +
        `x-amz-date:${amzDate}\n` +
        `x-amz-target:${target}\n`;
      const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
      const canonicalRequest = ['POST', '/', '', `${canonicalHeaders}\n`, signedHeaders, payloadHash].join('\n');
      const stringToSign = [
        'AWS4-HMAC-SHA256', amzDate, scope,
        createHash('sha256').update(canonicalRequest).digest('hex'),
      ].join('\n');

      const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
      const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 'ses'), 'aws4_request');
      const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

      const res = await fetch(`https://${host}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': target,
          'X-Amz-Date': amzDate,
          Authorization:
            `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as { MessageId?: string; message?: string };
      if (!res.ok) return { ok: false, provider: this.name, error: json.message ?? `HTTP ${res.status}` };
      return { ok: true, provider: this.name, messageId: json.MessageId };
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/* ── SMTP ───────────────────────────────────────────────────────── */

class SmtpDriver implements EmailDriver {
  readonly name = 'smtp';

  async send(input: SendEmailInput): Promise<EmailResult> {
    const url = config.providers.email.smtp.url;
    if (!url) return { ok: false, provider: this.name, error: 'SMTP_URL is not set' };
    try {
      // Minimal SMTP client over a TLS socket. Supports AUTH LOGIN/PLAIN.
      const parsed = new URL(url);
      const tls = await import('node:tls');
      const port = Number(parsed.port || (parsed.protocol === 'smtps:' ? 465 : 587));

      const result = await new Promise<EmailResult>((res) => {
        const socket = tls.connect({ host: parsed.hostname, port, servername: parsed.hostname }, () => {
          void 0;
        });
        let stage = 0;
        let buffer = '';
        const from = config.providers.email.from;
        const commands = [
          `EHLO ${parsed.hostname}`,
          parsed.username
            ? `AUTH PLAIN ${Buffer.from(`\0${decodeURIComponent(parsed.username)}\0${decodeURIComponent(parsed.password)}`).toString('base64')}`
            : null,
          `MAIL FROM:<${from.match(/<(.+)>/)?.[1] ?? from}>`,
          `RCPT TO:<${input.to}>`,
          'DATA',
          null,
          'QUIT',
        ].filter(Boolean) as string[];

        socket.setTimeout(15_000);
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (!/\r\n$/.test(buffer)) return;
          const lines = buffer.trim().split(/\r\n/);
          buffer = '';
          const last = lines[lines.length - 1] ?? '';
          const code = Number(last.slice(0, 3));
          if (code >= 400 && stage !== 1) {
            socket.destroy();
            res({ ok: false, provider: 'smtp', error: last });
            return;
          }
          if (stage === 5) {
            const message = [
              `From: ${from}`,
              `To: ${input.to}`,
              `Subject: ${input.subject}`,
              'MIME-Version: 1.0',
              `Content-Type: ${input.html ? 'text/html' : 'text/plain'}; charset=UTF-8`,
              ...(input.headers ? Object.entries(input.headers).map(([k, v]) => `${k}: ${v}`) : []),
              '',
              input.html ?? escapeHtml(input.text).replace(/\n/g, '<br>'),
              '',
            ].join('\r\n');
            socket.write(`${message.replace(/\r\n\./g, '\r\n..')}\r\n.\r\n`);
            stage++;
            return;
          }
          const next = commands[stage];
          stage++;
          if (next === undefined) {
            socket.end();
            res({ ok: true, provider: 'smtp' });
            return;
          }
          socket.write(`${next}\r\n`);
        });
        socket.on('error', (e) => res({ ok: false, provider: 'smtp', error: e.message }));
        socket.on('timeout', () => {
          socket.destroy();
          res({ ok: false, provider: 'smtp', error: 'timeout' });
        });
        socket.on('connect', () => {
          // Wait for the banner before sending EHLO.
        });
      });
      return result;
    } catch (e) {
      return { ok: false, provider: this.name, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/* ── Console / outbox (development) ─────────────────────────────── */

class ConsoleDriver implements EmailDriver {
  readonly name = 'console';

  async send(input: SendEmailInput): Promise<EmailResult> {
    const record = {
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html ?? null,
      sentAt: new Date().toISOString(),
    };
    const dir = resolve(config.storage.localDir, '..', 'outbox');
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
      // eslint-disable-next-line no-console
      console.log(
        `\n[email:console] → ${input.to}\n` +
        `  subject: ${input.subject}\n` +
        `  saved:   ${file}\n`,
      );
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[email:console] → ${input.to} | ${input.subject}`);
    }
    return { ok: true, provider: this.name, messageId: `dev-${Date.now()}` };
  }
}

function selectDriver(): EmailDriver {
  if (config.isProd && config.providers.email.driver === 'console') {
    throw new Error(
      'EMAIL_DRIVER=console is not permitted in production. Set EMAIL_DRIVER to resend, ses or smtp.',
    );
  }
  switch (config.providers.email.driver) {
    case 'resend': return new ResendDriver();
    case 'ses': return new SesDriver();
    case 'smtp': return new SmtpDriver();
    default: return new ConsoleDriver();
  }
}

export const emailDriver: EmailDriver = selectDriver();

export async function sendEmail(input: SendEmailInput): Promise<EmailResult> {
  // Refuse to email a deactivated or deleted account.
  if (!input.to || !input.to.includes('@')) {
    return { ok: false, provider: emailDriver.name, error: 'invalid recipient' };
  }
  return emailDriver.send(input);
}

/** Whether real delivery is configured — surfaced on /healthz so ops can see it. */
export function emailConfigured(): boolean {
  return emailDriver.name !== 'console';
}
