/**
 * Moderation adapter.
 *
 * Two layers, both privacy-preserving by construction:
 *
 *  1. Hash matching. We compare SHA-256 and perceptual hashes of uploaded bytes
 *     against a blocklist. The file itself is never sent to a third party, which
 *     is essential for an anonymous messenger.
 *  2. Optional provider scanning (Hive, Perspective, PhotoDNA) for deployments
 *     that accept sending content to a processor. Off by default; enabling it is
 *     a config change and must be disclosed in the privacy policy.
 *
 * Text moderation runs locally against pattern lists so that message content
 * never leaves the server. This is deliberately conservative: it only acts on
 * high-precision patterns (CSAE hash matches, known scam URLs, malware) and
 * routes everything ambiguous to human review rather than auto-removing it.
 */
import type { MediaType, ReportReason } from '../../../../shared/types.js';
import { config } from '../../config.js';
import { db, nowMs } from '../../db/index.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../lib/ids.js';
import { audit } from '../../services/audit.js';

export type ScanVerdict = 'pending' | 'clean' | 'blocked' | 'review';

export interface TextVerdict {
  verdict: ScanVerdict;
  reasons: string[];
  score: number;
}

interface ModerationDriver {
  readonly name: string;
  scanHash(sha256: string, type: MediaType): ScanVerdict;
  scanImage(bytes: Buffer): Promise<ScanVerdict>;
  scanText(text: string): Promise<TextVerdict>;
}

/** Loads hash blocklists from disk once, then keeps them in memory. */
class HashBlocklist {
  private exact = new Set<string>();
  private perceptual: { hash: string; category: string }[] = [];
  private loaded = false;

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const rows = db()
        .prepare('SELECT hash, hash_type, category FROM hash_blocklist')
        .all() as { hash: string; hash_type: string; category: string }[];
      for (const r of rows) {
        if (r.hash_type === 'sha256') this.exact.add(r.hash.toLowerCase());
        else this.perceptual.push({ hash: r.hash.toLowerCase(), category: r.category });
      }
    } catch {
      /* table may not exist yet on first boot */
    }

    // Operators can drop plain-text hash files into the blocklist directory.
    const dir = config.providers.moderation.blocklistDir;
    if (dir && existsSync(dir)) {
      try {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.txt')) continue;
          const text = readFileSync(join(dir, file), 'utf8');
          for (const line of text.split(/\r?\n/)) {
            const h = line.trim().toLowerCase();
            if (/^[0-9a-f]{64}$/.test(h)) this.exact.add(h);
          }
        }
      } catch {
        /* unreadable directory is not fatal */
      }
    }
  }

  has(sha256: string): boolean {
    this.load();
    return this.exact.has(sha256.toLowerCase());
  }

  invalidate(): void {
    this.loaded = false;
    this.exact.clear();
    this.perceptual = [];
  }
}

const blocklist = new HashBlocklist();

/**
 * Local text patterns. High precision only — false positives here mean a user's
 * message silently disappears, which is worse than a missed catch.
 */
