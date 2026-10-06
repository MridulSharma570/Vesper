/**
 * Conversations: direct, group and self ("Saved messages").
 *
 * A direct conversation is keyed by a canonical pair string so two users can
 * never end up with two separate DM threads. Group membership is stored in
 * conversation_members with per-member roles, mutes, pins and read cursors.
 */
import type {
  Conversation,
  ConversationKind,
  ConversationMember,
  ConversationView,
  MemberRole,
  Message,
  PublicProfile,
} from '../../../shared/types.js';
import { config } from '../config.js';
import { db, nowMs, parseJson } from '../db/index.js';
import { avatarSpec, newId } from '../lib/ids.js';
import { audit } from './audit.js';
import { err, getSettings, getUser, toPublicProfile } from './users.js';
import { isBlockedBy, mayContact } from './contacts.js';
import { serializeMessage } from './messages.js';

type UserRowLike = ReturnType<typeof getUser>;

/** Canonical, order-independent key for a DM pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

interface ConversationRow {
  id: string;
  kind: ConversationKind;
  title: string | null;
  avatar_seed: string | null;
  avatar_hue: number | null;
  avatar_attachment: string | null;
  created_by: string;
  created_at: number;
  last_message_at: number | null;
  disappearing_seconds: number | null;
  is_verified: number;
  member_count: number;
  state: string;
}

interface MemberRow {
  conversation_id: string;
  user_id: string;
  role: MemberRole;
  joined_at: number;
  left_at: number | null;
  muted_until: number | null;
  last_read_id: string | null;
  last_read_at: number;
  notifications_on: number;
  pinned: number;
  archived: number;
}

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    avatar: row.avatar_seed
      ? { seed: row.avatar_seed, hue: row.avatar_hue ?? 0, attachmentId: row.avatar_attachment }
      : null,
    memberCount: row.member_count,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    disappearingAfterSeconds: row.disappearing_seconds,
    createdBy: row.created_by,
    isVerified: !!row.is_verified,
  };
}

export function toMember(row: MemberRow): ConversationMember {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at,
    mutedUntil: row.muted_until,
    lastReadMessageId: row.last_read_id,
    lastReadAt: row.last_read_at,
    notificationsEnabled: !!row.notifications_on,
    pinned: !!row.pinned,
    archived: !!row.archived,
  };
}

export function getConversationRow(id: string): ConversationRow | null {
  return (db().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined) ?? null;
}

export function getConversation(id: string): ConversationRow {
  const row = getConversationRow(id);
  if (!row) throw err.notFound('Conversation');
  return row;
}

export function getMemberRow(conversationId: string, userId: string): MemberRow | null {
  return (
    (db()
      .prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL')
      .get(conversationId, userId) as MemberRow | undefined) ?? null
  );
}

/** Throws unless `userId` is an active member. Returns the membership row. */
export function requireMembership(conversationId: string, userId: string): MemberRow {
  const row = getMemberRow(conversationId, userId);
  if (!row) throw err.forbidden('You are not a member of this conversation');
  return row;
}

const MEMBER_ROLE_RANK: Record<MemberRole, number> = { member: 10, moderator: 30, admin: 50, owner: 100 };

export function requireConversationRole(conversationId: string, userId: string, role: MemberRole): MemberRow {
  const row = requireMembership(conversationId, userId);
  if (MEMBER_ROLE_RANK[row.role] < MEMBER_ROLE_RANK[role]) {
    throw err.forbidden(`This action requires the ${role} role in this conversation`);
  }
  return row;
}

