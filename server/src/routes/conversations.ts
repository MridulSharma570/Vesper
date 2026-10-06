/**
 * /conversations — DMs, groups, membership, read state.
 *
 * Every read is membership-checked first. There is no endpoint that returns a
 * conversation the caller is not a member of, which is what makes group privacy
 * structural rather than a UI convention.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addMembers, buildConversationView, createGroup, directCounterpart, ensureDirectConversation,
  ensureSelfConversation, getConversation, leaveConversation, listConversations, listConversationsPage, listMemberIds,
  listMemberProfiles, removeMember, requireConversationRole, requireMembership, setMemberPrefs,
  setMemberRole, toConversation, unreadCount, updateConversation,
} from '../services/conversations.js';
import { getSettings, getUser, toPublicProfile } from '../services/users.js';
import { presenceFor } from '../realtime/hub.js';
import { sendToUser } from '../realtime/hub.js';
import { audit } from '../services/audit.js';
import { err } from '../services/users.js';
import { noStore, rateLimitConfig, requireAuth, shortCache } from '../middleware/index.js';

const idParam = z.object({ id: z.string().min(8).max(64) });

const createGroupSchema = z.object({
  title: z.string().max(80).nullish(),
  memberIds: z.array(z.string().min(8).max(64)).min(1).max(1000),
  disappearingAfterSeconds: z.number().int().min(0).max(60 * 60 * 24 * 365).nullish(),
}).strict();

const updateSchema = z.object({
  title: z.string().max(80).nullish(),
  disappearingAfterSeconds: z.number().int().min(0).max(60 * 60 * 24 * 365).nullish(),
}).strict();

const prefsSchema = z.object({
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  mutedUntil: z.number().int().min(0).nullable().optional(),
}).strict();

export function conversationRoutes(app: FastifyInstance): void {
  /* ── Listing ─────────────────────────────────────────────────── */

  app.get('/conversations', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    shortCache(reply, 5);
    const auth = requireAuth(req);
    const q = req.query as { includeArchived?: string; limit?: string; cursor?: string };
    const page = listConversationsPage(auth.userId, {
      includeArchived: q.includeArchived === 'true',
      limit: Math.min(Number(q.limit ?? 50) || 50, 100),
      cursor: q.cursor,
    });
    // `conversations` keeps its old shape for existing clients; nextCursor is
    // additive and null when the whole list fit in one page.
    return { conversations: page.items, nextCursor: page.nextCursor };
  });

  app.get('/conversations/unread-count', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    shortCache(reply, 5);
    const auth = requireAuth(req);
    const conversations = listConversations(auth.userId, { limit: 300 });
    const total = conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
    return { total, byConversation: conversations.map((c) => ({ id: c.conversation.id, unread: c.unreadCount ?? 0 })) };
  });

  /** "Saved messages" — a conversation with yourself. Telegram's model. */
  app.post('/conversations/self', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    return reply.send({ conversation: ensureSelfConversation(auth.userId) });
  });

  app.post('/conversations/direct', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ userId: z.string().min(8).max(64) }).strict().parse(await req.body);
    return reply.status(201).send({ conversation: ensureDirectConversation(auth.userId, body.userId) });
  });

  /* ── Groups ──────────────────────────────────────────────────── */

  app.post('/conversations/groups', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const body = createGroupSchema.parse(await req.body);
    const conversation = createGroup(auth.userId, body);
    audit({
      actorId: auth.userId,
      action: 'conversation.group_created',
      target: { type: 'conversation', id: conversation.id },
      meta: { members: body.memberIds.length + 1 },
    });

    // Tell the new members immediately so their list updates without a refresh.
    for (const uid of body.memberIds) {
      const view = buildConversationView(conversation.id, uid);
      if (view) sendToUser(uid, { t: 'conversation.updated', conversation: view });
    }
    return reply.status(201).send({ conversation });
  });

  /* ── Single conversation ─────────────────────────────────────── */

  app.get('/conversations/:id', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    shortCache(reply, 5);
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    requireMembership(id, auth.userId);
    const view = buildConversationView(id, auth.userId);
    if (!view) throw err.notFound('Conversation');

    // For a DM, include the counterpart's presence — that is what lets the
    // header show "online" without a second request.
    const counterpart = directCounterpart(id, auth.userId);
    return {
      conversation: view,
      counterpart: counterpart ? { ...counterpart, presence: presenceFor(auth.userId, counterpart.id, getSettings(counterpart.id)) } : null,
      members: view.conversation.kind === 'group' ? listMemberProfiles(id, auth.userId) : undefined,
    };
  });

  app.get('/conversations/:id/members', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    shortCache(reply, 10);
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    requireMembership(id, auth.userId);
    const members = listMemberProfiles(id, auth.userId);
    return {
      members: members.map((m) => ({ ...m, presence: presenceFor(auth.userId, m.id, getSettings(m.id)) })),
      total: members.length,
    };
  });

  app.patch('/conversations/:id', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(await req.body);
    const conversation = updateConversation(auth.userId, id, body);
    for (const uid of listMemberIds(id)) {
      const view = buildConversationView(id, uid);
      if (view) sendToUser(uid, { t: 'conversation.updated', conversation: view });
    }
    return reply.send({ conversation });
  });

  app.post('/conversations/:id/members', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ userIds: z.array(z.string().min(8).max(64)).min(1).max(500) }).strict().parse(await req.body);
    const conversation = addMembers(auth.userId, id, body.userIds);

    const actorProfile = toPublicProfile(getUser(auth.userId), auth.userId);
    for (const uid of body.userIds) {
      sendToUser(uid, { t: 'conversation.member_joined', conversationId: id, member: actorProfile });
      const view = buildConversationView(id, uid);
      if (view) sendToUser(uid, { t: 'conversation.updated', conversation: view });
    }
    for (const uid of listMemberIds(id)) {
      const view = buildConversationView(id, uid);
      if (view) sendToUser(uid, { t: 'conversation.updated', conversation: view }, { persist: false });
    }
    audit({ actorId: auth.userId, action: 'conversation.members_added', target: { type: 'conversation', id }, meta: { count: body.userIds.length } });
    return reply.status(201).send({ conversation });
  });

  app.delete('/conversations/:id/members/:userId', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    removeMember(auth.userId, id, userId);
    for (const uid of listMemberIds(id)) {
      sendToUser(uid, { t: 'conversation.member_left', conversationId: id, userId });
    }
    sendToUser(userId, { t: 'conversation.member_left', conversationId: id, userId });
    audit({ actorId: auth.userId, action: 'conversation.member_removed', target: { type: 'user', id: userId }, meta: { conversationId: id } });
    return reply.send({ ok: true });
  });

  app.post('/conversations/:id/leave', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    leaveConversation(auth.userId, id);
    for (const uid of listMemberIds(id)) {
      sendToUser(uid, { t: 'conversation.member_left', conversationId: id, userId: auth.userId });
    }
    return reply.send({ ok: true });
  });

  app.patch('/conversations/:id/members/:userId/role', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const body = z.object({ role: z.enum(['member', 'admin', 'moderator', 'owner']) }).strict().parse(await req.body);
    requireConversationRole(id, auth.userId, 'admin');
    setMemberRole(auth.userId, id, userId, body.role);
    const conversation = toConversation(getConversation(id));
    return reply.send({ conversation });
  });

  /* ── Per-member preferences (pin, archive, mute) ─────────────── */

  app.patch('/conversations/:id/prefs', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    const body = prefsSchema.parse(await req.body);
    const member = setMemberPrefs(auth.userId, id, body);
    const view = buildConversationView(id, auth.userId);
    return reply.send({ member, conversation: view });
  });

  /* ── Read state ──────────────────────────────────────────────── */
  // Message history lives in routes/messages.ts and call history in
  // routes/calls.ts, so each resource has exactly one owner. Declaring the same
  // path twice would make Fastify refuse to boot, which is the right behaviour.

  app.get('/conversations/:id/unread', { config: { rateLimit: rateLimitConfig('api') } }, async (req, reply) => {
    shortCache(reply, 5);
    const auth = requireAuth(req);
    const { id } = idParam.parse(req.params);
    return { unread: unreadCount(auth.userId, id) };
  });
}
