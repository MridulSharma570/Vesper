/**
 * Call signalling state machine.
 *
 * This module owns the *whole* call lifecycle for every call type — 1:1 voice,
 * 1:1 video, group voice, group video and scheduled calls. The media plane is
 * delegated to an adapter (see adapters/calls), so the state machine does not
 * change when you move from P2P mesh to an SFU.
 *
 * Lifecycle:
 *   ringing → connecting → active → ended
 *                 ↘ missed / declined / failed
 *
 * The server never touches media. It routes SDP offers/answers and ICE
 * candidates between participants and keeps authoritative participant state so a
 * client that reconnects mid-call can rebuild the room.
 *
 * Privacy: SDP can contain IP addresses. Because Vesper is anonymous, calls
 * default to `relay-only` ICE when a TURN server is configured, so participants
 * never learn each other's addresses. That is a deliberate trade of a little
 * latency for a lot of anonymity, and it is documented in docs/SECURITY.md.
 */
import type {
  CallKind,
  CallParticipant,
  CallRoom,
  CallSignal,
  CallState,
  CallTopology,
  ClientMediaCapabilities,
  Message,
} from '../../../shared/types.js';
import { config, featureFlags } from '../config.js';
import { db, nowMs, parseJson, toJson } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { err, getSettings, getUser, toPublicProfile } from './users.js';
import { isBlockedBy, mayContact } from './contacts.js';
import { getConversation, listMemberIds, requireMembership } from './conversations.js';
import { selectAdapter } from '../adapters/calls/index.js';
import { audit } from './audit.js';

export interface CallRow {
  id: string;
  conversation_id: string;
  created_by: string;
  kind: CallKind;
  topology: CallTopology;
  state: CallState;
  started_at: number;
  answered_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  join_token_hash: string | null;
  join_url: string | null;
  media_server: string | null;
  media_room_id: string | null;
  ice_json: string | null;
  max_participants: number;
  recording_on: number;
  scheduled_for: number | null;
  duration_seconds: number | null;
}

const RING_TIMEOUT_MS = 45_000;

export function defaultCapabilities(platform: string): ClientMediaCapabilities {
  return {
    audioIn: true,
    audioOut: true,
    videoIn: platform !== 'windows' || true,
    videoOut: true,
    screenShare: platform === 'web' || platform === 'windows' || platform === 'macos',
    maxVideoWidth: 1280,
    maxVideoHeight: 720,
    maxBitrateKbps: 1500,
    codecs: ['opus', 'vp8', 'h264'],
    platform: platform as ClientMediaCapabilities['platform'],
  };
}

function assertCallsEnabled(kind: CallKind): void {
  const flags = featureFlags();
  if (!flags.calls) throw err.forbidden('Calling is not enabled on this server yet');
  if (!flags.allowedCallKinds.includes(kind)) {
    throw err.forbidden(`${kind} calls are not enabled on this server yet`);
  }
}

function pickKind(conversationKind: string, video: boolean, group: boolean): CallKind {
  if (conversationKind === 'direct' || conversationKind === 'self') {
    return video ? 'video_1v1' : 'voice_1v1';
  }
  return group ? (video ? 'group_video' : 'group_voice') : video ? 'video_1v1' : 'voice_1v1';
}

/* ─────────────────────────── Starting a call ─────────────────────────── */

export interface StartCallInput {
  conversationId: string;
  callerId: string;
  video?: boolean;
  /** For scheduled calls ("Spaces"). */
  scheduledFor?: number | null;
  capabilities?: ClientMediaCapabilities;
  deviceId?: string;
}

export interface StartCallResult {
  room: CallRoom;
  /** User ids that must be rung. */
  invitees: string[];
  /** Frames to deliver to each invitee. */
  signals: { to: string; frame: CallSignal }[];
}

