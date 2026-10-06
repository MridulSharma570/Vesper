/**
 * WebSocket protocol handler.
 *
 * Handshake
 *   `GET /realtime?ticket=…`, or `Sec-WebSocket-Protocol: vesper.v1, <ticket>`
 *   for browsers that cannot set a query string on a socket. The ticket is a
 *   60-second JWT minted by `POST /auth/realtime-ticket` while the access token
 *   is still valid, so socket auth is separate from HTTP auth and a ticket
 *   leaked in a proxy log is worthless a minute later.
 *
 *   The socket then completes with a `hello` frame and receives `ready`, which
 *   carries a `resumeToken`. A client that reconnects within the resume window
 *   sends that token back and gets its queued frames replayed instead of a full
 *   resync — that is what makes a mobile network handover invisible.
 *
 * Frames are exactly the `ClientFrame` / `ServerFrame` unions in shared/types.ts.
 * No frame type exists here that is not in that contract, so the client and the
 * server cannot drift apart.
 *
 * The server is a thin router: all state changes happen in the services, which
 * means the HTTP and WebSocket surfaces behave identically.
 */
import type { FastifyInstance } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { ClientFrame, PresenceEvent, ServerFrame } from '../../../shared/types.js';
import { db, nowMs } from '../db/index.js';
import { newId, newToken } from '../lib/ids.js';
import { verifyRealtimeTicket } from '../services/tokens.js';
import { getFlags } from '../services/features.js';
import { getSettings, getUser } from '../services/users.js';
import { buildConversationView, listConversations, listMemberIds, requireMembership } from '../services/conversations.js';
import {
  deleteMessage, editMessage, listMessages, markRead, sendMessage, toggleReaction,
} from '../services/messages.js';
import { loadRoom, relaySignal } from '../services/calls.js';
import { audit } from '../services/audit.js';
import {
  MAX_MESSAGE_BYTES, isOnline, register, replayQueue, sendToUser, unregister,
  type Connection,
} from './hub.js';

const HEARTBEAT_MS = 25_000;
const MAX_FRAMES_PER_MINUTE = 240;
const RESUME_TTL_MS = 90_000;

interface SocketState {
  conn: Connection | null;
  userId: string | null;
  sessionId: string | null;
  deviceId: string;
  platform: string;
  helloSeen: boolean;
  rate: { count: number; windowStart: number };
  closed: boolean;
  subscribed: Set<string>;
}

/** Resume tokens, so a reconnecting client can pick up where it left off. */
const resumeTokens = new Map<string, { userId: string; deviceId: string; issuedAt: number }>();

