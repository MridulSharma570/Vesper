/**
 * Realtime presence and delivery hub.
 *
 * One WebSocket per *device*, not per user: a person on Android and Windows at
 * once sees both, and "online" means at least one device is connected.
 *
 * Delivery model
 *   - A connection registers in `connections` keyed by (userId, deviceId).
 *   - Frames for a user go to all their live devices.
 *   - If a device is offline the frame is queued in `deliveries` and replayed on
 *     reconnect, so nothing is lost across a mobile network handover.
 *   - `message.new` is only acknowledged by the *sending* device, which prevents
 *     an echo loop when the same account is open on two screens.
 *
 * Backpressure: each socket has a bounded send queue. A slow or malicious client
 * is dropped rather than allowed to grow server memory without limit.
 */
import type { ServerFrame } from '../../../shared/types.js';
import { db, nowMs } from '../db/index.js';
import { mayContact } from '../services/contacts.js';
import { newId } from '../lib/ids.js';

export interface Connection {
  id: string;
  userId: string;
  sessionId: string;
  deviceId: string;
  platform: string;
  socket: {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    readyState: number;
  };
  connectedAt: number;
  lastPingAt: number;
  queue: number;
}

const connections = new Map<string, Connection>();
const byUser = new Map<string, Set<string>>();

const MAX_PENDING_FRAMES = 256;
const MAX_MESSAGE_BYTES = 64 * 1024;

export { MAX_MESSAGE_BYTES };

export function register(conn: Connection): void {
  connections.set(conn.id, conn);
  let set = byUser.get(conn.userId);
  if (!set) {
    set = new Set();
    byUser.set(conn.userId, set);
  }
  set.add(conn.id);
  markOnline(conn.userId);
}

export function unregister(connId: string): void {
  const conn = connections.get(connId);
  if (!conn) return;
  connections.delete(connId);
  const set = byUser.get(conn.userId);
  if (set) {
    set.delete(connId);
    if (!set.size) {
      byUser.delete(conn.userId);
      markOffline(conn.userId);
    }
  }
}

export function connectionCount(): number {
  return connections.size;
}

export function onlineUserCount(): number {
  return byUser.size;
}

export function isOnline(userId: string): boolean {
  return (byUser.get(userId)?.size ?? 0) > 0;
}

export function onlineUserIds(): string[] {
  return [...byUser.keys()];
}

export function devicesFor(userId: string): { deviceId: string; platform: string; connectedAt: number }[] {
  const ids = byUser.get(userId);
  if (!ids) return [];
  return [...ids]
    .map((id) => connections.get(id))
    .filter((c): c is Connection => !!c)
    .map((c) => ({ deviceId: c.deviceId, platform: c.platform, connectedAt: c.connectedAt }));
}

/* ─────────────────────────── Sending ─────────────────────────── */

/**
 * Deliver a frame to every device of a user except `excludeDeviceId`.
 * Returns true if at least one device received it live; otherwise it is queued.
 */
export function sendToUser(
  userId: string,
  frame: ServerFrame,
  opts: { excludeDeviceId?: string; persist?: boolean } = {},
): boolean {
  const ids = byUser.get(userId);
  const payload = JSON.stringify(frame);
  let delivered = false;

  if (ids?.size) {
    for (const id of ids) {
      const conn = connections.get(id);
      if (!conn) continue;
      if (opts.excludeDeviceId && conn.deviceId === opts.excludeDeviceId) continue;
      if (conn.queue > MAX_PENDING_FRAMES) {
        // This client is not draining. Drop it rather than grow memory.
        try { conn.socket.close(1008, 'send queue overflow'); } catch { /* already gone */ }
        continue;
      }
      try {
        conn.socket.send(payload);
        conn.queue += 1;
        delivered = true;
      } catch {
        unregister(id);
      }
    }
  }

  // Anything not delivered live is persisted for replay on reconnect.
  if (!delivered && opts.persist !== false) {
    queueForReplay(userId, payload, opts.excludeDeviceId);
  }
  return delivered;
}

/** Deliver to many users (a conversation fan-out) with one serialisation. */
export function sendToMany(userIds: string[], frame: ServerFrame, opts: { excludeDeviceId?: string } = {}): void {
  const payload = JSON.stringify(frame);
  for (const uid of userIds) {
    const ids = byUser.get(uid);
    let delivered = false;
    if (ids?.size) {
      for (const id of ids) {
        const conn = connections.get(id);
        if (!conn) continue;
        if (opts.excludeDeviceId && conn.deviceId === opts.excludeDeviceId) continue;
        if (conn.queue > MAX_PENDING_FRAMES) continue;
        try {
          conn.socket.send(payload);
          conn.queue += 1;
          delivered = true;
        } catch {
          unregister(id);
        }
      }
    }
    if (!delivered) queueForReplay(uid, payload, opts.excludeDeviceId);
  }
}

/** Send to one specific device only (e.g. an ack). */
export function sendToDevice(userId: string, deviceId: string, frame: ServerFrame): void {
  const ids = byUser.get(userId);
  if (!ids) return;
  const payload = JSON.stringify(frame);
  for (const id of ids) {
    const conn = connections.get(id);
    if (conn && conn.deviceId === deviceId) {
      try {
        conn.socket.send(payload);
        conn.queue += 1;
      } catch {
        unregister(id);
      }
    }
  }
}