export async function startCall(input: StartCallInput): Promise<StartCallResult> {
  const conversation = getConversation(input.conversationId);
  requireMembership(input.conversationId, input.callerId);
  const caller = getUser(input.callerId);
  if (caller.status !== 'active') throw err.forbidden('This account cannot start calls');

  const members = listMemberIds(input.conversationId).filter((id) => id !== input.callerId);
  if (!members.length) throw err.badRequest('There is nobody to call in this conversation');

  const isGroup = conversation.kind === 'group';
  const kind = pickKind(conversation.kind, !!input.video, isGroup);
  assertCallsEnabled(kind);

  // Permission gates: for a DM the callee's "who can call me" decides; a block
  // in either direction makes the call impossible without revealing which side.
  if (!isGroup) {
    const callee = members[0]!;
    if (isBlockedBy(callee, input.callerId) || isBlockedBy(input.callerId, callee)) {
      throw err.notFound('That account is not available');
    }
    const calleeSettings = getSettings(callee);
    const rule = calleeSettings.privacy.whoCanCallMe;
    if (rule === 'nobody') throw err.forbidden('This account does not accept calls');
    if (rule === 'contacts' && !mayContact(input.callerId, callee)) {
      throw err.forbidden('This account only accepts calls from contacts');
    }
  }

  const flags = featureFlags();
  const maxParticipants = isGroup
    ? Math.min(flags.maxCallParticipants, members.length + 1)
    : 2;
  if (members.length + 1 > maxParticipants && !isGroup) {
    throw err.badRequest('That conversation has too many participants for a call');
  }

  const adapter = selectAdapter(kind);
  const roomId = newId();
  const now = nowMs();
  const invitees = members.slice(0, maxParticipants - 1);

  const grant = await adapter.createRoom({
    roomId,
    kind,
    createdBy: input.callerId,
    participantIds: [input.callerId, ...invitees],
    maxParticipants,
  });

  // The join token is a bearer credential for the media server; only its hash is
  // stored, and it is issued per participant rather than shared.
  const participants: CallParticipant[] = [input.callerId, ...invitees].map((uid) => ({
    userId: uid,
    joinedAt: uid === input.callerId ? now : null,
    leftAt: null,
    state: uid === input.callerId ? 'joined' : 'invited',
    audioMuted: false,
    videoMuted: !input.video,
    capabilities: uid === input.callerId
      ? (input.capabilities ?? defaultCapabilities('web'))
      : defaultCapabilities('web'),
  }));

  const insertParticipant = db().prepare(`
    INSERT INTO call_participants (call_id, user_id, device_id, state, invited_at, joined_at, audio_muted, video_muted, capabilities_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_id, user_id, device_id) DO UPDATE SET state = excluded.state
  `);

  const write = db().transaction(() => {
    db().prepare(`
      INSERT INTO calls (id, conversation_id, created_by, kind, topology, state, started_at,
                         join_token_hash, join_url, media_server, media_room_id, ice_json,
                         max_participants, recording_on, scheduled_for)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      roomId, input.conversationId, input.callerId, kind, grant.topology,
      input.scheduledFor ? 'ringing' : 'ringing', now,
      null, grant.joinUrl, grant.adapter, roomId, toJson(grant.iceServers),
      grant.maxParticipants, input.scheduledFor ?? null,
    );
    for (const p of participants) {
      insertParticipant.run(
        roomId, p.userId, input.deviceId ?? 'default', p.state, now, p.joinedAt,
        p.audioMuted ? 1 : 0, p.videoMuted ? 1 : 0, toJson(p.capabilities),
      );
    }
  });
  write();

  const room = loadRoom(roomId, input.callerId, grant.joinToken);

  // Schedule the ring timeout: if nobody answers, mark missed and notify.
  if (!input.scheduledFor) {
    scheduleRingTimeout(roomId);
  }

  audit({
    actorId: input.callerId,
    action: 'call.started',
    target: { type: 'call', id: roomId },
    meta: { kind, topology: grant.topology, invitees: invitees.length },
  });

  return {
    room,
    invitees,
    signals: invitees.map((uid) => ({
      to: uid,
      frame: {
        t: 'call.state' as const,
        callId: roomId,
        state: 'ringing' as CallState,
        room,
      },
    })),
  };
}

const ringTimers = new Map<string, NodeJS.Timeout>();

function scheduleRingTimeout(callId: string): void {
  const existing = ringTimers.get(callId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    ringTimers.delete(callId);
    try {
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(callId) as CallRow | undefined;
      if (!row || row.ended_at || row.state !== 'ringing') return;
      endCall(callId, row.created_by, 'ring_timeout');
    } catch {
      /* the call is already gone */
    }
  }, RING_TIMEOUT_MS);
  // Never keep the process alive just for a ring timer.
  timer.unref?.();
  ringTimers.set(callId, timer);
}

/* ─────────────────────────── Room reads ─────────────────────────── */

export function loadRoom(callId: string, viewerId: string, joinToken?: string | null): CallRoom {
  const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(callId) as CallRow | undefined;
  if (!row) throw err.notFound('Call');
  requireMembership(row.conversation_id, viewerId);

  const participantRows = db()
    .prepare('SELECT * FROM call_participants WHERE call_id = ?')
    .all(callId) as Record<string, unknown>[];

  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    topology: row.topology,
    state: row.state,
    createdBy: row.created_by,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    participants: participantRows.map((p) => ({
      userId: String(p.user_id),
      joinedAt: (p.joined_at as number | null) ?? null,
      leftAt: (p.left_at as number | null) ?? null,
      state: (p.state as CallParticipant['state']) ?? 'invited',
      audioMuted: !!p.audio_muted,
      videoMuted: !!p.video_muted,
      capabilities: parseJson<ClientMediaCapabilities>(p.capabilities_json, defaultCapabilities('web')),
    })),
    joinToken: joinToken ?? null,
    joinUrl: row.join_url,
    iceServers: parseJson<CallRoom['iceServers']>(row.ice_json, []),
    maxParticipants: row.max_participants,
    recordingEnabled: !!row.recording_on,
    scheduledFor: row.scheduled_for,
  };
}

export function listActiveCalls(userId: string): CallRoom[] {
  const rows = db()
    .prepare(
      `SELECT c.* FROM calls c
         JOIN call_participants p ON p.call_id = c.id
        WHERE p.user_id = ? AND c.ended_at IS NULL
        ORDER BY c.started_at DESC LIMIT 20`,
    )
    .all(userId) as CallRow[];
  return rows.map((r) => loadRoom(r.id, userId));
}

/* ─────────────────────────── Participant transitions ─────────────────────────── */

export async function joinCall(callId: string, userId: string, deviceId: string, capabilities: ClientMediaCapabilities): Promise<CallRoom> {
  const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(callId) as CallRow | undefined;
  if (!row) throw err.notFound('Call');
  if (row.ended_at) throw err.badRequest('That call has already ended');
  requireMembership(row.conversation_id, userId);

  const now = nowMs();
  const count = (db()
    .prepare("SELECT COUNT(*) AS c FROM call_participants WHERE call_id = ? AND state = 'joined'")
    .get(callId) as { c: number }).c;
  if (count >= row.max_participants) throw err.forbidden('That call is full');

  db().prepare(`
    INSERT INTO call_participants (call_id, user_id, device_id, state, invited_at, joined_at, capabilities_json)
    VALUES (?, ?, ?, 'joined', ?, ?, ?)
    ON CONFLICT(call_id, user_id, device_id) DO UPDATE SET
      state = 'joined', joined_at = excluded.joined_at, left_at = NULL, capabilities_json = excluded.capabilities_json
  `).run(callId, userId, deviceId, now, now, toJson(capabilities));

  // First answer flips the room from ringing to active and stops the timeout.
  if (row.state === 'ringing') {
    db().prepare("UPDATE calls SET state = 'active', answered_at = ? WHERE id = ?").run(now, callId);
    const timer = ringTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      ringTimers.delete(callId);
    }
  }

  const adapter = selectAdapter(row.kind);
  const token = await adapter.participantToken(callId, userId, true);
  return loadRoom(callId, userId, token);
}

export function leaveCall(callId: string, userId: string): { ended: boolean; room: CallRoom | null } {
  const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(callId) as CallRow | undefined;
  if (!row) throw err.notFound('Call');
  const now = nowMs();
  db().prepare("UPDATE call_participants SET state = 'left', left_at = ? WHERE call_id = ? AND user_id = ?")
    .run(now, callId, userId);

  const remaining = (db()
    .prepare("SELECT COUNT(*) AS c FROM call_participants WHERE call_id = ? AND state = 'joined' AND left_at IS NULL")
    .get(callId) as { c: number }).c;

  if (remaining <= (row.kind.endsWith('1v1') ? 0 : 1)) {
    endCall(callId, userId, remaining === 0 ? 'all_left' : 'last_participant_left');
    return { ended: true, room: null };
  }
  return { ended: false, room: loadRoom(callId, userId) };
}

export function declineCall(callId: string, userId: string, reason?: string): void {
  const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(callId) as CallRow | undefined;
  if (!row) return;
  db().prepare("UPDATE call_participants SET state = 'declined', left_at = ? WHERE call_id = ? AND user_id = ?")
    .run(nowMs(), callId, userId);

  // In a 1:1 call a decline ends it. In a group it does not.
  if (row.kind.endsWith('1v1')) {
    endCall(callId, userId, reason === 'busy' ? 'declined_busy' : 'declined');
  }
}

export function endCall(callId: string, actorId: string, reason: string): void {
  const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(callId) as CallRow | undefined;
  if (!row || row.ended_at) return;
  const now = nowMs();
  const duration = row.answered_at ? Math.max(0, Math.round((now - row.answered_at) / 1000)) : 0;
  const finalState: CallState = row.answered_at ? 'ended' : reason === 'declined' || reason === 'declined_busy' ? 'declined' : 'missed';

  const finish = db().transaction(() => {
    db().prepare('UPDATE calls SET state = ?, ended_at = ?, end_reason = ?, duration_seconds = ? WHERE id = ?')
      .run(finalState, now, reason, duration, callId);
    db().prepare("UPDATE call_participants SET left_at = COALESCE(left_at, ?) WHERE call_id = ?")
      .run(now, callId);
    // Participants that never picked up are recorded as missed.
    db().prepare("UPDATE call_participants SET state = 'missed' WHERE call_id = ? AND state IN ('invited','ringing')")
      .run(callId);

    // A call leaves a trace in the transcript, exactly like WhatsApp, so the
    // conversation history is coherent even though no media was stored.
    const messageId = newId();
    db().prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, client_message_id, kind, text, payload_json, status, created_at)
      VALUES (?, ?, ?, ?, 'call_log', ?, ?, 'sent', ?)
    `).run(
      messageId, row.conversation_id, row.created_by, `call-${callId}`,
      '', toJson({ callId, kind: row.kind, state: finalState, durationSeconds: duration, reason }),
      now,
    );
    db().prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(now, row.conversation_id);
  });
  finish();

  const timer = ringTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ringTimers.delete(callId);
  }

  const adapter = selectAdapter(row.kind);
  void adapter.closeRoom(callId);

  audit({
    actorId,
    action: 'call.ended',
    target: { type: 'call', id: callId },
    meta: { reason, durationSeconds: duration, kind: row.kind },
  });
}