export function listMemberIds(conversationId: string): string[] {
  const rows = db()
    .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL')
    .all(conversationId) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

export function listMemberProfiles(conversationId: string, viewerId: string): PublicProfile[] {
  const rows = db()
    .prepare(
      `SELECT u.* FROM users u
        JOIN conversation_members m ON m.user_id = u.id
        WHERE m.conversation_id = ? AND m.left_at IS NULL
        ORDER BY m.joined_at LIMIT 512`,
    )
    .all(conversationId) as UserRowLike[];
  return rows.map((r) => toPublicProfile(r, viewerId));
}

/* ─────────────────────────── Creation ─────────────────────────── */

/** Get or create the DM between two users. Idempotent. */
export function ensureDirectConversation(a: string, b: string): Conversation {
  if (a === b) return ensureSelfConversation(a);
  const key = pairKey(a, b);

  const existing = db()
    .prepare('SELECT conversation_id FROM direct_conversations WHERE pair_key = ?')
    .get(key) as { conversation_id: string } | undefined;

  if (existing) {
    const row = getConversationRow(existing.conversation_id);
    if (row && row.state === 'active') return toConversation(row);
  }

  // Privacy gates: a block makes the pair impossible; the recipient's
  // "who can message me" decides whether a request is needed.
  if (isBlockedBy(a, b) || isBlockedBy(b, a)) {
    throw err.notFound('That account is not available');
  }
  if (!mayContact(a, b) && !mayContact(b, a)) {
    throw err.forbidden('This account only accepts messages from contacts. Send a contact request first.');
  }

  const now = nowMs();
  const id = newId();
  const spec = avatarSpec(key);

  const create = db().transaction(() => {
    db().prepare(`
      INSERT INTO conversations (id, kind, title, avatar_seed, avatar_hue, created_by, created_at, member_count, state)
      VALUES (?, 'direct', NULL, ?, ?, ?, ?, 2, 'active')
    `).run(id, spec.seed, spec.hue, a, now);

    for (const uid of [a, b]) {
      db().prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at, notifications_on)
        VALUES (?, ?, 'member', ?, ?, 1)
      `).run(id, uid, now, now);
    }

    db().prepare(`
      INSERT INTO direct_conversations (pair_key, conversation_id) VALUES (?, ?)
      ON CONFLICT(pair_key) DO UPDATE SET conversation_id = excluded.conversation_id
    `).run(key, id);
  });
  create();

  return toConversation(getConversation(id));
}

export function ensureSelfConversation(userId: string): Conversation {
  const row = db()
    .prepare("SELECT * FROM conversations WHERE kind = 'self' AND created_by = ?")
    .get(userId) as ConversationRow | undefined;
  if (row) return toConversation(row);

  const now = nowMs();
  const id = newId();
  db().prepare(`
    INSERT INTO conversations (id, kind, title, avatar_seed, avatar_hue, created_by, created_at, member_count, state)
    VALUES (?, 'self', 'Saved messages', ?, ?, ?, ?, 1, 'active')
  `).run(id, `self-${userId.slice(0, 8)}`, 210, userId, now);
  db().prepare(`
    INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at, notifications_on, pinned)
    VALUES (?, ?, 'owner', ?, ?, 0, 1)
  `).run(id, userId, now, now);
  return toConversation(getConversation(id));
}

export interface CreateGroupInput {
  title?: string | null;
  memberIds: string[];
  disappearingAfterSeconds?: number | null;
}

export function createGroup(creatorId: string, input: CreateGroupInput): Conversation {
  const members = Array.from(new Set([creatorId, ...input.memberIds])).slice(0, config.features.maxGroupSize);
  if (members.length < 2) throw err.badRequest('A group needs at least two members');
  if (members.length > config.features.maxGroupSize) {
    throw err.badRequest(`Groups are limited to ${config.features.maxGroupSize} members`);
  }

  // Resolve and validate every member before creating anything, so a single bad
  // id cannot leave a half-built group behind.
  for (const uid of members) {
    if (uid === creatorId) continue;
    const target = getUser(uid);
    if (target.status !== 'active') throw err.badRequest('One of the selected accounts is not available');
    if (isBlockedBy(uid, creatorId) || isBlockedBy(creatorId, uid)) {
      throw err.badRequest('One of the selected accounts cannot be added to a group with you');
    }
    const settings = getSettings(uid);
    const rule = settings.privacy.whoCanAddMeToGroups;
    if (rule === 'nobody') throw err.forbidden('One of the selected accounts does not allow group invites');
  }

  const now = nowMs();
  const id = newId();
  const spec = avatarSpec(id);
  const title = input.title?.trim().slice(0, 80) || null;

  const create = db().transaction(() => {
    db().prepare(`
      INSERT INTO conversations (id, kind, title, avatar_seed, avatar_hue, created_by, created_at,
                                 member_count, disappearing_seconds, state)
      VALUES (?, 'group', ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(id, title, spec.seed, spec.hue, creatorId, now, members.length, input.disappearingAfterSeconds ?? null);

    const stmt = db().prepare(`
      INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at, notifications_on)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    for (const uid of members) {
      stmt.run(id, uid, uid === creatorId ? 'owner' : 'member', now, uid === creatorId ? now : 0);
    }
  });
  create();

  audit({
    actorId: creatorId,
    action: 'conversation.group_created',
    target: { type: 'conversation', id },
    meta: { memberCount: members.length },
  });
  return toConversation(getConversation(id));
}

/* ─────────────────────────── Membership changes ─────────────────────────── */

export function addMembers(actorId: string, conversationId: string, userIds: string[]): Conversation {
  const conv = getConversation(conversationId);
  if (conv.kind === 'direct' || conv.kind === 'self') {
    throw err.badRequest('You cannot add members to a direct conversation');
  }
  requireMembership(conversationId, actorId);

  const current = new Set(listMemberIds(conversationId));
  if (current.size + userIds.length > config.features.maxGroupSize) {
    throw err.badRequest(`Groups are limited to ${config.features.maxGroupSize} members`);
  }

  const added: string[] = [];
  const now = nowMs();
  const run = db().transaction(() => {
    for (const uid of userIds) {
      if (current.has(uid)) continue;
      const target = getUser(uid);
      if (target.status !== 'active') continue;
      if (isBlockedBy(uid, actorId)) continue;
      const settings = getSettings(uid);
      if (settings.privacy.whoCanAddMeToGroups === 'nobody') continue;
      if (settings.privacy.whoCanAddMeToGroups === 'contacts') {
        const isMutual = db()
          .prepare("SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ? AND status = 'accepted'")
          .get(uid, actorId);
        if (!isMutual) continue;
      }
      db().prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at, notifications_on)
        VALUES (?, ?, 'member', ?, 0, 1)
        ON CONFLICT(conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at
      `).run(conversationId, uid, now);
      added.push(uid);
    }
    db().prepare('UPDATE conversations SET member_count = (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL) WHERE id = ?')
      .run(conversationId, conversationId);
  });
  run();

  if (added.length) {
    audit({
      actorId,
      action: 'conversation.members_added',
      target: { type: 'conversation', id: conversationId },
      meta: { count: added.length },
    });
  }
  return toConversation(getConversation(conversationId));
}