export function registerRealtimeRoutes(app: FastifyInstance): void {
  app.get('/realtime', { websocket: true }, (connection: SocketStream, req) => {
    const socket: WebSocket = connection.socket;
    const url = new URL(req.url ?? '/realtime', 'http://internal');
    const state: SocketState = {
      conn: null,
      userId: null,
      sessionId: null,
      deviceId: 'unknown',
      platform: url.searchParams.get('platform') ?? 'unknown',
      helloSeen: false,
      rate: { count: 0, windowStart: nowMs() },
      closed: false,
      subscribed: new Set(),
    };

    // Browsers cannot set headers on a WebSocket, so the ticket may arrive as a
    // query parameter or as a subprotocol token.
    const proto = req.headers['sec-websocket-protocol'];
    const protoList = Array.isArray(proto) ? proto : String(proto ?? '').split(',').map((s) => s.trim());
    const fromProto = protoList.find((p) => p.length > 20 && !p.startsWith('vesper.'));
    const ticket = url.searchParams.get('ticket') ?? fromProto ?? '';

    if (!ticket) {
      safeClose(socket, 4401, 'missing_ticket');
      return;
    }

    let claims: { userId: string; sessionId: string; deviceId: string };
    try {
      claims = verifyRealtimeTicket(ticket);
    } catch {
      safeClose(socket, 4401, 'invalid_ticket');
      return;
    }

    let user: { role: string; status: string };
    try {
      const row = db().prepare('SELECT role, status FROM users WHERE id = ?').get(claims.userId) as
        | { role: string; status: string }
        | undefined;
      if (!row || row.status === 'deleted') {
        safeClose(socket, 4403, 'unknown_account');
        return;
      }
      user = row;
    } catch {
      safeClose(socket, 1011, 'db_unavailable');
      return;
    }

    // Maintenance mode is enforced at the socket layer too, so a half-open
    // client cannot keep chatting during an outage.
    const staff = ['admin', 'owner', 'developer', 'controller'].includes(user.role);
    if (getFlags().maintenance && !staff) {
      safeClose(socket, 4503, 'maintenance');
      return;
    }
    if (user.status === 'suspended') {
      safeClose(socket, 4403, 'account_suspended');
      return;
    }

    state.userId = claims.userId;
    state.sessionId = claims.sessionId;
    state.deviceId = claims.deviceId || newId();

    const conn: Connection = {
      id: newId(),
      userId: claims.userId,
      sessionId: claims.sessionId,
      deviceId: state.deviceId,
      platform: state.platform,
      socket: {
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        readyState: socket.readyState,
      },
      connectedAt: nowMs(),
      lastPingAt: nowMs(),
      queue: 0,
    };
    state.conn = conn;
    register(conn);

    socket.on('message', (raw: Buffer | string) => {
      if (state.closed || !state.userId) return;
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (text.length > MAX_MESSAGE_BYTES) {
        send(socket, { t: 'error', code: 'payload_too_large', message: 'That frame is too large' });
        return;
      }

      // A cheap per-minute budget is enough to stop one runaway client from
      // turning a single socket into a denial of service.
      const now = nowMs();
      if (now - state.rate.windowStart > 60_000) state.rate = { count: 0, windowStart: now };
      if (++state.rate.count > MAX_FRAMES_PER_MINUTE) {
        send(socket, { t: 'error', code: 'rate_limited', message: 'Slow down — too many frames per minute' });
        safeClose(socket, 1008, 'rate_limited');
        return;
      }

      let frame: ClientFrame;
      try {
        frame = JSON.parse(text) as ClientFrame;
      } catch {
        send(socket, { t: 'error', code: 'malformed_json', message: 'That frame is not valid JSON' });
        return;
      }

      // Everything except `hello` requires the handshake to have completed.
      if (!state.helloSeen && frame.t !== 'hello') {
        send(socket, { t: 'error', code: 'handshake_required', message: 'Send a hello frame first' });
        return;
      }
      handleFrame(socket, state, frame).catch((e) => {
        // handleFrame has its own try/catch, so reaching here means the error
        // happened outside it. Contain it rather than crash the process.
        req.log?.error({ err: e }, 'unhandled error in frame dispatch');
        send(socket, { t: 'error', code: 'internal_error', message: 'Something went wrong on our side' });
      });
    });

    socket.on('pong', guard('pong', () => {
      if (state.conn) state.conn.lastPingAt = nowMs();
    }));

    socket.on('close', guard('close', () => {
      state.closed = true;
      if (state.conn) {
        unregister(state.conn.id);
        if (state.userId) broadcastPresence(state.userId, false);
      }
    }));

    socket.on('error', guard('error', () => {
      state.closed = true;
      if (state.conn) unregister(state.conn.id);
    }));

    // Application-level heartbeat: ws ping/pong alone is not enough on mobile
    // networks, where a NAT can silently drop a half-open connection.
    const heartbeat = setInterval(() => {
      if (state.closed || socket.readyState !== 1) {
        clearInterval(heartbeat);
        return;
      }
      try { socket.ping(); } catch { clearInterval(heartbeat); }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  });
}

/* ─────────────────────────── Frame router ─────────────────────────── */

async function handleFrame(socket: WebSocket, state: SocketState, frame: ClientFrame): Promise<void> {
  const userId = state.userId!;

  try {
    switch (frame.t) {
      /* ── Handshake ───────────────────────────────────────────── */
      case 'hello': {
        state.helloSeen = true;
        state.deviceId = frame.deviceId || state.deviceId;
        state.platform = frame.platform || state.platform;

        // A valid resume token means this is a reconnect, not a fresh session.
        const resumed = frame.resumeToken ? resumeTokens.get(frame.resumeToken) : null;
        const isResume = !!resumed && resumed.userId === userId && nowMs() - resumed.issuedAt < RESUME_TTL_MS;
        if (frame.resumeToken) resumeTokens.delete(frame.resumeToken);

        const resumeToken = newToken(24);
        resumeTokens.set(resumeToken, { userId, deviceId: state.deviceId, issuedAt: nowMs() });

        send(socket, {
          t: 'ready',
          userId,
          sessionId: state.sessionId ?? '',
          resumeToken,
          serverTime: nowMs(),
          features: getFlags(),
        });

        // Catch up on anything missed while offline. On a resume the gap is
        // seconds; on a cold start it can be days, and both are handled the same
        // way because undelivered frames are persisted server-side.
        const replayed = replayQueue(userId, state.conn!.id);
        if (!isResume && replayed === 0) {
          // Cold start with nothing queued: hand over the conversation list so
          // the client can render without a second round-trip.
          const conversations = listConversations(userId, { limit: 50 });
          for (const conversation of conversations) {
            send(socket, { t: 'conversation.updated', conversation });
          }
        }

        broadcastPresence(userId, true);
        pruneResumeTokens();
        return;
      }

      case 'ping': {
        if (state.conn) state.conn.lastPingAt = nowMs();
        send(socket, { t: 'pong', ts: frame.ts, latencyMs: Math.max(0, nowMs() - frame.ts) });
        return;
      }

      /* ── Presence ────────────────────────────────────────────── */
      case 'presence.set': {
        const online = frame.state === 'online';
        db().prepare("UPDATE users SET presence = ?, last_seen_at = ?, updated_at = ? WHERE id = ?")
          .run(online ? 'online' : 'offline', nowMs(), nowMs(), userId);
        db().prepare(`
          INSERT INTO user_presence (user_id, state, last_seen_at, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at
        `).run(userId, online ? 'online' : 'offline', nowMs(), nowMs());
        broadcastPresence(userId, online);
        return;
      }

      case 'typing': {
        // Typing is ephemeral by design: it is never written to the database,
        // because storing "who was typing what, when" would be a surveillance
        // record with no product value.
        requireMembership(frame.conversationId, userId);
        const settings = getSettings(userId);
        if (!settings.privacy.showTypingIndicator) return;
        for (const uid of membersExcept(frame.conversationId, userId)) {
          sendToUser(uid, {
            t: 'typing',
            conversationId: frame.conversationId,
            userId,
            isTyping: frame.isTyping,
          });
        }
        return;
      }

      /* ── Messaging ───────────────────────────────────────────── */
      case 'message.send': {
        const result = sendMessage({
          senderId: userId,
          conversationId: frame.conversationId,
          kind: frame.kind,
          clientMessageId: frame.clientMessageId,
          body: frame.body,
          expiresIn: frame.expiresIn ?? null,
        });

        // The sending device gets `message.sent` so it can reconcile its
        // optimistic bubble against the real snowflake id. Its *other* devices
        // get `message.new`, which keeps Android and Windows in sync without
        // echoing into the view that just sent it.
        send(socket, { t: 'message.sent', clientMessageId: frame.clientMessageId, message: result.message });

        for (const uid of result.recipients) {
          sendToUser(uid, { t: 'message.new', message: result.message });
        }
        sendToUser(userId, { t: 'message.new', message: result.message }, {
          excludeDeviceId: state.deviceId,
          persist: false,
        });

        // The conversation preview changed for everybody in it.
        for (const uid of [...result.recipients, userId]) {
          const view = buildConversationView(frame.conversationId, uid);
          if (view) sendToUser(uid, { t: 'conversation.updated', conversation: view }, { persist: false });
        }
        return;
      }

      case 'message.edit': {
        const message = editMessage(frame.id, userId, frame.text);
        for (const uid of membersExcept(message.conversationId, userId)) {
          sendToUser(uid, { t: 'message.updated', message });
        }
        send(socket, { t: 'message.updated', message });
        return;
      }

      case 'message.delete': {
        const { conversationId } = deleteMessage(frame.id, userId, frame.forEveryone);
        for (const uid of membersExcept(conversationId, userId)) {
          sendToUser(uid, { t: 'message.deleted', id: frame.id, conversationId, forEveryone: frame.forEveryone });
        }
        send(socket, { t: 'message.deleted', id: frame.id, conversationId, forEveryone: frame.forEveryone });
        return;
      }

      case 'message.read': {
        markRead(userId, frame.conversationId, frame.messageId);
        for (const uid of membersExcept(frame.conversationId, userId)) {
          sendToUser(uid, { t: 'message.read', conversationId: frame.conversationId, userId, messageId: frame.messageId });
        }
        return;
      }

      case 'reaction.toggle': {
        const reactions = toggleReaction(frame.messageId, userId, frame.emoji);
        const row = db().prepare('SELECT conversation_id FROM messages WHERE id = ?').get(frame.messageId) as
          | { conversation_id: string }
          | undefined;
        const conversationId = row?.conversation_id ?? '';
        for (const uid of membersExcept(conversationId, userId)) {
          sendToUser(uid, { t: 'reaction.updated', messageId: frame.messageId, reactions });
        }
        send(socket, { t: 'reaction.updated', messageId: frame.messageId, reactions });
        return;
      }

      /* ── Conversation subscription ───────────────────────────── */
      case 'conversation.subscribe': {
        requireMembership(frame.conversationId, userId);
        state.subscribed.add(frame.conversationId);
        const view = buildConversationView(frame.conversationId, userId);
        if (view) send(socket, { t: 'conversation.updated', conversation: view });
        // Backfill recent history so an opening conversation renders instantly
        // without a separate HTTP round-trip.
        const page = listMessages(frame.conversationId, userId, { limit: 30 });
        for (const message of page.items.reverse()) {
          send(socket, { t: 'message.new', message });
        }
        return;
      }

      case 'conversation.unsubscribe': {
        state.subscribed.delete(frame.conversationId);
        return;
      }

      case 'upload.progress': {
        // Informational only. Real upload progress flows over HTTP so it works
        // even when the socket is down; this frame lets a client mirror it to
        // its other devices.
        for (const uid of membersOfUpload(frame.uploadId, userId)) {
          sendToUser(uid, {
            t: 'upload.progress',
            uploadId: frame.uploadId,
            stage: 'uploading',
            progress: frame.bytesSent,
          }, { persist: false });
        }
        return;
      }

      /* ── Calls: the full signalling relay ────────────────────── */
      case 'call.offer':
      case 'call.answer':
      case 'call.ice':
      case 'call.join':
      case 'call.leave':
      case 'call.decline':
      case 'call.cancel':
      case 'call.end':
      case 'call.mute': {
        const result = await relaySignal(userId, state.deviceId, frame);
        for (const uid of result.to) {
          sendToUser(uid, frame as ServerFrame, { excludeDeviceId: state.deviceId });
        }
        for (const generated of result.generated) {
          sendToUser(generated.to, generated.frame);
        }
        // The acting client gets authoritative room state after a transition.
        if (frame.t === 'call.answer' || frame.t === 'call.join') {
          const room = loadRoom(frame.callId, userId);
          send(socket, { t: 'call.state', callId: frame.callId, state: room.state, room });
        }
        return;
      }

      // Server→client only frames. A client sending these is a protocol error.
      case 'call.participants':
      case 'call.state':
      case 'call.ringing':
      case 'call.error': {
        send(socket, { t: 'error', code: 'unsupported_frame', message: `"${frame.t}" is sent by the server only` });
        return;
      }

      default: {
        const exhaustive: never = frame;
        send(socket, {
          t: 'error',
          code: 'unsupported_frame',
          message: `Frame type "${(exhaustive as { t: string }).t}" is not supported`,
        });
        return;
      }
    }
  } catch (e) {
    const status = e && typeof e === 'object' && 'status' in e ? Number((e as { status: number }).status) : 500;
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: string }).code) : 'internal_error';
    // Never leak internals to the client on a 5xx.
    const message = status >= 500 ? 'Something went wrong on our side' : e instanceof Error ? e.message : 'Request failed';
    if (status >= 500) {
      audit({ actorId: userId, action: 'realtime.error', severity: 'critical', meta: { code, frame: frame.t } });
    }
    send(socket, { t: 'error', code, message });
  }
}

