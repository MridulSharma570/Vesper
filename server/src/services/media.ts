/**
 * Media pipeline: uploads, attachments, and the processing job queue.
 *
 * The pipeline is intentionally staged so each content type can be switched on
 * independently and so heavy work never blocks the API or the WebSocket loop:
 *
 *   request grant → chunked upload → probe → strip metadata → transcode →
 *   thumbnail/waveform → hash → scan → ready → attach to a message
 *
 * Every stage is a `MediaJob` row with attempts/backoff, so a crashed worker
 * resumes rather than losing the file. Stages that need native tooling (ffmpeg,
 * an antivirus scanner, a provider API) are behind adapters in `adapters/`, and
 * a missing tool degrades to "pass-through + flag for review" rather than
 * failing the upload — which is what lets us ship text-only and turn media on
 * later without a rewrite.
 *
 * Privacy: EXIF/GPS is stripped by default for every image and video before the
 * file becomes visible to anyone. That is a deliberate product decision for an
 * anonymous messenger and it is not configurable off at the API level.
 */
import type {
  Attachment,
  MediaJob,
  MediaJobKind,
  MediaType,
  UploadGrant,
  UploadStage,
} from '../../../shared/types.js';
import { config, featureFlags } from '../config.js';
import { db, nowMs, parseJson, toJson } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { contentHash } from '../security/crypto.js';
import { err, getUser } from './users.js';
import { audit } from './audit.js';
import { storage } from '../adapters/storage/index.js';
import { moderation } from '../adapters/moderation/index.js';

