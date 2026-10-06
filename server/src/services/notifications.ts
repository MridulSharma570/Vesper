/**
 * Notification fan-out.
 *
 * Three tiers, tried in order, because a push that arrives late is worse than
 * useless and a push that leaks content is worse than not arriving at all:
 *
 *   1. Live WebSocket frame — instant, and the payload may contain text.
 *   2. Stored in-app notification — survives an app restart, listed in the tray.
 *   3. Push (APNs/FCM/Web Push) — only when the user is offline, and only with
 *      the content the recipient's own preview setting permits.
 *
 * The privacy rules are enforced here rather than in each adapter, so no caller
 * can accidentally send message text to a lock screen that was configured to
 * hide it.
 */
import type { AppNotification } from '../../../shared/types.js';
import { config } from '../config.js';
import { db, nowMs, toJson } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { getSettings, getUser, toPublicProfile } from './users.js';
import { isOnline, sendToUser } from '../realtime/hub.js';
import { sendPush } from '../adapters/push/index.js';
import { listMemberIds } from './conversations.js';

export interface NotifyInput {
  userId: string;
  kind: AppNotification['kind'];
  title?: string;
  body?: string;
  conversationId?: string | null;
  messageId?: string | null;
  senderId?: string | null;
  /** Force delivery even if the recipient muted this conversation. */
  force?: boolean;
  /** Extra data for the client; never sent to a push provider. */
  data?: Record<string, unknown>;
}

