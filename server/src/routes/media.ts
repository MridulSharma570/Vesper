/**
 * /media — upload grants, chunked transfer, downloads, stickers.
 *
 * Upload flow: request a grant → send chunks in order (or PUT straight to object
 * storage when the driver supports presigning) → the server finalises, hashes
 * and queues processing jobs → the attachment becomes `ready` once no job is
 * outstanding.
 *
 * Downloads are authorised per request and served through a short-lived signed
 * URL, so the API server is not on the data path for large videos. Blobs are
 * never public and never at a predictable path, and `NEVER_INLINE` types (html,
 * svg, js) are forced to `attachment` disposition so a stored file cannot
 * execute in the browser's origin.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MediaType } from '../../../shared/types.js';
import {
  MEDIA_POLICY, appendChunk, authoriseDownload, createStickerPack, getAttachment,
  getAttachmentByUpload, getUpload, listStickerPacks, maybeCompleteUpload, requestUpload,
  uploadSingle,
} from '../services/media.js';
import { NEVER_INLINE, storage } from '../adapters/storage/index.js';
import { featureFlags } from '../config.js';
import { err } from '../services/users.js';
import { audit } from '../services/audit.js';
import { noStore, rateLimitConfig, requireAuth, requireRole } from '../middleware/index.js';

const MEDIA_TYPES = Object.keys(MEDIA_POLICY) as MediaType[];
const mediaTypeSchema = z.enum(MEDIA_TYPES as unknown as [MediaType, ...MediaType[]]);

const grantSchema = z.object({
  type: mediaTypeSchema,
  mimeType: z.string().min(3).max(128),
  sizeBytes: z.number().int().min(1).max(4 * 1024 * 1024 * 1024),
  filename: z.string().max(255).nullish(),
  conversationId: z.string().min(8).max(64).nullish(),
  chunks: z.number().int().min(1).max(100_000).nullish(),
}).strict();

const idSchema = z.object({ id: z.string().min(8).max(64) });

export function mediaRoutes(app: FastifyInstance): void {
  /** What this server currently accepts. The client gates its UI on this. */
  app.get('/media/policy', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    requireAuth(req);
    const flags = featureFlags();
    const policy = Object.fromEntries(
      MEDIA_TYPES.map((type) => [
        type,
        {
          enabled: flags.mediaPipeline && flags.allowedMediaTypes.includes(type),
          maxBytes: Math.min(MEDIA_POLICY[type].maxBytes, flags.maxUploadMb * 1024 * 1024),
          mime: MEDIA_POLICY[type].mime,
        },
      ]),
    );
    return reply.send({ pipelineEnabled: flags.mediaPipeline, allowedTypes: flags.allowedMediaTypes, policy });
  });

  /* ── Upload ──────────────────────────────────────────────────── */

  app.post('/media/uploads', { config: { rateLimit: rateLimitConfig('upload') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const input = grantSchema.parse(await req.body);
    const grant = requestUpload(auth.userId, {
      type: input.type,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      filename: input.filename ?? null,
      conversationId: input.conversationId ?? null,
      chunks: input.chunks ?? null,
    });
    return reply.status(201).send({ grant });
  });

  app.get('/media/uploads/:id', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = idSchema.parse(req.params);
    return { upload: serialiseUpload(getUpload(id, auth.userId)) };
  });

  /**
   * Append one chunk. Order is enforced because the final hash depends on byte
   * order; a client that skipped ahead would produce a corrupt object. The
   * service finalises and starts the pipeline automatically on the last chunk.
   */
  app.put('/media/uploads/:id/chunks/:index', {
    config: { rateLimit: rateLimitConfig('upload') },
    bodyLimit: 8 * 1024 * 1024,
  }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id, index } = z.object({
      id: z.string().min(8).max(64),
      index: z.coerce.number().int().min(0).max(100_000),
    }).parse(req.params);

    const body = req.body;
    if (!Buffer.isBuffer(body)) throw err.badRequest('Chunk body must be raw bytes');
    if (!body.length) throw err.badRequest('Chunk is empty');

    const progress = appendChunk(id, auth.userId, index, body);
    const upload = getUpload(id, auth.userId);
    const done = upload.stage !== 'uploading' && upload.stage !== 'requested';

    return reply.send({
      ...progress,
      receivedBytes: upload.size_bytes,
      totalBytes: upload.declared_bytes,
      complete: done,
      // The attachment exists once the pipeline has produced one; otherwise the
      // client polls the upload until `stage` reaches `ready`.
      attachment: done && upload.stage === 'ready' ? tryAttachment(id, auth.userId) : null,
    });
  });

  /** Single-request upload for small files: stickers, voice notes, locations, contact cards. */
  app.post('/media/uploads/single', {
    config: { rateLimit: rateLimitConfig('upload') },
    bodyLimit: 32 * 1024 * 1024,
  }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const q = req.query as { type?: string; mimeType?: string; filename?: string; conversationId?: string };
    const type = mediaTypeSchema.parse(q.type);
    const mimeType = (q.mimeType ?? 'application/octet-stream').slice(0, 128);

    const body = req.body;
    if (!Buffer.isBuffer(body)) throw err.badRequest('Body must be raw bytes');
    if (!body.length) throw err.badRequest('Body is empty');

    const attachment = uploadSingle(auth.userId, {
      type,
      mimeType,
      filename: q.filename ? sanitise(q.filename) : null,
      conversationId: q.conversationId ?? null,
    }, body);
    return reply.status(201).send({ attachment });
  });

  /**
   * Direct-to-storage completion. The client PUTs bytes to the presigned URL and
   * then calls this so the server can verify the object arrived before starting
   * the pipeline. Nothing about the upload is trusted from the client.
   */
  app.post('/media/uploads/:id/finalise', { config: { rateLimit: rateLimitConfig('upload') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = idSchema.parse(req.params);
    const upload = getUpload(id, auth.userId);
    if (!upload.storage_key) throw err.badRequest('That upload has no storage object');

    if (!storage.exists(upload.storage_key)) {
      throw err.badRequest('The upload did not reach storage', 'upload_missing');
    }
    const stored = storage.size(upload.storage_key);
    if (stored !== upload.declared_bytes) {
      throw err.badRequest(
        `Storage reports ${stored} bytes but the grant was for ${upload.declared_bytes}`,
        'size_mismatch',
      );
    }

    const attachment = maybeCompleteUpload(id);
    return reply.send({ upload: serialiseUpload(getUpload(id, auth.userId)), attachment });
  });

  /* ── Download ────────────────────────────────────────────────── */

  /**
   * Authorised download. Returns a 302 to a signed URL when the driver can sign
   * (S3/R2/GCS), otherwise streams through the API. Either way the caller must
   * be the owner or a member of a conversation carrying the attachment.
   */
  app.get('/media/attachments/:id/download', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = idSchema.parse(req.params);
    const authorised = authoriseDownload(id, auth.userId);
    const baseType = authorised.contentType.split(';')[0]!.toLowerCase();
    const inline = !NEVER_INLINE.has(baseType);

    if (/^https?:\/\//.test(authorised.url)) {
      return reply.redirect(302, authorised.url);
    }

    // Local driver: the signed "url" is an internal key we stream ourselves.
    const bytes = storage.read(authorised.url.replace(/^local:\/\//, '').replace(/^file:\/\//, ''));
    if (!bytes) throw err.notFound('That file is no longer stored');
    const filename = authorised.filename?.replace(/["\r\n]/g, '') ?? null;
    void reply
      .header('Content-Type', authorised.contentType)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}${filename ? `; filename="${filename}"` : ''}`)
      .header('Cache-Control', `private, max-age=${authorised.maxAge}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Length', String(bytes.length));
    return reply.send(bytes);
  });

  app.get('/media/attachments/:id', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = idSchema.parse(req.params);
    // Authorising first means a non-member cannot even learn the metadata.
    authoriseDownload(id, auth.userId);
    return { attachment: getAttachment(id) };
  });

  app.get('/media/uploads/:id/attachment', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = idSchema.parse(req.params);
    return { attachment: getAttachmentByUpload(id, auth.userId) };
  });

  /* ── Stickers ────────────────────────────────────────────────── */

  app.get('/media/stickers/packs', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    requireAuth(req);
    return reply.send({ packs: listStickerPacks() });
  });

  app.post('/media/stickers/packs', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'moderator');
    const body = z.object({
      name: z.string().min(2).max(48),
      slug: z.string().min(2).max(48).regex(/^[a-z0-9-]+$/),
      isPublic: z.boolean().default(true),
    }).strict().parse(await req.body);
    const pack = createStickerPack(auth.userId, body.name, body.slug, body.isPublic);
    audit({
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'media.sticker_pack_created',
      target: { type: 'sticker_pack', id: pack.id },
    });
    return reply.status(201).send({ pack });
  });
}

function tryAttachment(uploadId: string, userId: string) {
  try {
    return getAttachmentByUpload(uploadId, userId);
  } catch {
    return null;
  }
}

function sanitise(name: string): string {
  return name.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180) || 'file';
}

function serialiseUpload(upload: {
  id: string; type: MediaType; mime_type: string; filename: string | null;
  size_bytes: number; declared_bytes: number; chunk_size: number; total_chunks: number | null;
  received_chunks: number; mode: 'api' | 'presigned'; stage: string; error: string | null; expires_at: number;
}) {
  return {
    id: upload.id,
    type: upload.type,
    mimeType: upload.mime_type,
    filename: upload.filename,
    receivedBytes: upload.size_bytes,
    totalBytes: upload.declared_bytes,
    chunkSize: upload.chunk_size,
    totalChunks: upload.total_chunks,
    receivedChunks: upload.received_chunks,
    nextChunk: upload.received_chunks,
    mode: upload.mode,
    stage: upload.stage,
    error: upload.error,
    expiresAt: upload.expires_at,
  };
}