export function setMute(callId: string, userId: string, audio?: boolean, video?: boolean): CallRoom {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (audio !== undefined) { sets.push('audio_muted = ?'); params.push(audio ? 1 : 0); }
  if (video !== undefined) { sets.push('video_muted = ?'); params.push(video ? 1 : 0); }
  if (!sets.length) return loadRoom(callId, userId);
  params.push(callId, userId);
  db().prepare(`UPDATE call_participants SET ${sets.join(', ')} WHERE call_id = ? AND user_id = ?`).run(...params);
  return loadRoom(callId, userId);
}

/* ─────────────────────────── Signalling relay ─────────────────────────── */

/**
 * Route a signalling frame. The server inspects only the envelope (types and
 * sizes) — SDP and ICE payloads are opaque and are never parsed, stored or
 * logged, because they can contain network addresses.
 */
export interface RelayResult {
  /** User ids that should receive the frame. */
  to: string[];
  /** Frames the server itself generates in response. */
  generated: { to: string; frame: CallSignal }[];
}

export const MAX_SDP_BYTES = 32 * 1024;
export const MAX_ICE_BYTES = 2 * 1024;

export async function relaySignal(userId: string, deviceId: string, signal: CallSignal): Promise<RelayResult> {
  const generated: { to: string; frame: CallSignal }[] = [];

  switch (signal.t) {
    case 'call.offer': {
      assertCallsEnabled(signal.kind);
      if (!signal.sdp || signal.sdp.length > MAX_SDP_BYTES) throw err.badRequest('Offer is too large');
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(signal.callId) as CallRow | undefined;
      if (!row) throw err.notFound('Call');
      if (row.ended_at) throw err.badRequest('That call has already ended');
      requireMembership(row.conversation_id, userId);
      const targets = listMemberIds(row.conversation_id).filter((id) => id !== userId);
      return { to: targets, generated };
    }

    case 'call.answer': {
      if (!signal.sdp || signal.sdp.length > MAX_SDP_BYTES) throw err.badRequest('Answer is too large');
      const room = await joinCall(signal.callId, userId, deviceId, signal.capabilities ?? defaultCapabilities('web'));
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(signal.callId) as CallRow;
      const targets = listMemberIds(row.conversation_id).filter((id) => id !== userId);
      generated.push({
        to: row.created_by,
        frame: { t: 'call.state', callId: signal.callId, state: room.state, room },
      });
      return { to: targets, generated };
    }

    case 'call.ice': {
      const raw = JSON.stringify(signal.candidate ?? {});
      if (raw.length > MAX_ICE_BYTES) throw err.badRequest('ICE candidate is too large');
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(signal.callId) as CallRow | undefined;
      if (!row) throw err.notFound('Call');
      requireMembership(row.conversation_id, userId);
      const targets = listMemberIds(row.conversation_id).filter((id) => id !== userId);
      return { to: targets, generated };
    }

    case 'call.join': {
      const room = await joinCall(signal.callId, userId, deviceId, defaultCapabilities('web'));
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(signal.callId) as CallRow;
      const targets = listMemberIds(row.conversation_id).filter((id) => id !== userId);
      generated.push({
        to: userId,
        frame: { t: 'call.state', callId: signal.callId, state: room.state, room },
      });
      generated.push({
        to: targets[0] ?? userId,
        frame: { t: 'call.participants', callId: signal.callId, participants: room.participants },
      });
      return { to: targets, generated };
    }

    case 'call.leave': {
      const { ended } = leaveCall(signal.callId, userId);
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(signal.callId) as CallRow;
      const targets = listMemberIds(row.conversation_id).filter((id) => id !== userId);
      if (ended) {
        for (const t of targets) generated.push({ to: t, frame: { t: 'call.state', callId: signal.callId, state: 'ended' } });
        return { to: [], generated };
      }
      return { to: targets, generated };
    }

    case 'call.decline': {
      declineCall(signal.callId, userId, signal.reason);
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(signal.callId) as CallRow | undefined;
      if (!row) return { to: [], generated };
      const targets = listMemberIds(row.conversation_id).filter((id) => id !== userId);
      generated.push({ to: row.created_by, frame: { t: 'call.state', callId: signal.callId, state: 'ended' } });
      return { to: targets, generated };
    }

    case 'call.cancel': {
      endCall(signal.callId, userId, 'cancelled');
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(signal.callId) as CallRow | undefined;
      const targets = row ? listMemberIds(row.conversation_id).filter((id) => id !== userId) : [];
      for (const t of targets) generated.push({ to: t, frame: { t: 'call.state', callId: signal.callId, state: 'ended' } });
      return { to: [], generated };
    }

    case 'call.end': {
      endCall(signal.callId, userId, 'ended_by_participant');
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(signal.callId) as CallRow | undefined;
      const targets = row ? listMemberIds(row.conversation_id).filter((id) => id !== userId) : [];
      for (const t of targets) generated.push({ to: t, frame: { t: 'call.state', callId: signal.callId, state: 'ended' } });
      return { to: [], generated };
    }

    case 'call.mute': {
      const room = setMute(signal.callId, userId, signal.audio, signal.video);
      const row = db().prepare('SELECT * FROM calls WHERE id = ?').get(signal.callId) as CallRow;
      const targets = listMemberIds(row.conversation_id).filter((id) => id !== userId);
      return { to: targets, generated: [{ to: userId, frame: { t: 'call.participants', callId: signal.callId, participants: room.participants } }] };
    }

    default:
      throw err.badRequest('That signalling frame is not supported');
  }
}