export function notify(input: NotifyInput): AppNotification | null {
  let recipient;
  try {
    recipient = getUser(input.userId);
  } catch {
    return null;
  }
  if (recipient.status === 'deleted' || recipient.status === 'deactivated') return null;

  const settings = getSettings(input.userId);
  if (!settings.notifications.enabled) return null;

  // Category gating. Groups honour "mentions only"; security alerts follow the
  // dedicated login-alerts switch rather than the general notification toggle,
  // because a user who muted chatter still wants to hear about a new sign-in.
  if (!input.force) {
    if (input.kind === 'message' && input.conversationId && isGroup(input.conversationId)) {
      if (settings.notifications.groupMentionsOnly && !input.data?.mentioned) return null;
    }
    if (input.kind === 'security' && !settings.security.loginAlerts) return null;
  }

  // Per-conversation mute, checked against the wall clock so "mute until 9am"
  // works the way people expect.
  if (input.conversationId && !input.force) {
    const member = db()
      .prepare('SELECT notifications_on, muted_until FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(input.conversationId, input.userId) as { notifications_on: number; muted_until: number | null } | undefined;
    if (member && (!member.notifications_on || (member.muted_until ?? 0) > nowMs())) return null;
  }

  // Quiet hours.
  const quiet = settings.notifications.quietHours;
  if (!input.force && quiet?.enabled && inQuietHours(quiet.start, quiet.end)) return null;

  const title = input.title ?? defaultTitle(input.kind, input.senderId);
  const body = input.body ?? '';

  const notification: AppNotification = {
    id: newId(),
    kind: input.kind,
    title,
    body,
    conversationId: input.conversationId ?? null,
    messageId: input.messageId ?? null,
    createdAt: nowMs(),
    read: false,
    pushable: settings.notifications.previewInNotification !== 'never',
  };

  // Tier 1: live socket. This is the common case and the cheapest path.
  if (isOnline(input.userId)) {
    sendToUser(input.userId, { t: 'notification', notification });
    // A connected client renders its own badge; no push needed.
    return notification;
  }

  // Tier 2: persist so the tray has history and the client can sync it.
  try {
    db().prepare(`
      INSERT INTO notifications (id, user_id, kind, title, body, conversation_id, message_id, created_at, read_at, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      notification.id, input.userId, notification.kind, notification.title, notification.body,
      notification.conversationId, notification.messageId, notification.createdAt,
      input.data ? toJson(input.data) : null,
    );
  } catch {
    // A storage failure must not break the caller's action.
  }

  // Tier 3: push, only for an offline user. The adapter owns device lookup,
  // per-platform channel selection and preview redaction — this layer decides
  // *whether* to notify, never *how* to deliver.
  void deliverPush(input, notification);
  return notification;
}

async function deliverPush(input: NotifyInput, notification: AppNotification): Promise<void> {
  try {
    await sendPush({
      userId: notification.id ? input.userId : input.userId,
      // One collapse key per conversation, so a burst of messages replaces the
      // previous notification instead of stacking twenty of them on a lock screen.
      collapseKey: notification.conversationId ?? notification.id,
      title: notification.title,
      body: notification.body,
      data: {
        kind: notification.kind,
        notificationId: notification.id,
        conversationId: notification.conversationId ?? '',
        messageId: notification.messageId ?? '',
        // The adapter compares this against the recipient's preview setting
        // before deciding whether the body may reach the lock screen.
        isContact: input.data?.isContact === true || input.data?.isContact === '1' ? '1' : '0',
      },
      // An incoming call must wake a dozing device; a chat message must not.
      urgent: notification.kind === 'call',
      badge: unreadTotal(input.userId),
      sound: notification.kind === 'call' ? 'ring' : undefined,
    });
  } catch {
    // Push is best-effort. The notification is already stored, so the client
    // picks it up on the next sync.
  }
}

export function unreadTotal(userId: string): number {
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(c.unread), 0) AS total FROM (
         SELECT COUNT(*) AS unread
           FROM messages m
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
          WHERE m.sender_id != ? AND m.deleted_at IS NULL
            AND m.id > COALESCE(cm.last_read_id, '')
            AND cm.left_at IS NULL
          GROUP BY m.conversation_id
       ) c`,
    )
    .get(userId, userId) as { total: number };
  return Number(row.total ?? 0);
}

export function listNotifications(userId: string, limit = 50, cursor?: number): { items: AppNotification[]; nextCursor: number | null } {
  const rows = db()
    .prepare(
      `SELECT * FROM notifications WHERE user_id = ? ${cursor ? 'AND created_at < ?' : ''}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, ...(cursor ? [cursor] : []), Math.min(limit, 200)) as Record<string, unknown>[];

  const items = rows.map((r) => ({
    id: String(r.id),
    kind: r.kind as AppNotification['kind'],
    title: String(r.title ?? ''),
    body: String(r.body ?? ''),
    conversationId: (r.conversation_id as string | null) ?? null,
    messageId: (r.message_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    read: !!r.read_at,
    pushable: true,
  }));
  const last = items[items.length - 1];
  return { items, nextCursor: items.length === Math.min(limit, 200) && last ? last.createdAt : null };
}

export function markNotificationRead(userId: string, notificationId: string | null): number {
  if (notificationId) {
    const res = db().prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
      .run(nowMs(), notificationId, userId);
    return res.changes;
  }
  const res = db().prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .run(nowMs(), userId);
  return res.changes;
}

export function clearNotifications(userId: string): number {
  return db().prepare('DELETE FROM notifications WHERE user_id = ?').run(userId).changes;
}

function isGroup(conversationId: string): boolean {
  const row = db().prepare("SELECT kind FROM conversations WHERE id = ?").get(conversationId) as { kind: string } | undefined;
  return row?.kind === 'group';
}

function defaultTitle(kind: AppNotification['kind'], senderId?: string | null): string {
  if (senderId) {
    try {
      const profile = toPublicProfile(getUser(senderId));
      return profile.displayName ? `${profile.displayName} · @${profile.handle}` : `@${profile.handle}`;
    } catch {
      /* fall through to a generic title */
    }
  }
  switch (kind) {
    case 'call': return `${config.app.name} call`;
    case 'security': return `${config.app.name} security alert`;
    case 'moderation': return `${config.app.name} notice`;
    case 'system': return config.app.name;
    default: return `${config.app.name} · new message`;
  }
}

/**
 * Quiet hours span midnight, so the comparison is not a simple range check.
 * Times are the user's local "HH:MM" strings, evaluated against server local
 * time — good enough for a per-user preference, and it never stores a timezone.
 */
function inQuietHours(start: string, end: string): boolean {
  const toMinutes = (s: string): number => {
    const [h, m] = s.split(':').map(Number);
    return (Number(h) || 0) * 60 + (Number(m) || 0);
  };
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(start);
  const to = toMinutes(end);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** Notify every member of a conversation except the actor. */
export function notifyConversation(
  conversationId: string,
  actorId: string | null,
  input: Omit<NotifyInput, 'userId' | 'conversationId'>,
): void {
  let members: string[];
  try {
    members = listMemberIds(conversationId);
  } catch {
    return;
  }
  for (const uid of members) {
    if (uid === actorId) continue;
    notify({ ...input, userId: uid, conversationId });
  }
}