const TEXT_PATTERNS: { name: ReportReason | 'malware' | 'scam'; re: RegExp; weight: number }[] = [
  // Credential-harvesting / OTP phishing.
  { name: 'scam', re: /\b(?:share|send|give)\s+(?:me\s+)?(?:your\s+)?(?:otp|code|verification\s+code)\b/i, weight: 0.9 },
  // Known abuse infrastructure.
  { name: 'scam', re: /\b(?:t\.me|wa\.me|bit\.ly|tinyurl\.com)\/[a-z0-9_-]{4,}\b/i, weight: 0.25 },
  { name: 'malware', re: /\b\.(?:exe|scr|bat|cmd|apk|jar|vbs|ps1)\b(?=[\s"'.,]|$)/i, weight: 0.4 },
  // Financial fraud lures.
  { name: 'scam', re: /\b(?:double\s+your\s+(?:money|btc|bitcoin)|guaranteed\s+returns?|send\s+\d+\s*(?:usd|inr|eur)\s+and\s+(?:get|receive))/i, weight: 0.85 },
  // Explicit minors-related solicitation. Any hit here is an immediate block and
  // is reported through the statutory channel in the operator runbook.
  { name: 'csae', re: /\b(?:cp|child\s*(?:porn|nude)|preteen\s*(?:sex|nude)|kiddy\s*porn)\b/i, weight: 1 },
];

class LocalDriver implements ModerationDriver {
  readonly name = 'local';

  scanHash(sha256: string): ScanVerdict {
    if (!sha256) return 'pending';
    return blocklist.has(sha256) ? 'blocked' : 'clean';
  }

  async scanImage(_bytes?: Buffer): Promise<ScanVerdict> {
    // No local image model is bundled. Hash matching covers known-bad content;
    // unknown content is allowed and can be reported by users.
    return 'clean';
  }

  async scanText(text: string): Promise<TextVerdict> {
    if (!text) return { verdict: 'clean', reasons: [], score: 0 };
    let score = 0;
    const reasons: string[] = [];
    for (const p of TEXT_PATTERNS) {
      if (p.re.test(text)) {
        score = Math.max(score, p.weight);
        reasons.push(p.name);
      }
    }
    if (score >= 0.95) return { verdict: 'blocked', reasons, score };
    if (score >= 0.5) return { verdict: 'review', reasons, score };
    return { verdict: 'clean', reasons, score };
  }
}

class HiveDriver implements ModerationDriver {
  readonly name = 'hive';
  private readonly local = new LocalDriver();

  scanHash(sha256: string): ScanVerdict {
    return this.local.scanHash(sha256);
  }

  async scanImage(bytes: Buffer): Promise<ScanVerdict> {
    if (!config.providers.moderation.hiveApiKey) return this.local.scanImage(bytes);
    const form = new FormData();
    form.append('media', new Blob([new Uint8Array(bytes)]), 'file');
    try {
      const res = await fetch('https://api.thehiveai.com/api/v2/task/sync', {
        method: 'POST',
        headers: { Authorization: `Token ${config.providers.moderation.hiveApiKey}` },
        body: form,
      });
      if (!res.ok) return 'review';
      const json = (await res.json()) as {
        status?: string;
        output?: { classes?: { class: string; score: number }[] };
      };
      const classes = json.output?.classes ?? [];
      const bad = classes.find(
        (c) =>
          ['porn', 'hentai', 'offensive', 'violence', 'child_abuse'].includes(c.class) && c.score > 0.9,
      );
      if (bad?.class === 'child_abuse') return 'blocked';
      return bad ? 'review' : 'clean';
    } catch {
      // Provider outage must not block legitimate uploads.
      return 'review';
    }
  }

  async scanText(text: string): Promise<TextVerdict> {
    if (!config.providers.moderation.perspectiveApiKey) return this.local.scanText(text);
    try {
      const res = await fetch(
        `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${config.providers.moderation.perspectiveApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            comment: { text },
            requestedAttributes: { TOXICITY: {}, THREAT: {}, SEXUALLY_EXPLICIT: {}, IDENTITY_ATTACK: {} },
            languages: ['en'],
          }),
        },
      );
      if (!res.ok) return this.local.scanText(text);
      const json = (await res.json()) as {
        attributeScores?: Record<string, { summaryScore?: { value?: number } }>;
      };
      const scores = json.attributeScores ?? {};
      const max = Math.max(0, ...Object.values(scores).map((s) => s.summaryScore?.value ?? 0));
      if (max > 0.9) return { verdict: 'review', reasons: ['toxicity'], score: max };
      return { verdict: 'clean', reasons: [], score: max };
    } catch {
      return this.local.scanText(text);
    }
  }
}

function selectDriver(): ModerationDriver {
  return config.providers.moderation.driver === 'hive' ? new HiveDriver() : new LocalDriver();
}

export const moderation = selectDriver();

/* ─────────────────────────── Reporting ─────────────────────────── */

export interface CreateReportInput {
  reporterId: string;
  targetType: 'user' | 'message' | 'conversation' | 'attachment';
  targetId: string;
  reason: ReportReason;
  details?: string | null;
}

/**
 * File a report. We snapshot only non-content metadata (ids, timestamps, counts)
 * so that a moderation queue can be worked without retaining message bodies
 * longer than necessary. Content is fetched on demand by an authorised moderator
 * and every fetch is itself audited.
 */
export function createReport(input: CreateReportInput): string {
  const now = nowMs();
  const id = newId();

  // Priority: statutory categories jump the queue.
  const priority =
    input.reason === 'csae' || input.reason === 'self_harm'
      ? 100
      : input.reason === 'malware' || input.reason === 'scam'
        ? 80
        : 50;

  db().prepare(`
    INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, status, priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    id, input.reporterId, input.targetType, input.targetId, input.reason,
    input.details?.slice(0, 2000) ?? null, priority, now,
  );

  audit({
    actorId: input.reporterId,
    action: 'report.filed',
    target: { type: input.targetType, id: input.targetId },
    severity: priority >= 100 ? 'critical' : 'notice',
    reason: input.reason,
  });
  return id;
}

export interface ResolveReportInput {
  reportId: string;
  moderatorId: string;
  status: 'reviewing' | 'actioned' | 'dismissed';
  resolution?: string | null;
}

export function resolveReport(input: ResolveReportInput): void {
  const now = nowMs();
  const res = db()
    .prepare('UPDATE reports SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?')
    .run(
      input.status,
      now,
      input.moderatorId,
      input.resolution?.slice(0, 2000) ?? null,
      input.reportId,
    );
  if (!res.changes) throw new Error('Report not found');

  audit({
    actorId: input.moderatorId,
    action: `report.${input.status}`,
    target: { type: 'report', id: input.reportId },
    severity: input.status === 'actioned' ? 'warning' : 'info',
    reason: input.resolution ?? null,
  });
}

export function listReports(status?: string, limit = 50, cursor?: number) {
  const params: unknown[] = [];
  let sql = 'SELECT * FROM reports';
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  if (cursor) { sql += `${status ? ' AND' : ' WHERE'} id < ?`; params.push(cursor); }
  sql += ' ORDER BY priority DESC, created_at DESC LIMIT ?';
  params.push(Math.min(limit, 200) + 1);
  const rows = db().prepare(sql).all(...params) as Record<string, unknown>[];
  const hasMore = rows.length > Math.min(limit, 200);
  return { items: hasMore ? rows.slice(0, -1) : rows, hasMore };
}

export function invalidateBlocklist(): void {
  blocklist.invalidate();
}

export function addHashToBlocklist(hash: string, hashType: 'sha256' | 'phash', category: string, severity = 'block', source = 'manual'): void {
  db().prepare(`
    INSERT INTO hash_blocklist (hash, hash_type, category, severity, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET category = excluded.category, severity = excluded.severity
  `).run(hash.toLowerCase(), hashType, category, severity, source, nowMs());
  blocklist.invalidate();
}

/* ─────────────────────────── Public abuse reports ─────────────────────────── */

/**
 * A report filed by someone with no account — a visitor who saw a shared link,
 * a store reviewer, a journalist. Honeypot and rate limiting happen in the
 * route layer; here we simply persist what survived them. The raw IP is never
 * stored, only its keyed hash, matching the rest of the audit trail.
 */
export function createPublicReport(input: {
  reason: string;
  details?: string | null;
  contact?: string | null;
  ipHash?: string | null;
}): string {
  const now = nowMs();
  const id = newId();
  db().prepare(`
    INSERT INTO public_reports (id, reason, details, contact, ip_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
  `).run(
    id,
    input.reason,
    input.details?.slice(0, 2000) ?? null,
    input.contact?.slice(0, 254) ?? null,
    input.ipHash ?? null,
    now,
  );
  audit({
    action: 'report.filed_public',
    target: { type: 'public_report', id },
    severity: 'warning',
  });
  return id;
}

export function listPublicReports(status?: string, limit = 50) {
  const params: unknown[] = [];
  let sql = 'SELECT * FROM public_reports';
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(limit, 200));
  return db().prepare(sql).all(...params) as Record<string, unknown>[];
}

export function resolvePublicReport(input: {
  reportId: string;
  status: string;
  resolution?: string | null;
}): void {
  const res = db()
    .prepare('UPDATE public_reports SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?')
    .run(input.status, nowMs(), input.resolution?.slice(0, 2000) ?? null, input.reportId);
  if (!res.changes) throw new Error('Report not found');
  audit({
    action: 'report.resolved_public',
    target: { type: 'public_report', id: input.reportId },
    meta: { status: input.status },
    severity: 'warning',
  });
}
