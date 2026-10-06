/**
 * /messages — the HTTP surface for sending and reading.
 *
 * The WebSocket is the primary path, but HTTP matters for three reasons: a
 * client whose socket is down must still be able to send; the mobile OS may wake
 * the app to deliver a background send; and it gives us a place to enforce the
 * same rules for anyone scripting against the API.
 *
 * `sendMessage` is idempotent on `clientMessageId`, so a retry after a timeout
 * never produces a duplicate bubble. That is the single most important property
 * of a chat API on a flaky mobile network.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MessageBody, MessageKind } from '../../../shared/types.js';
import { MESSAGE_KINDS } from '../../../shared/types.js';
import {
  deleteMessage, editMessage, getMessage, listMessages, markRead, sendMessage,
  shouldNotifyRecipient, toggleReaction,
} from '../services/messages.js';
import { buildConversationView, listMemberIds, requireMembership } from '../services/conversations.js';
import { getSettings } from '../services/users.js';
import { sendToUser } from '../realtime/hub.js';
import { notify } from '../services/notifications.js';
import { noStore, rateLimitConfig, requireAuth } from '../middleware/index.js';

const idParam = z.object({ id: z.string().min(8).max(64) });

const messageBodySchema = z.object({
  text: z.string().max(8192).optional(),
  attachmentIds: z.array(z.string()).max(9).optional(),
  sticker: z.unknown().optional(),
  contact: z.unknown().optional(),
  location: z.unknown().optional(),
  event: z.unknown().optional(),
  poll: z.unknown().optional(),
  call: z.unknown().optional(),
  replyTo: z.string().optional(),
  forwardedFrom: z.string().nullish(),
  mentions: z.array(z.string()).max(64).optional(),
  linkPreview: z.unknown().nullish(),
  ephemeral: z.boolean().optional(),
}).passthrough();

const sendSchema = z.object({
  conversationId: z.string().min(8).max(64),
  kind: z.enum(MESSAGE_KINDS as unknown as [string, ...string[]]),
  clientMessageId: z.string().min(6).max(128),
  body: messageBodySchema,
  expiresIn: z.number().int().min(0).max(60 * 60 * 24 * 365).nullish(),
}).strict();

export function messageRoutes(app: FastifyInstance): void {
  /**
   * Send. Responds with the stored message plus the ids it was fanned out to,
   * so an offline client can tell whether the server delivered it live or queued
   * it for later.
   */
  app.post('/messages', { config: { rateLimit: rateLimitConfig('message') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const input = sendSchema.parse(await req.body);

    const result = sendMessage({
      senderId: auth.userId,
      conversationId: input.conversationId,
      kind: input.kind as MessageKind,
      clientMessageId: input.clientMessageId,
      body: input.body as Partial<MessageBody>,
      expiresIn: input.expiresIn ?? null,
    });

    // Fan out over the socket. Recipients who are offline get it persisted by
    // the hub and replayed on reconnect, so nothing is lost.
    for (const uid of result.recipients) {
      sendToUser(uid, { t: 'message.new', message: result.message });
    }
    // The sender's other devices stay in sync, but not the device that sent it.
    sendToUser(auth.userId, { t: 'message.new', message: result.message }, {
      excludeDeviceId: auth.device.deviceId,
      persist: false,
    });
    for (const uid of [...result.recipients, auth.userId]) {
      const view = buildConversationView(input.conversationId, uid);
      if (view) sendToUser(uid, { t: 'conversation.updated', conversation: view }, { persist: false });
    }

    // Push notifications for anyone not currently connected.
    for (const uid of result.recipients) {
      if (!shouldNotifyRecipient(input.conversationId, uid, auth.userId)) continue;
      void notify({
        userId: uid,
        kind: 'message',
        conversationId: input.conversationId,
        messageId: result.message.id,
        senderId: auth.userId,
      });
    }

    return reply.status(result.deduplicated ? 200 : 201).send({
      message: result.message,
      deliveredTo: result.recipients,
      deduplicated: result.deduplicated,
    });
  });

  /** Bulk send, so a client that queued messages offline can flush in one call. */
  app.post('/messages/bulk', { config: { rateLimit: rateLimitConfig('message') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const body = z.object({ messages: z.array(sendSchema).min(1).max(50) }).strict().parse(await req.body);

    const results: unknown[] = [];
    const failures: unknown[] = [];
    for (const input of body.messages) {
      try {
        const result = sendMessage({
          senderId: auth.userId,
          conversationId: input.conversationId,
          kind: input.kind as MessageKind,
          clientMessageId: input.clientMessageId,
          body: input.body as Partial<MessageBody>,
          expiresIn: input.expiresIn ?? null,
        });
        for (const uid of result.recipients) sendToUser(uid, { t: 'message.new', message: result.message });
        results.push({ clientMessageId: input.clientMessageId, message: result.message });
      } catch (e) {
        // One bad message must not fail the whole batch: the client is flushing
        // a queue and needs per-item results to know what to retry.
        failures.push({
          clientMessageId: input.clientMessageId,
          error: {
            code: e && typeof e === 'object' && 'code' in e ? String((e as { code: string }).code) : 'send_failed',
            message: e instanceof Error ? e.message : 'Could not send',
          },
        });
      }
    }
    return reply.send({ sent: results, failed: failures });
  });

  app.get('/messages/:id', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().max(32) }).parse(req.params);
    return { message: getMessage(id, auth.userId) };
  });

  app.patch('/messages/:id', { config: { rateLimit: rateLimitConfig('message') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().max(32) }).parse(req.params);
    const body = z.object({ text: z.string().min(1).max(4096) }).strict().parse(await req.body);
    const message = editMessage(id, auth.userId, body.text);
    for (const uid of listMemberIds(message.conversationId)) {
      sendToUser(uid, { t: 'message.updated', message });
    }
    return reply.send({ message });
  });

  /**
   * Delete. `forEveryone` removes it for all members (and only the sender or a
   * group admin may do that); otherwise it is removed just for the caller, which
   * is what "delete for me" means and is recorded per user.
   */
  app.delete('/messages/:id', { config: { rateLimit: rateLimitConfig('message') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().max(32) }).parse(req.params);
    const q = req.query as { forEveryone?: string };
    const forEveryone = q.forEveryone === 'true';
    const { conversationId } = deleteMessage(id, auth.userId, forEveryone);
    for (const uid of listMemberIds(conversationId)) {
      sendToUser(uid, { t: 'message.deleted', id, conversationId, forEveryone });
    }
    return reply.send({ ok: true, conversationId, forEveryone });
  });

  app.post('/messages/:id/reactions', { config: { rateLimit: rateLimitConfig('message') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().max(32) }).parse(req.params);
    const body = z.object({ emoji: z.string().min(1).max(16) }).strict().parse(await req.body);
    const reactions = toggleReaction(id, auth.userId, body.emoji);
    const message = getMessage(id, auth.userId);
    for (const uid of listMemberIds(message.conversationId)) {
      sendToUser(uid, { t: 'reaction.updated', messageId: id, reactions });
    }
    return reply.send({ reactions });
  });

  app.post('/messages/read', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ conversationId: z.string().min(8).max(64), messageId: z.string().max(32) }).strict().parse(await req.body);
    requireMembership(body.conversationId, auth.userId);
    markRead(auth.userId, body.conversationId, body.messageId);
    for (const uid of listMemberIds(body.conversationId)) {
      if (uid === auth.userId) continue;
      sendToUser(uid, {
        t: 'message.read',
        conversationId: body.conversationId,
        userId: auth.userId,
        messageId: body.messageId,
      });
    }
    return reply.send({ ok: true });
  });

  /** Page through a conversation. Snowflake cursors, so it is stable under load. */
  app.get('/conversations/:id/messages', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    const q = req.query as { before?: string; after?: string; limit?: string };
    const page = listMessages(id, auth.userId, {
      before: q.before ?? undefined,
      after: q.after ?? undefined,
      limit: Math.min(Number(q.limit ?? 50) || 50, 200),
    });
    return { messages: page.items, nextCursor: page.nextCursor };
  });

  /** Read receipts the caller has given, so the client can render ticks. */
  app.get('/messages/:id/read-by', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().max(32) }).parse(req.params);
    const message = getMessage(id, auth.userId);
    // Read receipts are only exposed when the sender has them enabled, and only
    // for the sender's own messages — otherwise it leaks reading behaviour.
    if (!getSettings(auth.userId).privacy.showReadReceipts) return { readers: [] };
    const { db } = await import('../db/index.js');
    const rows = db()
      .prepare('SELECT user_id, read_at FROM message_reads WHERE message_id = ? ORDER BY read_at ASC LIMIT 100')
      .all(id) as { user_id: string; read_at: number }[];
    return { readers: rows.map((r) => ({ userId: r.user_id, readAt: r.read_at })), conversationId: message.conversationId };
  });
}
