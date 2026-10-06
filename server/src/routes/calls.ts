/**
 * /calls — starting, joining and inspecting calls over HTTP.
 *
 * The media negotiation itself happens on the WebSocket (SDP and ICE must not
 * wait for a request/response cycle), but call *creation* is an HTTP action: it
 * has to succeed reliably, return a room the client can render, and be auditable.
 *
 * Everything is behind the `calls` feature flag, so the whole surface can be
 * switched on later without a client release.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClientMediaCapabilities } from '../../../shared/types.js';
import {
  callPrivacyNotice, defaultCapabilities, endCall, joinCall, leaveCall, listActiveCalls,
  listCallHistory, loadRoom, setMute, startCall,
} from '../services/calls.js';
import { callAdaptersStatus } from '../adapters/calls/index.js';
import { featureFlags } from '../config.js';
import { err, getUser } from '../services/users.js';
import { sendToUser } from '../realtime/hub.js';
import { listMemberIds } from '../services/conversations.js';
import { notify } from '../services/notifications.js';
import { noStore, rateLimitConfig, requireAuth, requireRole } from '../middleware/index.js';

const capabilitiesSchema = z.object({
  audioIn: z.boolean().default(true),
  audioOut: z.boolean().default(true),
  videoIn: z.boolean().default(true),
  videoOut: z.boolean().default(true),
  screenShare: z.boolean().default(false),
  maxVideoWidth: z.number().int().min(160).max(7680).default(1280),
  maxVideoHeight: z.number().int().min(120).max(4320).default(720),
  maxBitrateKbps: z.number().int().min(32).max(20_000).default(1500),
  codecs: z.array(z.string().max(32)).max(16).default(['opus', 'vp8', 'h264']),
  platform: z.enum(['web', 'android', 'ios', 'windows', 'macos', 'linux', 'unknown']).default('web'),
});

const startSchema = z.object({
  conversationId: z.string().min(8).max(64),
  video: z.boolean().default(false),
  scheduledFor: z.number().int().min(0).nullish(),
  capabilities: capabilitiesSchema.optional(),
  deviceId: z.string().max(128).optional(),
}).strict();

export function callRoutes(app: FastifyInstance): void {
  /**
   * What calling looks like on this server right now. The client uses this to
   * decide whether to render call buttons at all, so a disabled flag means no
   * dead UI rather than a button that errors.
   */
  app.get('/calls/config', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    requireAuth(req);
    const flags = featureFlags();
    return reply.send({
      enabled: flags.calls,
      kinds: flags.allowedCallKinds,
      maxParticipants: flags.maxCallParticipants,
      adapters: callAdaptersStatus(),
    });
  });

  app.get('/calls/active', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    return { calls: listActiveCalls(auth.userId) };
  });

  /**
   * Start a call. Rings every other member of the conversation and returns the
   * room plus an adapter-specific join token for the caller.
   */
  app.post('/calls', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const body = startSchema.parse(await req.body);

    const result = await startCall({
      conversationId: body.conversationId,
      callerId: auth.userId,
      video: body.video,
      scheduledFor: body.scheduledFor ?? null,
      capabilities: (body.capabilities as ClientMediaCapabilities) ?? defaultCapabilities(auth.device.platform),
      deviceId: body.deviceId ?? auth.device.deviceId,
    });

    // Ring every invitee over the socket, and push those who are offline. An
    // incoming call is the one notification that must wake a sleeping device, so
    // it bypasses the normal message-notification settings.
    const caller = getUser(auth.userId);
    for (const invitee of result.invitees) {
      for (const signal of result.signals.filter((s) => s.to === invitee)) {
        sendToUser(invitee, signal.frame);
      }
      notify({
        userId: invitee,
        kind: 'call',
        title: `Incoming ${body.video ? 'video' : 'voice'} call`,
        body: `@${caller.handle}`,
        conversationId: body.conversationId,
        force: true,
        data: { callId: result.room.id, video: !!body.video },
      });
    }

    return reply.status(201).send({
      room: result.room,
      invitees: result.invitees,
      privacy: callPrivacyNotice(result.room.topology),
    });
  });

  app.get('/calls/:id', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    const room = loadRoom(id, auth.userId);
    return { room, privacy: callPrivacyNotice(room.topology) };
  });

  /**
   * Join an in-progress call. Issues a fresh media token for this participant —
   * tokens are per-user so revoking one person cannot cut off the room.
   */
  app.post('/calls/:id/join', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    const body = z.object({
      deviceId: z.string().max(128).optional(),
      capabilities: capabilitiesSchema.optional(),
    }).parse(await req.body ?? {});

    const room = await joinCall(
      id,
      auth.userId,
      body.deviceId ?? auth.device.deviceId,
      (body.capabilities as ClientMediaCapabilities) ?? defaultCapabilities(auth.device.platform),
    );

    // Everyone else learns the roster changed.
    for (const uid of listMemberIds(room.conversationId)) {
      if (uid === auth.userId) continue;
      sendToUser(uid, { t: 'call.participants', callId: id, participants: room.participants });
      sendToUser(uid, { t: 'call.state', callId: id, state: room.state, room });
    }
    return reply.send({ room, privacy: callPrivacyNotice(room.topology) });
  });

  app.post('/calls/:id/leave', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    const { ended } = leaveCall(id, auth.userId);
    return reply.send({ ok: true, ended });
  });

  app.post('/calls/:id/decline', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    const body = z.object({ reason: z.string().max(32).optional() }).parse(await req.body ?? {});
    const { declineCall } = await import('../services/calls.js');
    declineCall(id, auth.userId, body.reason);
    return reply.send({ ok: true });
  });

  app.post('/calls/:id/end', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    endCall(id, auth.userId, 'ended_by_participant');
    const row = loadRoom(id, auth.userId);
    for (const uid of listMemberIds(row.conversationId)) {
      if (uid === auth.userId) continue;
      sendToUser(uid, { t: 'call.state', callId: id, state: 'ended' });
    }
    return reply.send({ ok: true });
  });

  app.patch('/calls/:id/mute', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    const body = z.object({ audio: z.boolean().optional(), video: z.boolean().optional() }).strict().parse(await req.body);
    const room = setMute(id, auth.userId, body.audio, body.video);
    for (const uid of listMemberIds(room.conversationId)) {
      if (uid === auth.userId) continue;
      sendToUser(uid, { t: 'call.participants', callId: id, participants: room.participants });
    }
    return reply.send({ room });
  });

  app.get('/conversations/:id/calls', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    noStore(reply);
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    const q = req.query as { limit?: string };
    return { calls: listCallHistory(id, auth.userId, Math.min(Number(q.limit ?? 30) || 30, 100)) };
  });

  /**
   * Force-end a call. Staff only — used when a call is stuck (a client died
   * without sending `leave`) or when a moderator has to break up a room.
   */
  app.post('/calls/:id/admin-end', { config: { rateLimit: rateLimitConfig('admin') } }, async (req, reply) => {
    const auth = requireRole(req, 'moderator');
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    const body = z.object({ reason: z.string().max(200).optional() }).parse(await req.body ?? {});
    let room;
    try {
      room = loadRoom(id, auth.userId);
    } catch {
      throw err.notFound('Call');
    }
    endCall(id, auth.userId, body.reason ?? 'ended_by_staff');
    for (const uid of listMemberIds(room.conversationId)) {
      sendToUser(uid, { t: 'call.state', callId: id, state: 'ended' });
    }
    return reply.send({ ok: true });
  });
}