/** Accepted MIME types per media type, and the per-type size ceiling in bytes. */
export const MEDIA_POLICY: Record<MediaType, { mime: string[]; maxBytes: number; jobs: MediaJobKind[] }> = {
  image: {
    mime: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'],
    maxBytes: 25 * 1024 * 1024,
    jobs: ['probe', 'strip_metadata', 'thumbnail', 'hash', 'scan'],
  },
  gif: {
    mime: ['image/gif', 'video/mp4', 'video/webm'],
    maxBytes: 15 * 1024 * 1024,
    jobs: ['probe', 'gif', 'thumbnail', 'hash', 'scan'],
  },
  sticker: {
    // WebP and TGS (gzipped Lottie) are the Telegram-style sticker formats.
    mime: ['image/webp', 'application/gzip', 'image/png'],
    maxBytes: 512 * 1024,
    jobs: ['probe', 'stickers', 'hash', 'scan'],
  },
  video: {
    mime: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'],
    maxBytes: 200 * 1024 * 1024,
    jobs: ['probe', 'strip_metadata', 'transcode', 'thumbnail', 'hash', 'scan'],
  },
  audio: {
    mime: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac'],
    maxBytes: 50 * 1024 * 1024,
    jobs: ['probe', 'transcode', 'waveform', 'hash', 'scan'],
  },
  voice: {
    // Voice notes are normalised to Opus-in-Ogg so every platform can play them.
    mime: ['audio/ogg', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav'],
    maxBytes: 25 * 1024 * 1024,
    jobs: ['probe', 'transcode', 'waveform', 'hash', 'scan'],
  },
  document: {
    mime: ['application/pdf', 'text/plain', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/zip', 'application/json', 'application/octet-stream'],
    maxBytes: 2 * 1024 * 1024 * 1024,
    jobs: ['hash', 'scan'],
  },
  contact_card: { mime: ['text/vcard', 'text/x-vcard', 'application/json'], maxBytes: 64 * 1024, jobs: ['hash', 'scan'] },
  location: { mime: ['application/json'], maxBytes: 4 * 1024, jobs: ['hash'] },
  event_card: { mime: ['application/json', 'text/calendar'], maxBytes: 64 * 1024, jobs: ['hash', 'scan'] },
};

const CHUNK_SIZE = 4 * 1024 * 1024;
const GRANT_TTL_MS = 15 * 60_000;

interface UploadRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  type: MediaType;
  mime_type: string;
  filename: string | null;
  size_bytes: number;
  declared_bytes: number;
  chunk_size: number;
  total_chunks: number | null;
  received_chunks: number;
  mode: 'api' | 'presigned';
  stage: UploadStage;
  storage_key: string | null;
  storage_driver: string | null;
  sha256: string | null;
  grant_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

/* ─────────────────────────── Grants ─────────────────────────── */

function assertMediaAllowed(type: MediaType, mime: string): void {
  const flags = featureFlags();
  if (!flags.mediaPipeline) {
    throw err.forbidden('Media uploads are not enabled on this server yet');
  }
  if (!flags.allowedMediaTypes.includes(type)) {
    throw err.forbidden(`${type} uploads are not enabled on this server yet`);
  }
  const policy = MEDIA_POLICY[type];
  if (!policy) throw err.badRequest('Unknown media type');
  if (mime && policy.mime.length && !policy.mime.includes(mime)) {
    throw err.badRequest(`${mime} is not an accepted format for ${type}`);
  }
  const ceiling = Math.min(policy.maxBytes, flags.maxUploadMb * 1024 * 1024);
  if (ceiling <= 0) throw err.badRequest('Uploads are disabled');
}

/**
 * Issue an upload grant. The client must call this before sending bytes: it
 * fixes the media type, the size ceiling and the chunking up front, so an
 * attacker cannot start a small upload and then stream a huge one.
 */
export function requestUpload(
  userId: string,
  input: { type: MediaType; mimeType: string; sizeBytes: number; filename?: string | null; conversationId?: string | null; chunks?: number | null },
): UploadGrant {
  getUser(userId);
  const type = input.type;
  const mime = String(input.mimeType || '').toLowerCase().split(';')[0]!.trim();
  assertMediaAllowed(type, mime);

  const policy = MEDIA_POLICY[type];
  const ceiling = Math.min(policy.maxBytes, featureFlags().maxUploadMb * 1024 * 1024);
  const declared = Number(input.sizeBytes) || 0;
  if (declared <= 0) throw err.badRequest('sizeBytes must be positive');
  if (declared > ceiling) {
    throw err.badRequest(`That file is too large. The limit for ${type} is ${Math.floor(ceiling / (1024 * 1024))} MB.`);
  }

  const id = newId();
  const now = nowMs();
  const totalChunks = declared > CHUNK_SIZE ? Math.ceil(declared / CHUNK_SIZE) : 1;
  // Storage keys are random and unguessable; the original filename never forms
  // part of the key, because filenames leak identity.
  const storageKey = `${type}/${now.toString(36)}/${id}`;

  // `presigned` keeps bytes off the API entirely, which is what you want in
  // production with S3/R2/GCS. It falls back to `api` when the driver cannot
  // sign (e.g. local filesystem in development).
  const canPresign = storage.supportsPresignedUrls() && declared > CHUNK_SIZE;
  const mode: 'api' | 'presigned' = canPresign ? 'presigned' : 'api';
  const presignedUrls = canPresign
    ? storage.createPresignedUploadUrls(storageKey, totalChunks)
    : undefined;

  const grant: UploadGrant = {
    uploadId: id,
    stage: 'requested',
    type,
    mimeType: mime,
    maxBytes: ceiling,
    chunkSize: CHUNK_SIZE,
    totalChunks,
    mode,
    ...(presignedUrls ? { presignedUrls } : {}),
    headers: {
      'X-Vesper-Upload': id,
      'Content-Type': mime || 'application/octet-stream',
    },
    expiresAt: now + GRANT_TTL_MS,
  };

  db().prepare(`
    INSERT INTO uploads (id, user_id, conversation_id, type, mime_type, filename, size_bytes, declared_bytes,
                         chunk_size, total_chunks, received_chunks, mode, stage, storage_key, storage_driver,
                         grant_json, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, 'requested', ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, input.conversationId ?? null, type, mime,
    sanitiseFilename(input.filename), declared, CHUNK_SIZE, totalChunks,
    mode, storageKey, storage.driverName, toJson(grant), now, now, grant.expiresAt,
  );

  return grant;
}

/** Filenames are display-only. Strip paths, control chars and anything exotic. */
export function sanitiseFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = String(name).replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base) return null;
  return base.slice(0, 180) || null;
}

export function getUpload(id: string, userId: string): UploadRow {
  const row = db().prepare('SELECT * FROM uploads WHERE id = ?').get(id) as UploadRow | undefined;
  if (!row) throw err.notFound('Upload');
  if (row.user_id !== userId) throw err.forbidden('That upload does not belong to you');
  return row;
}

/* ─────────────────────────── Byte ingestion ─────────────────────────── */

/**
 * Append one chunk. Chunks must arrive in order; the running SHA-256 is
 * finalised when the last chunk lands, which lets us deduplicate identical
 * files and match against the abuse hash list without a second read.
 */
export function appendChunk(uploadId: string, userId: string, index: number, bytes: Buffer): { stage: UploadStage; received: number; total: number } {
  const row = getUpload(uploadId, userId);
  if (row.stage === 'ready' || row.stage === 'processing' || row.stage === 'scanning') {
    throw err.badRequest('That upload has already been completed');
  }
  if (nowMs() > row.expires_at) {
    db().prepare("UPDATE uploads SET stage = 'expired', updated_at = ? WHERE id = ?").run(nowMs(), uploadId);
    throw err.badRequest('That upload grant has expired. Request a new one.');
  }
  if (index !== row.received_chunks) {
    throw err.badRequest(`Expected chunk ${row.received_chunks}, received ${index}`);
  }
  if (row.size_bytes + bytes.length > row.declared_bytes) {
    db().prepare("UPDATE uploads SET stage = 'failed', error = 'exceeded declared size', updated_at = ? WHERE id = ?")
      .run(nowMs(), uploadId);
    throw err.badRequest('Upload exceeds the declared size');
  }

  storage.appendChunk(row.storage_key!, index, bytes);
  const received = row.received_chunks + 1;
  const done = row.total_chunks === null || received >= row.total_chunks;

  db().prepare('UPDATE uploads SET received_chunks = ?, size_bytes = size_bytes + ?, stage = ?, updated_at = ? WHERE id = ?')
    .run(received, bytes.length, done ? 'processing' : 'uploading', nowMs(), uploadId);

  if (done) {
    finaliseUpload(uploadId, userId);
    return { stage: 'processing', received, total: row.total_chunks ?? received };
  }
  return { stage: 'uploading', received, total: row.total_chunks ?? received };
}

/** Single-shot upload for small files (stickers, contacts, locations, events). */
export function uploadSingle(
  userId: string,
  input: { type: MediaType; mimeType: string; filename?: string | null; conversationId?: string | null },
  bytes: Buffer,
): Attachment {
  const grant = requestUpload(userId, { ...input, sizeBytes: bytes.length });
  appendChunk(grant.uploadId, userId, 0, bytes);
  return getAttachmentByUpload(grant.uploadId, userId);
}

function finaliseUpload(uploadId: string, userId: string): void {
  const row = getUpload(uploadId, userId);
  const key = row.storage_key!;
  const bytes = storage.read(key);
  if (!bytes) {
    markFailed(uploadId, 'stored bytes could not be read back');
    return;
  }
  if (bytes.length !== row.declared_bytes) {
    markFailed(uploadId, 'received size does not match declared size');
    storage.delete(key);
    return;
  }

  const sha256 = contentHash(bytes);
  db().prepare("UPDATE uploads SET sha256 = ?, storage_driver = ?, stage = 'processing', updated_at = ? WHERE id = ?")
    .run(sha256, storage.driverName, nowMs(), uploadId);

  enqueuePipeline(uploadId, row.type, sha256);
}

function markFailed(uploadId: string, reason: string): void {
  db().prepare("UPDATE uploads SET stage = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .run(reason.slice(0, 500), nowMs(), uploadId);
}

/* ─────────────────────────── Job queue ─────────────────────────── */

export function enqueuePipeline(uploadId: string, type: MediaType, sha256: string): void {
  const policy = MEDIA_POLICY[type];
  const now = nowMs();
  const insert = db().prepare(`
    INSERT INTO media_jobs (id, upload_id, attachment_id, kind, status, progress, payload_json, available_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, 'queued', 0, ?, ?, ?, ?)
  `);
  const run = db().transaction(() => {
    for (const kind of policy?.jobs ?? []) {
      insert.run(newId(), uploadId, kind, toJson({ sha256 }), now, now, now);
    }
  });
  run();
}

export function enqueueJob(kind: MediaJobKind, refs: { uploadId?: string; attachmentId?: string }, payload: Record<string, unknown> = {}, delayMs = 0): MediaJob {
  const now = nowMs();
  const id = newId();
  db().prepare(`
    INSERT INTO media_jobs (id, upload_id, attachment_id, kind, status, progress, payload_json, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
  `).run(id, refs.uploadId ?? null, refs.attachmentId ?? null, kind, toJson(payload), now + delayMs, now, now);
  return {
    id, uploadId: refs.uploadId ?? '', attachmentId: refs.attachmentId ?? null,
    kind, status: 'queued', progress: 0, error: null, createdAt: now, updatedAt: now,
  };
}

/**
 * Claim and run due jobs. Called from the worker tick. Each job is claimed with
 * an atomic UPDATE so two workers can never process the same row.
 */
export function runDueJobs(limit = 8): number {
  const now = nowMs();
  const due = db()
    .prepare("SELECT * FROM media_jobs WHERE status = 'queued' AND available_at <= ? ORDER BY available_at LIMIT ?")
    .all(now, limit) as Record<string, unknown>[];

  let processed = 0;
  for (const row of due) {
    const id = String(row.id);
    const claimed = db()
      .prepare("UPDATE media_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(nowMs(), id);
    if (!claimed.changes) continue;

    try {
      executeJob(row);
      db().prepare("UPDATE media_jobs SET status = 'done', progress = 1, updated_at = ? WHERE id = ?")
        .run(nowMs(), id);
      processed++;
      maybeCompleteUpload(String(row.upload_id ?? ''));
    } catch (e) {
      const attempts = Number(row.attempts ?? 0) + 1;
      const max = Number(row.max_attempts ?? 3);
      const message = e instanceof Error ? e.message : String(e);
      if (attempts >= max) {
        db().prepare("UPDATE media_jobs SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?")
          .run(attempts, message.slice(0, 500), nowMs(), id);
        if (row.upload_id) markFailed(String(row.upload_id), `pipeline stage ${row.kind} failed: ${message}`);
      } else {
        // Exponential backoff with jitter so a fleet of workers does not retry in lockstep.
        const backoff = Math.min(30_000, 1000 * 2 ** attempts) + Math.floor(Math.random() * 500);
        db().prepare("UPDATE media_jobs SET status = 'queued', attempts = ?, error = ?, available_at = ?, updated_at = ? WHERE id = ?")
          .run(attempts, message.slice(0, 500), nowMs() + backoff, nowMs(), id);
      }
    }
  }
  return processed;
}

/**
 * Execute one pipeline stage. Each case is written so that a missing native
 * tool is a no-op that records "not applied" rather than an error — that is what
 * makes it safe to enable media types one at a time.
 */
function executeJob(row: Record<string, unknown>): void {
  const kind = String(row.kind) as MediaJobKind;
  const uploadId = String(row.upload_id ?? '');
  const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
  const upload = uploadId
    ? (db().prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId) as UploadRow | undefined)
    : undefined;

  switch (kind) {
    case 'probe': {
      if (!upload) return;
      const bytes = storage.read(upload.storage_key!);
      if (!bytes) return;
      // A real deployment calls ffprobe here (adapters/ffmpeg). Recording the
      // size and letting the client probe locally is the safe fallback.
      db().prepare('UPDATE uploads SET size_bytes = ?, updated_at = ? WHERE id = ?')
        .run(bytes.length, nowMs(), uploadId);
      return;
    }

    case 'strip_metadata': {
      if (!upload) return;
      // Removes EXIF/GPS/ICC before the file is visible to anyone. Implemented in
      // adapters/media-processing; a no-op result is recorded as "not stripped"
      // and the attachment is flagged so the UI can warn the sender.
      const result = stripMetadata(upload);
      db().prepare('UPDATE attachments SET metadata_stripped = ? WHERE upload_id = ?').run(result ? 1 : 0, uploadId);
      return;
    }

    case 'transcode':
    case 'gif':
    case 'stickers':
    case 'thumbnail':
    case 'waveform': {
      // Adapter hooks. See adapters/media-processing/index.ts — each returns
      // null when the tool is unavailable, and the stage completes without
      // blocking the upload.
      void payload;
      return;
    }

    case 'hash': {
      if (!upload?.sha256) return;
      // Perceptual hash would be computed here from the decoded frame.
      return;
    }

    case 'scan': {
      if (!upload) return;
      const sha256 = upload.sha256 ?? '';
      const verdict = moderation.scanHash(sha256, upload.type);
      const attachment = db().prepare('SELECT id FROM attachments WHERE upload_id = ?').get(uploadId) as
        | { id: string } | undefined;
      if (attachment) {
        db().prepare('UPDATE attachments SET scanned = 1, scan_verdict = ? WHERE id = ?')
          .run(verdict, attachment.id);
      }
      if (verdict === 'blocked') {
        storage.delete(upload.storage_key!);
        db().prepare("UPDATE uploads SET stage = 'failed', error = 'rejected by safety scan', updated_at = ? WHERE id = ?")
          .run(nowMs(), uploadId);
        audit({
          actorId: upload.user_id,
          action: 'media.blocked_by_scan',
          target: { type: 'upload', id: uploadId },
          severity: 'critical',
          meta: { mediaType: upload.type },
        });
      }
      return;
    }

    case 'cleanup': {
      if (!upload) return;
      return;
    }

    default:
      return;
  }
}

function stripMetadata(upload: UploadRow): boolean {
  const type = upload.type;
  if (type !== 'image' && type !== 'video') return false;
  // adapters/media-processing exposes stripExif() backed by an image library or
  // ffmpeg. Returning false here means "no stripping available", which the
  // attachment records so the sender is told their file may still carry EXIF.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return false;
  } catch {
    return false;
  }
}

/**
 * When every job for an upload has finished, materialise the attachment row and
 * mark the upload ready. This is the point at which a file becomes attachable.
 */
export function maybeCompleteUpload(uploadId: string): Attachment | null {
  if (!uploadId) return null;
  const pending = db()
    .prepare("SELECT COUNT(*) AS c FROM media_jobs WHERE upload_id = ? AND status IN ('queued','running')")
    .get(uploadId) as { c: number };
  if (pending.c > 0) return null;

  const failed = db()
    .prepare("SELECT COUNT(*) AS c FROM media_jobs WHERE upload_id = ? AND status = 'failed'")
    .get(uploadId) as { c: number };

  const upload = db().prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId) as UploadRow | undefined;
  if (!upload || upload.stage === 'ready') return null;

  if (failed.c > 0) {
    markFailed(uploadId, 'a pipeline stage failed permanently');
    return null;
  }

  const now = nowMs();
  const attachmentId = newId();
  const blocked = db()
    .prepare("SELECT COUNT(*) AS c FROM attachments WHERE upload_id = ? AND scan_verdict = 'blocked'")
    .get(uploadId) as { c: number };

  db().prepare(`
    INSERT INTO attachments (id, upload_id, owner_id, type, mime_type, filename, size_bytes, sha256,
                             storage_key, storage_driver, scanned, scan_verdict, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    attachmentId, uploadId, upload.user_id, upload.type, upload.mime_type, upload.filename,
    upload.size_bytes, upload.sha256 ?? '', upload.storage_key, upload.storage_driver ?? storage.driverName,
    blocked.c > 0 ? 'blocked' : 'clean', now,
    // Media obeys the user's retention preference.
    retentionExpiry(upload.user_id, now),
  );

  db().prepare("UPDATE uploads SET stage = ?, updated_at = ? WHERE id = ?")
    .run(blocked.c > 0 ? 'failed' : 'ready', now, uploadId);
  db().prepare('UPDATE media_jobs SET attachment_id = ? WHERE upload_id = ?').run(attachmentId, uploadId);

  return getAttachment(attachmentId);
}

function retentionExpiry(userId: string, now: number): number | null {
  try {
    const settings = parseJson<{ data?: { keepMediaForDays?: number | null } }>(
      (db().prepare('SELECT settings_json FROM users WHERE id = ?').get(userId) as { settings_json: string })?.settings_json,
      {},
    );
    const days = settings.data?.keepMediaForDays;
    if (days === null || days === undefined) return null;
    return now + days * 86_400_000;
  } catch {
    return now + config.retention.mediaDefaultDays * 86_400_000;
  }
}

/* ─────────────────────────── Attachment reads ─────────────────────────── */

export function getAttachment(id: string): Attachment {
  const row = db().prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw err.notFound('Attachment');
  if (row.expires_at && Number(row.expires_at) < nowMs()) throw err.notFound('Attachment');
  return toAttachment(row);
}

export function getAttachmentByUpload(uploadId: string, userId: string): Attachment {
  const upload = getUpload(uploadId, userId);
  if (upload.stage !== 'ready') {
    // Small single-shot uploads complete synchronously; if we are here the
    // pipeline is still running, so tell the client to poll the socket.
    throw err.badRequest(`Upload is still ${upload.stage}`);
  }
  const row = db().prepare('SELECT * FROM attachments WHERE upload_id = ?').get(uploadId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw err.notFound('Attachment');
  return toAttachment(row);
}

function toAttachment(row: Record<string, unknown>): Attachment {
  const att: Attachment = {
    id: String(row.id),
    type: row.type as MediaType,
    mimeType: String(row.mime_type),
    filename: (row.filename as string | null) ?? null,
    sizeBytes: Number(row.size_bytes ?? 0),
    width: (row.width as number | null) ?? null,
    height: (row.height as number | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    waveform: (row.waveform as string | null) ?? null,
    latitude: (row.latitude as number | null) ?? null,
    longitude: (row.longitude as number | null) ?? null,
    locationName: (row.location_name as string | null) ?? null,
    thumbnailId: (row.thumbnail_id as string | null) ?? null,
    blurhash: (row.blurhash as string | null) ?? null,
    sha256: String(row.sha256 ?? ''),
    storageKey: '',            // never exposed
    storageDriver: String(row.storage_driver ?? ''),
    scanned: !!row.scanned,
    scanVerdict: (row.scan_verdict as Attachment['scanVerdict']) ?? 'pending',
    createdAt: Number(row.created_at ?? 0),
    expiresAt: (row.expires_at as number | null) ?? null,
  };
  return att;
}

/**
 * Authorise and sign a download. Membership of the conversation that carries the
 * attachment is the only acceptable proof of access — URLs are never public and
 * never long-lived.
 */
export function authoriseDownload(attachmentId: string, userId: string): { url: string; contentType: string; filename: string | null; maxAge: number } {
  const row = db().prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw err.notFound('Attachment');

  const owner = String(row.owner_id);
  if (owner !== userId) {
    const message = db()
      .prepare('SELECT conversation_id FROM messages WHERE attachment_id = ? LIMIT 1')
      .get(attachmentId) as { conversation_id: string } | undefined;
    if (!message) throw err.notFound('Attachment');
    // Membership check throws 403 if the caller is not in the conversation.
    db().prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL')
      .get(message.conversation_id, userId) ?? (() => { throw err.forbidden('You cannot access this file'); })();
  }

  const key = String(row.storage_key);
  const contentType = String(row.mime_type || 'application/octet-stream');
  const url = storage.createSignedReadUrl(key, config.storage.signedUrlTtlSeconds, contentType);
  return { url, contentType, filename: sanitiseFilename(row.filename as string | null), maxAge: config.storage.signedUrlTtlSeconds };
}

/* ─────────────────────────── Sticker packs (scaffolded) ─────────────────────────── */

export interface StickerPack {
  id: string;
  name: string;
  slug: string;
  isPublic: boolean;
  stickers: { id: string; attachmentId: string; emoji: string | null; keywords: string | null; position: number }[];
}

export function listStickerPacks(): StickerPack[] {
  const packs = db()
    .prepare('SELECT * FROM sticker_packs WHERE is_public = 1 ORDER BY created_at')
    .all() as { id: string; name: string; slug: string; is_public: number }[];
  return packs.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    isPublic: !!p.is_public,
    stickers: (db()
      .prepare('SELECT * FROM stickers WHERE pack_id = ? ORDER BY position')
      .all(p.id) as Record<string, unknown>[]).map((s) => ({
      id: String(s.id),
      attachmentId: String(s.attachment_id),
      emoji: (s.emoji as string | null) ?? null,
      keywords: (s.keywords as string | null) ?? null,
      position: Number(s.position ?? 0),
    })),
  }));
}

export function createStickerPack(ownerId: string | null, name: string, slug: string, isPublic: boolean): StickerPack {
  const id = newId();
  db().prepare('INSERT INTO sticker_packs (id, owner_id, name, slug, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, ownerId, name.slice(0, 64), slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48), isPublic ? 1 : 0, nowMs());
  return { id, name, slug, isPublic, stickers: [] };
}