function queueForReplay(userId: string, payload: string, excludeDeviceId?: string): void {
  try {
    db().prepare(`
      INSERT INTO deliveries (id, user_id, payload_json, created_at, attempts)
      VALUES (?, ?, ?, ?, 0)
    `).run(newId(), userId, payload, nowMs());
    void excludeDeviceId;
  } catch {
    // A delivery failure must never take down the socket that triggered it.
  }
}

/**
 * Replay everything queued for a user, oldest first. Called right after a
 * successful handshake so a returning device catches up before the UI renders.
 */
export function replayQueue(userId: string, connId: string): number {
  const conn = connections.get(connId);
  if (!conn) return 0;
  const rows = db()
    .prepare('SELECT id, payload_json FROM deliveries WHERE user_id = ? ORDER BY created_at ASC LIMIT 200')
    .all(userId) as { id: string; payload_json: string }[];
  if (!rows.length) return 0;

  const deleteStmt = db().prepare('DELETE FROM deliveries WHERE id = ?');
  const flush = db().transaction(() => {
    for (const r of rows) deleteStmt.run(r.id);
  });

  for (const r of rows) {
    try {
      conn.socket.send(r.payload_json);
      conn.queue += 1;
    } catch {
      break;
    }
  }
  flush();
  return rows.length;
}

/** Drop anything queued longer than a week — it is stale and only wastes space. */
export function pruneQueue(olderThanMs = 7 * 86_400_000): number {
  const res = db().prepare('DELETE FROM deliveries WHERE created_at < ?').run(nowMs() - olderThanMs);
  return res.changes;
}

/* ─────────────────────────── Presence ─────────────────────────── */

function markOnline(userId: string): void {
  db().prepare("UPDATE users SET presence = 'online', last_seen_at = ? WHERE id = ?").run(nowMs(), userId);
  db().prepare("UPDATE user_presence SET state = 'online', last_seen_at = ? WHERE user_id = ?")
    .run(nowMs(), userId);
}

function markOffline(userId: string): void {
  const now = nowMs();
  db().prepare("UPDATE users SET presence = 'offline', last_seen_at = ? WHERE id = ?").run(now, userId);
  db().prepare(`
    INSERT INTO user_presence (user_id, state, last_seen_at, updated_at) VALUES (?, 'offline', ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state = 'offline', last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at
  `).run(userId, now, now);
}

/**
 * Presence as visible to another user, honouring their privacy setting.
 * Returns `offline` with no timestamp when last-seen is hidden — the client then
 * shows nothing at all rather than a misleading time.
 */
export function presenceFor(viewerId: string, targetId: string, targetSettings: {
  privacy: { showPresence: boolean; whoCanSeeMyHandle: 'everyone' | 'contacts' | 'nobody' };
}): { presence: 'online' | 'offline'; lastSeenAt: number | null } {
  const online = isOnline(targetId);
  const row = db().prepare('SELECT last_seen_at FROM user_presence WHERE user_id = ?').get(targetId) as
    | { last_seen_at: number | null }
    | undefined;
  const lastSeen = row?.last_seen_at ?? null;

  // Presence is all-or-nothing per the target's own switch. When it is off we
  // still report live online/offline for people who can see the handle, but we
  // never hand out the timestamp — that is what "hide last seen" means.
  if (!targetSettings.privacy.showPresence) {
    return { presence: online ? 'online' : 'offline', lastSeenAt: null };
  }
  const rule = targetSettings.privacy.whoCanSeeMyHandle;
  if (rule === 'nobody') return { presence: online ? 'online' : 'offline', lastSeenAt: null };
  if (rule === 'contacts' && !mayContact(viewerId, targetId)) {
    return { presence: online ? 'online' : 'offline', lastSeenAt: null };
  }
  return { presence: online ? 'online' : 'offline', lastSeenAt: lastSeen };
}

/* ─────────────────────────── Housekeeping ─────────────────────────── */

/** Ping every connection; drop the ones that stopped answering. */
export function sweepConnections(onTimeout: (conn: Connection) => void): number {
  const now = nowMs();
  let dropped = 0;
  for (const conn of [...connections.values()]) {
    // Two missed pings (60s) and the socket is considered dead.
    if (now - conn.lastPingAt > 60_000) {
      onTimeout(conn);
      unregister(conn.id);
      dropped += 1;
    } else if (conn.queue > 0) {
      // Decay the queue counter so a burst does not permanently throttle a peer.
      conn.queue = Math.max(0, conn.queue - 8);
    }
  }
  return dropped;
}

/** Close everything — used on graceful shutdown and in tests. */
export function closeAll(code = 1001, reason = 'server_shutdown'): void {
  for (const conn of [...connections.values()]) {
    try { conn.socket.close(code, reason); } catch { /* already closed */ }
    unregister(conn.id);
  }
}

export function getConnection(connId: string): Connection | undefined {
  return connections.get(connId);
}