export function leaveConversation(userId: string, conversationId: string): void {
  const conv = getConversation(conversationId);
  const member = requireMembership(conversationId, userId);
  if (conv.kind === 'self') throw err.badRequest('You cannot leave your saved messages');

  const now = nowMs();
  db().prepare('UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND user_id = ?')
    .run(now, conversationId, userId);

  // If the owner leaves a group, hand ownership to the longest-standing admin,
  // then member, so the group is never orphaned.
  if (conv.kind === 'group' && member.role === 'owner') {
    const next = db()
      .prepare(
        `SELECT user_id FROM conversation_members
          WHERE conversation_id = ? AND left_at IS NULL AND user_id != ?
          ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, joined_at
          LIMIT 1`,
      )
      .get(conversationId, userId) as { user_id: string } | undefined;
    if (next) {
      db().prepare("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?")
        .run(conversationId, next.user_id);
    }
  }

  db().prepare('UPDATE conversations SET member_count = (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL) WHERE id = ?')
    .run(conversationId, conversationId);

  // An empty group is archived rather than deleted, so message history required
  // for legal retention is preserved.
  const remaining = db()
    .prepare('SELECT COUNT(*) AS c FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL')
    .get(conversationId) as { c: number };
  if (remaining.c === 0) {
    db().prepare("UPDATE conversations SET state = 'archived' WHERE id = ?").run(conversationId);
  }
  audit({ actorId: userId, action: 'conversation.left', target: { type: 'conversation', id: conversationId } });
}