/* ─────────────────────────── History ─────────────────────────── */

export function listCallHistory(conversationId: string, userId: string, limit = 30): CallRoom[] {
  requireMembership(conversationId, userId);
  const rows = db()
    .prepare('SELECT * FROM calls WHERE conversation_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(conversationId, Math.min(limit, 100)) as CallRow[];
  return rows.map((r) => loadRoom(r.id, userId));
}

/** Turn a call_log message into a human string for the transcript. */
export function describeCallLog(message: Message): string {
  const payload = message.body.poll as unknown as { state?: string; durationSeconds?: number; kind?: string } | null;
  const data = (message.body as unknown as Record<string, unknown>);
  const info = (payload ?? data) as { state?: string; durationSeconds?: number; kind?: string };
  const video = String(info.kind ?? '').includes('video');
  const noun = video ? 'video call' : 'voice call';
  switch (info.state) {
    case 'missed': return `Missed ${noun}`;
    case 'declined': return `Declined ${noun}`;
    case 'ended': {
      const s = Number(info.durationSeconds ?? 0);
      const mm = Math.floor(s / 60);
      const ss = String(s % 60).padStart(2, '0');
      return `${noun} · ${mm}:${ss}`;
    }
    default: return noun;
  }
}

/** Privacy summary surfaced in the call UI so users know what is exposed. */
export function callPrivacyNotice(topology: CallTopology): { relayOnly: boolean; notice: string } {
  const hasTurn = config.providers.calls.turn.urls.length > 0;
  if (topology === 'sfu' || topology === 'mcu') {
    return {
      relayOnly: true,
      notice: 'Audio and video travel through the call server. Participants do not learn each other’s IP addresses.',
    };
  }
  return hasTurn
    ? {
        relayOnly: true,
        notice: 'This call is relayed, so participants do not learn each other’s IP addresses.',
      }
    : {
        relayOnly: false,
        notice: 'This call is peer-to-peer. Without a relay server, participants may be able to see each other’s IP addresses. Add a TURN server in the configuration to prevent this.',
      };
}

export { toPublicProfile };