/* ─────────────────────────── Helpers ─────────────────────────── */

function membersExcept(conversationId: string, userId: string): string[] {
  try {
    return listMemberIds(conversationId).filter((id) => id !== userId);
  } catch {
    return [];
  }
}

/** Which conversation an upload belongs to, so progress can be mirrored. */
function membersOfUpload(uploadId: string, userId: string): string[] {
  const row = db().prepare('SELECT conversation_id FROM uploads WHERE id = ? AND user_id = ?').get(uploadId, userId) as
    | { conversation_id: string | null }
    | undefined;
  return row?.conversation_id ? membersExcept(row.conversation_id, userId) : [];
}

/**
 * Push a presence change to everyone who is allowed to see it: members of shared
 * conversations and accepted contacts. Strangers never receive it, and a user
 * who hid their last-seen does not get offline events forwarded.
 */
function broadcastPresence(userId: string, online: boolean): void {
  const recipients = db()
    .prepare(
      `SELECT DISTINCT cm2.user_id AS uid
         FROM conversation_members cm1
         JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
        WHERE cm1.user_id = ? AND cm2.user_id != ? AND cm2.left_at IS NULL
        UNION
        SELECT contact_id AS uid FROM contacts WHERE user_id = ? AND status = 'accepted'
        UNION
        SELECT user_id AS uid FROM contacts WHERE contact_id = ? AND status = 'accepted'`,
    )
    .all(userId, userId, userId, userId) as { uid: string }[];

  const now = nowMs();
  for (const r of recipients) {
    let target;
    try {
      target = getUser(r.uid);
    } catch {
      continue;
    }
    // showPresence=false means no presence events at all for this viewer.
    if (!getSettings(target.id).privacy.showPresence) continue;

    const event: PresenceEvent = { userId, state: online ? 'online' : 'offline', lastSeenAt: now };
    sendToUser(target.id, { t: 'presence', events: [event] }, { persist: false });
  }
  void isOnline;
}

function pruneResumeTokens(): void {
  const cutoff = nowMs() - RESUME_TTL_MS * 4;
  for (const [token, value] of resumeTokens) {
    if (value.issuedAt < cutoff) resumeTokens.delete(token);
  }
}

/**
 * Wrap a socket event handler so a throw cannot escape.
 *
 * Fastify's error handler only covers the HTTP request lifecycle. Socket event
 * callbacks fire later, on the event emitter, so an exception there surfaces as
 * an `uncaughtException` and brings the whole process down — taking every other
 * connected user with it. That makes any bug reachable from a client-controlled
 * event a remote denial of service, so each handler is contained individually
 * and the socket is dropped if its own teardown fails.
 */
function guard(event: string, fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (e) {
      // Logging is the only safe action left; never rethrow from here.
      try {
        console.error(`[realtime] ${event} handler failed:`, e instanceof Error ? e.message : e);
      } catch {
        /* nothing left to do */
      }
    }
  };
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    /* the socket died between the check and the write; ignore */
  }
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    /* already closed */
  }
}