export function removeMember(actorId: string, conversationId: string, targetId: string, reason?: string): void {
  requireConversationRole(conversationId, actorId, 'moderator');
  const target = getMemberRow(conversationId, targetId);
  if (!target) throw err.notFound('That account is not in this conversation');
  if (target.role === 'owner') throw err.forbidden('The group owner cannot be removed');
  if (MEMBER_ROLE_RANK[target.role] >= MEMBER_ROLE_RANK[requireMembership(conversationId, actorId).role]) {
    throw err.forbidden('You cannot remove a member of equal or higher rank');
  }
  db().prepare('UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND user_id = ?')
    .run(nowMs(), conversationId, targetId);
  db().prepare('UPDATE conversations SET member_count = (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL) WHERE id = ?')
    .run(conversationId, conversationId);
  audit({
    actorId,
    action: 'conversation.member_removed',
    target: { type: 'conversation', id: conversationId },
    reason,
    severity: 'notice',
    meta: { removed: targetId },
  });
}

export function setMemberRole(actorId: string, conversationId: string, targetId: string, role: MemberRole): void {
  requireConversationRole(conversationId, actorId, 'admin');
  if (role === 'owner') throw err.forbidden('Ownership transfers are not supported');
  const target = getMemberRow(conversationId, targetId);
  if (!target) throw err.notFound('That account is not in this conversation');
  db().prepare('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?')
    .run(role, conversationId, targetId);
  audit({
    actorId,
    action: 'conversation.member_role_changed',
    target: { type: 'conversation', id: conversationId },
    meta: { target: targetId, role },
  });
}

export function updateConversation(
  actorId: string,
  conversationId: string,
  patch: { title?: string | null; disappearingAfterSeconds?: number | null },
): Conversation {
  const conv = getConversation(conversationId);
  if (conv.kind === 'group') requireConversationRole(conversationId, actorId, 'admin');
  else requireMembership(conversationId, actorId);

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: conversationId, updated: nowMs() };
  if (patch.title !== undefined) {
    sets.push('title = @title');
    params.title = patch.title?.trim().slice(0, 80) || null;
  }
  if (patch.disappearingAfterSeconds !== undefined) {
    const allowed = [null, 5, 10, 30, 60, 300, 1800, 3600, 86_400, 604_800];
    if (!allowed.includes(patch.disappearingAfterSeconds)) {
      throw err.badRequest('That disappearing-message interval is not supported');
    }
    sets.push('disappearing_seconds = @dis');
    params.dis = patch.disappearingAfterSeconds;
  }
  if (sets.length) {
    db().prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
  audit({ actorId, action: 'conversation.updated', target: { type: 'conversation', id: conversationId } });
  return toConversation(getConversation(conversationId));
}

/* ─────────────────────────── Per-member view state ─────────────────────────── */

export function setMemberPrefs(
  userId: string,
  conversationId: string,
  prefs: { pinned?: boolean; archived?: boolean; notificationsEnabled?: boolean; mutedUntil?: number | null },
): ConversationMember {
  requireMembership(conversationId, userId);
  const sets: string[] = [];
  const params: Record<string, unknown> = { conversationId, userId };
  if (prefs.pinned !== undefined) { sets.push('pinned = @pinned'); params.pinned = prefs.pinned ? 1 : 0; }
  if (prefs.archived !== undefined) { sets.push('archived = @archived'); params.archived = prefs.archived ? 1 : 0; }
  if (prefs.notificationsEnabled !== undefined) {
    sets.push('notifications_on = @notif');
    params.notif = prefs.notificationsEnabled ? 1 : 0;
  }
  if (prefs.mutedUntil !== undefined) { sets.push('muted_until = @muted'); params.muted = prefs.mutedUntil; }
  if (sets.length) {
    db().prepare(
      `UPDATE conversation_members SET ${sets.join(', ')} WHERE conversation_id = @conversationId AND user_id = @userId`,
    ).run(params);
  }
  return toMember(getMemberRow(conversationId, userId)!);
}

export function markRead(userId: string, conversationId: string, messageId: string): void {
  db().prepare(
    'UPDATE conversation_members SET last_read_id = ?, last_read_at = ? WHERE conversation_id = ? AND user_id = ?',
  ).run(messageId, nowMs(), conversationId, userId);
}

export function unreadCount(userId: string, conversationId: string): number {
  const member = getMemberRow(conversationId, userId);
  if (!member) return 0;
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM messages
        WHERE conversation_id = ? AND sender_id != ? AND deleted_at IS NULL
          AND (id > COALESCE(?, ''))`,
    )
    .get(conversationId, userId, member.last_read_id) as { c: number };
  return row.c;
}

/**
 * The conversation list, newest activity first, pinned first within that.
 * Excludes rows the viewer deleted "for me" and archived chats unless asked.
 */
export interface ConversationPage {
  items: ConversationView[];
  nextCursor: string | null;
}

/**
 * Cursor for keyset pagination over the pinned-then-recency order. Opaque to
 * clients; `${pinned}|${activityAt}|${id}` inside.
 */
function encodeCursor(pinned: number, activity: number, id: string): string {
  return `${pinned}|${activity}|${id}`;
}

function decodeCursor(cursor: string | null | undefined): { pinned: number; activity: number; id: string } | null {
  if (!cursor) return null;
  const [p, t, id] = cursor.split('|');
  const pinned = Number(p);
  const activity = Number(t);
  if (!id || Number.isNaN(pinned) || Number.isNaN(activity)) return null;
  return { pinned, activity, id };
}

/**
 * The conversation list, paginated and batched.
 *
 * The old implementation ran three extra queries per row (member profiles,
 * last message, unread count) — a 100-item list meant 300+ round trips into
 * SQLite and a perceptible stall on every cold open. This version runs four
 * queries total regardless of page size: the page itself, then one batched
 * query each for last messages (window function), unread counts (join back
 * into the member rows' last_read_id) and member profiles.
 *
 * Pagination is keyset over (pinned DESC, activity DESC, id DESC), so deep
 * pages cost the same as the first one and a new message arriving cannot
 * shift the window under a reader the way OFFSET would.
 */
export function listConversationsPage(
  userId: string,
  opts: { includeArchived?: boolean; limit?: number; cursor?: string | null } = {},
): ConversationPage {
  const limit = Math.min(opts.limit ?? 50, 100);
  const after = decodeCursor(opts.cursor);

  const rows = db()
    .prepare(
      `SELECT c.*, m.*, m.conversation_id AS cid
         FROM conversation_members m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.user_id = ? AND m.left_at IS NULL AND c.state = 'active'
          ${opts.includeArchived ? '' : 'AND m.archived = 0'}
          ${after ? 'AND (m.pinned, COALESCE(c.last_message_at, c.created_at), c.id) < (?, ?, ?)' : ''}
        ORDER BY m.pinned DESC, COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
        LIMIT ?`,
    )
    .all(...(after ? [userId, after.pinned, after.activity, after.id, limit + 1] : [userId, limit + 1])) as (ConversationRow & MemberRow & { cid: string })[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  if (page.length === 0) return { items: [], nextCursor: null };

  const ids = page.map((r) => r.cid);
  const inList = ids.map(() => '?').join(',');

  /* Latest visible message per conversation, one query. */
  const lastRows = db()
    .prepare(
      `SELECT * FROM (
         SELECT messages.*, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY id DESC) AS rn
           FROM messages
          WHERE conversation_id IN (${inList}) AND deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = messages.id AND d.user_id = ?)
       ) WHERE rn = 1`,
    )
    .all(...ids, userId) as Record<string, unknown>[];
  const lastByConv = new Map(lastRows.map((r) => [String(r.conversation_id), r]));

  /* Unread counts, one query: message ids past each member row's last_read_id. */
  const unreadRows = db()
    .prepare(
      `SELECT m.conversation_id AS cid, COUNT(msg.id) AS c
         FROM conversation_members m
         LEFT JOIN messages msg
           ON msg.conversation_id = m.conversation_id
          AND msg.deleted_at IS NULL AND msg.sender_id != m.user_id
          AND msg.id > COALESCE(m.last_read_id, '')
        WHERE m.user_id = ? AND m.conversation_id IN (${inList})
        GROUP BY m.conversation_id`,
    )
    .all(userId, ...ids) as { cid: string; c: number }[];
  const unreadByConv = new Map(unreadRows.map((r) => [r.cid, r.c]));

  /* Member profiles, one query, grouped client-side (same 512 cap as before). */
  const memberRows = db()
    .prepare(
      `SELECT m.conversation_id AS cid, u.* FROM users u
         JOIN conversation_members m ON m.user_id = u.id
        WHERE m.conversation_id IN (${inList}) AND m.left_at IS NULL
        ORDER BY m.joined_at`,
    )
    .all(...ids) as (UserRowLike & { cid: string })[];
  const membersByConv = new Map<string, UserRowLike[]>();
  for (const r of memberRows) {
    const list = membersByConv.get(r.cid) ?? [];
    if (list.length < 512) list.push(r);
    membersByConv.set(r.cid, list);
  }

  const items = page
    .map((row) => {
      try {
        const conversation = toConversation(row);
        return {
          conversation,
          member: toMember(row),
          members: (membersByConv.get(row.cid) ?? []).map((u) => toPublicProfile(u, userId)),
          lastMessage: (() => {
            const last = lastByConv.get(row.cid);
            return last ? serializeMessage(last, userId) : null;
          })(),
          unreadCount: unreadByConv.get(row.cid) ?? 0,
          typing: [],
        } as ConversationView;
      } catch {
        return null;
      }
    })
    .filter((v): v is ConversationView => v !== null);

  const tail = page[page.length - 1];
  if (!tail) return { items, nextCursor: null };
  const nextCursor = hasMore
    ? encodeCursor(Number(tail.pinned ?? 0), Number(tail.last_message_at ?? tail.created_at), tail.cid)
    : null;
  return { items, nextCursor };
}

export function listConversations(userId: string, opts: { includeArchived?: boolean; limit?: number } = {}): ConversationView[] {
  return listConversationsPage(userId, opts).items;
}

export function buildConversationView(conversationId: string, userId: string): ConversationView | null {
  const conv = getConversationRow(conversationId);
  if (!conv) return null;
  const member = getMemberRow(conversationId, userId);
  if (!member) return null;
  return buildView(conv, member, userId);
}

function buildView(conv: ConversationRow, member: MemberRow, viewerId: string): ConversationView | null {
  try {
    const conversation = toConversation(conv);
    const members = conversation.kind === 'direct' || conversation.kind === 'group'
      ? listMemberProfiles(conversation.id, viewerId)
      : [];

    const lastRow = db()
      .prepare(
        `SELECT * FROM messages
          WHERE conversation_id = ? AND deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = messages.id AND d.user_id = ?)
          ORDER BY id DESC LIMIT 1`,
      )
      .get(conversation.id, viewerId) as Record<string, unknown> | undefined;

    return {
      conversation,
      member: toMember(member),
      members,
      lastMessage: lastRow ? serializeMessage(lastRow, viewerId) : null,
      unreadCount: unreadCount(viewerId, conversation.id),
      typing: [],
    };
  } catch {
    return null;
  }
}

/** The other participant of a DM, or null for groups/self. */
export function directCounterpart(conversationId: string, userId: string): PublicProfile | null {
  const conv = getConversationRow(conversationId);
  if (!conv || conv.kind !== 'direct') return null;
  const other = listMemberIds(conversationId).find((id) => id !== userId);
  return other ? toPublicProfile(getUser(other), userId) : null;
}


