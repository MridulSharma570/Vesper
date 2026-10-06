/**
 * Client state.
 *
 * Zustand rather than Redux/Context because the store is read from inside the
 * WebSocket frame handler, which is outside React's render cycle. A plain
 * mutable store with selectors keeps socket-driven updates from forcing a
 * re-render of the whole tree.
 *
 * Persistence: only the tokens and the device identity survive a reload
 * (handled in lib/api.ts). Conversation and message state is re-fetched on boot,
 * because a stale local cache is how a chat app shows messages that were deleted.
 */
import { create } from 'zustand';
import type { ConversationView, FeatureFlags, Message, PresenceState, PrivateProfile, UserSettings } from '@shared/types';
import { api, clearAuth, getAccessToken, getRefreshToken } from '../lib/api';
import { realtime, type SocketStatus } from '../lib/realtime';

/**
 * An optimistic message is a full `Message` with one extra client-only flag, so
 * the transcript can render it through exactly the same path as a confirmed one.
 * Duplicating the shape would mean two renderers to keep in sync.
 */
export interface OptimisticMessage extends Message {
  pending?: true;
  failed?: boolean;
}

interface AppState {
  /* session */
  bootstrapped: boolean;
  profile: PrivateProfile | null;
  settings: UserSettings | null;
  flags: FeatureFlags | null;
  socketStatus: SocketStatus;

  /* data */
  conversations: ConversationView[];
  activeConversationId: string | null;
  messages: Record<string, Message[]>;
  cursors: Record<string, string | null>;
  loadingMessages: boolean;
  typing: Record<string, Record<string, number>>;
  presence: Record<string, PresenceState>;
  contacts: { contacts: unknown[]; pending: unknown[] };
  searchResults: unknown[];

  /* ui */
  toast: { kind: 'info' | 'error' | 'success'; text: string } | null;
  verifyStep: null | {
    challengeId: string;
    channel: 'email' | 'sms' | 'app';
    targetHint: string;
    kind: string;
  };

  /* actions */
  bootstrap: () => Promise<void>;
  signInAnonymously: () => Promise<void>;
  signInWithPassword: (identifier: string, password: string) => Promise<void>;
  registerWithPassword: (i: { identifier: string; password: string; handle?: string; displayName?: string }) => Promise<void>;
  startOtp: (kind: 'otp_email' | 'otp_sms', target: string) => Promise<void>;
  submitOtp: (code: string) => Promise<void>;
  signOut: (everywhere?: boolean) => Promise<void>;

  loadConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  openDmWith: (userId: string) => Promise<string>;
  createGroup: (title: string, memberIds: string[]) => Promise<string>;
  loadMoreMessages: (id: string) => Promise<void>;
  sendText: (conversationId: string, text: string) => Promise<void>;
  deleteMessage: (conversationId: string, messageId: string, forEveryone: boolean) => Promise<void>;
  setTyping: (conversationId: string, isTyping: boolean) => void;
  markRead: (conversationId: string, messageId: string) => void;

  refreshSettings: () => Promise<void>;
  patchSettings: (patch: Record<string, unknown>) => Promise<void>;
  patchProfile: (patch: { displayName?: string | null; bio?: string | null }) => Promise<void>;
  rotateHandle: () => Promise<void>;
  searchUsers: (q: string) => Promise<void>;
  loadContacts: () => Promise<void>;
  addContact: (handle?: string, userId?: string) => Promise<void>;
  respondContact: (requestId: string, accept: boolean) => Promise<void>;
  blockUser: (userId: string) => Promise<void>;
  report: (targetType: string, targetId: string, reason: string, details?: string) => Promise<void>;
  deleteAccount: (confirmation: string) => Promise<void>;

  notify: (kind: 'info' | 'error' | 'success', text: string) => void;
  dismissToast: () => void;
  setActiveConversation: (id: string | null) => void;
}

export const useApp = create<AppState>((set, get) => ({
  bootstrapped: false,
  profile: null,
  settings: null,
  flags: null,
  socketStatus: 'idle',
  conversations: [],
  activeConversationId: null,
  messages: {},
  cursors: {},
  loadingMessages: false,
  typing: {},
  presence: {},
  contacts: { contacts: [], pending: [] },
  searchResults: [],
  toast: null,
  verifyStep: null,

  /* ── Boot ─────────────────────────────────────────────────────── */

  async bootstrap() {
    // Wire the socket once, before any auth attempt, so frames arriving during
    // sign-in are not missed.
    realtime.onStatus((socketStatus) => set({ socketStatus }));
    realtime.onFrame((frame) => handleFrame(frame, set, get));

    // Everything below is guarded: a blocked storage backend or an unreachable
    // API must land the user on the sign-in screen with a toast, never on an
    // infinite splash.
    let hasTokens = false;
    try {
      hasTokens = !!getRefreshToken() || !!getAccessToken();
    } catch {
      hasTokens = false;
    }
    if (!hasTokens) {
      set({ bootstrapped: true });
      return;
    }
    try {
      const { profile, settings } = await api.me();
      set({ profile, settings, bootstrapped: true });
      realtime.connect();
      await get().loadConversations();
      await get().loadContacts();
    } catch {
      // A stale or revoked refresh token must land on the sign-in screen rather
      // than in a broken half-authenticated state.
      try { clearAuth(); } catch { /* storage already unusable */ }
      set({ profile: null, settings: null, bootstrapped: true });
    }
  },

  /* ── Auth ─────────────────────────────────────────────────────── */

  async signInAnonymously() {
    const r = await api.deviceKeySignIn();
    if ('step' in r) {
      set({ verifyStep: { challengeId: r.challengeId, channel: r.channel, targetHint: r.targetHint, kind: r.kind } });
      return;
    }
    await afterSignIn(r.profile, r.flags, set, get);
  },

  async signInWithPassword(identifier, password) {
    const r = await api.passwordSignIn(identifier, password);
    if ('step' in r) {
      set({ verifyStep: { challengeId: r.challengeId, channel: r.channel, targetHint: r.targetHint, kind: r.kind } });
      return;
    }
    await afterSignIn(r.profile, r.flags, set, get);
  },

  async registerWithPassword(input) {
    const r = await api.passwordRegister(input);
    if ('step' in r) {
      set({ verifyStep: { challengeId: r.challengeId, channel: r.channel, targetHint: r.targetHint, kind: r.kind } });
      return;
    }
    await afterSignIn(r.profile, r.flags, set, get);
  },

  async startOtp(kind, target) {
    const r = await api.startOtp(kind, target);
    set({ verifyStep: { challengeId: r.challengeId, channel: kind === 'otp_email' ? 'email' : 'sms', targetHint: target, kind } });
  },

  async submitOtp(code) {
    const step = get().verifyStep;
    if (!step) throw new Error('No verification in progress');
    const r = await api.verifyOtp(step.challengeId, code);
    set({ verifyStep: null });
    await afterSignIn(r.profile, r.flags, set, get);
  },

  async signOut(everywhere = false) {
    try {
      await api.logout(everywhere);
    } catch {
      /* the local clear below is what actually matters */
    }
    realtime.disconnect();
    set({
      profile: null, settings: null, conversations: [], messages: {}, cursors: {},
      activeConversationId: null, contacts: { contacts: [], pending: [] }, presence: {}, typing: {},
    });
  },

  /* ── Conversations ────────────────────────────────────────────── */

  async loadConversations() {
    try {
      const { conversations } = await api.conversations();
      set({ conversations: conversations as ConversationView[] });
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not load conversations'));
    }
  },

  async openConversation(id) {
    set({ activeConversationId: id });
    realtime.subscribe(id);
    if (!get().messages[id]) {
      set({ loadingMessages: true });
      try {
        const { messages, nextCursor } = await api.messages(id);
        set((s) => ({
          // Server returns newest-first; the view renders oldest-first.
          messages: { ...s.messages, [id]: [...messages].reverse() },
          cursors: { ...s.cursors, [id]: nextCursor },
        }));
      } catch (e) {
        get().notify('error', messageOf(e, 'Could not load messages'));
      } finally {
        set({ loadingMessages: false });
      }
    }
    // Mark the newest message read, which is what a user opening a chat expects.
    const list = get().messages[id] ?? [];
    const last = list[list.length - 1];
    if (last) get().markRead(id, last.id);
  },

  async openDmWith(userId) {
    const { conversation } = await api.openDm(userId);
    const id = (conversation as { id: string }).id;
    await get().loadConversations();
    await get().openConversation(id);
    return id;
  },

  async createGroup(title, memberIds) {
    const { conversation } = await api.createGroup(title, memberIds);
    await get().loadConversations();
    await get().openConversation(conversation.id);
    return conversation.id;
  },

  async loadMoreMessages(id) {
    const cursor = get().cursors[id];
    if (!cursor || get().loadingMessages) return;
    set({ loadingMessages: true });
    try {
      const { messages, nextCursor } = await api.messages(id, cursor);
      set((s) => ({
        // The API returns newest-first; reversed, this page is the *older* slice,
        // so it belongs in front of what is already rendered.
        messages: { ...s.messages, [id]: [...messages].reverse().concat(s.messages[id] ?? []) },
        cursors: { ...s.cursors, [id]: nextCursor },
      }));
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not load older messages'));
    } finally {
      set({ loadingMessages: false });
    }
  },

  async sendText(conversationId, text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const profile = get().profile;
    if (!profile) return;

    const clientMessageId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // Optimistic bubble: renders immediately, keyed by clientMessageId so the
    // server ack can replace it without a flicker or a duplicate.
    const optimistic: OptimisticMessage = {
      // The clientMessageId stands in as the id until the server ack replaces it.
      // It can never collide with a real snowflake: those are 12-char base36.
      id: clientMessageId,
      conversationId,
      senderId: profile.id,
      kind: 'text',
      body: { text: trimmed, entities: [] },
      status: 'sending',
      createdAt: Date.now(),
      editedAt: null,
      deletedAt: null,
      expiresIn: null,
      expiresAt: null,
      reactions: [],
      readBy: [],
      clientMessageId,
      encrypted: false,
      keyId: null,
      pending: true,
    };
    set((s) => ({ messages: { ...s.messages, [conversationId]: [...(s.messages[conversationId] ?? []), optimistic] } }));

    // Prefer the socket: it is lower latency and the ack is correlated by
    // clientMessageId. HTTP is the fallback when the socket is down.
    if (get().socketStatus === 'open') {
      realtime.send({
        t: 'message.send',
        clientMessageId,
        conversationId,
        kind: 'text',
        body: { text: trimmed, entities: [] },
      });
      return;
    }

    try {
      const { message } = await api.sendMessage({
        conversationId, kind: 'text', clientMessageId, body: { text: trimmed, entities: [] },
      });
      replaceOptimistic(conversationId, clientMessageId, message, set);
    } catch (e) {
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: (s.messages[conversationId] ?? []).map((m) =>
            m.id === clientMessageId ? { ...m, status: 'failed', failed: true } as OptimisticMessage : m,
          ),
        },
      }));
      get().notify('error', messageOf(e, 'Message not sent'));
    }
  },

  async deleteMessage(conversationId, messageId, forEveryone) {
    try {
      await api.deleteMessage(messageId, forEveryone);
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: (s.messages[conversationId] ?? []).filter((m) => m.id !== messageId),
        },
      }));
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not delete message'));
    }
  },

  setTyping(conversationId, isTyping) {
    realtime.send({ t: 'typing', conversationId, isTyping });
  },

  markRead(conversationId, messageId) {
    realtime.send({ t: 'message.read', conversationId, messageId });
    // Clear the badge locally without waiting for a round trip.
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.conversation.id === conversationId ? { ...c, unreadCount: 0 } : c,
      ),
    }));
  },

  /* ── Profile & settings ───────────────────────────────────────── */

  async refreshSettings() {
    try {
      const { settings } = await api.settings();
      set({ settings });
    } catch {
      /* non-fatal */
    }
  },

  async patchSettings(patch) {
    try {
      const { settings } = await api.patchSettings(patch);
      set({ settings });
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not save that setting'));
    }
  },

  async patchProfile(patch) {
    try {
      const { profile } = await api.patchMe(patch);
      set({ profile });
      get().notify('success', 'Profile updated');
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not update profile'));
    }
  },

  async rotateHandle() {
    try {
      const { profile } = await api.rotateHandle();
      set({ profile });
      get().notify('success', `You are now @${profile.handle}`);
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not change handle'));
    }
  },

  async searchUsers(q) {
    if (q.trim().length < 2) {
      set({ searchResults: [] });
      return;
    }
    try {
      const { users } = await api.search(q.trim());
      set({ searchResults: users });
    } catch (e) {
      get().notify('error', messageOf(e, 'Search failed'));
    }
  },

  async loadContacts() {
    try {
      const r = await api.contacts();
      set({ contacts: r as { contacts: unknown[]; pending: unknown[] } });
    } catch {
      /* non-fatal */
    }
  },

  async addContact(handle, userId) {
    try {
      const r = await api.addContact(userId, handle);
      const outcome = (r as { outcome: string }).outcome;
      get().notify('success', outcome === 'mutual' || outcome === 'auto_accepted' ? 'Contact added' : 'Request sent');
      await get().loadContacts();
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not add that contact'));
    }
  },

  async respondContact(requestId, accept) {
    try {
      await api.respondContact(requestId, accept);
      await get().loadContacts();
      await get().loadConversations();
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not update that request'));
    }
  },

  async blockUser(userId) {
    try {
      await api.blockUser(userId);
      get().notify('success', 'Blocked');
      await get().loadContacts();
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not block that account'));
    }
  },

  async report(targetType, targetId, reason, details) {
    try {
      const r = await api.report({ targetType, targetId, reason, details });
      get().notify('success', (r as { message: string }).message ?? 'Report sent');
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not send that report'));
    }
  },

  async deleteAccount(confirmation) {
    try {
      await api.deleteAccount(confirmation);
      await get().signOut(true);
      get().notify('info', 'Your account is scheduled for deletion. You can cancel within 30 days by signing in again.');
    } catch (e) {
      get().notify('error', messageOf(e, 'Could not delete the account'));
    }
  },

  /* ── UI ───────────────────────────────────────────────────────── */

  notify(kind, text) {
    set({ toast: { kind, text } });
    setTimeout(() => {
      if (get().toast?.text === text) set({ toast: null });
    }, 4200);
  },

  dismissToast() {
    set({ toast: null });
  },

  setActiveConversation(id) {
    set({ activeConversationId: id });
    if (id) realtime.subscribe(id);
  },
}));

/* ─────────────────────────── Helpers ─────────────────────────── */

async function afterSignIn(
  profile: PrivateProfile,
  flags: FeatureFlags | undefined,
  set: (p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<void> {
  set({ profile, flags: flags ?? null, verifyStep: null });
  realtime.connect();
  await get().refreshSettings();
  await get().loadConversations();
  await get().loadContacts();
}

function replaceOptimistic(
  conversationId: string,
  clientMessageId: string,
  message: Message,
  set: (fn: (s: AppState) => Partial<AppState>) => void,
): void {
  set((s) => {
    const list = s.messages[conversationId] ?? [];
    const idx = list.findIndex((m) => m.id === clientMessageId);
    if (idx === -1) {
      // The socket may have delivered the real message before the ack arrived.
      return list.some((m) => m.id === message.id) ? {} : { messages: { ...s.messages, [conversationId]: [...list, message] } };
    }
    const next = [...list];
    next[idx] = message;
    return { messages: { ...s.messages, [conversationId]: next } };
  });
}

function messageOf(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = String((e as { message: unknown }).message ?? '');
    if (m) return m;
  }
  return fallback;
}

/** Apply an incoming server frame to the store. */
function handleFrame(
  frame: import('@shared/types').ServerFrame,
  set: (p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): void {
  switch (frame.t) {
    case 'ready':
      set({ flags: frame.features });
      break;

    case 'message.sent': {
      const { clientMessageId, message } = frame;
      replaceOptimistic(message.conversationId, clientMessageId, message, set as never);
      break;
    }

    case 'message.new': {
      const message = frame.message;
      const me = get().profile?.id;
      set((s) => {
        const list = s.messages[message.conversationId] ?? [];
        // Dedupe: the same message can arrive on the socket and via an ack.
        if (list.some((m) => m.id === message.id)) return {};
        // Drop the optimistic copy this message replaces.
        const cleaned = list.filter((m) => !(m.id.startsWith('c-') && m.senderId === message.senderId && m.body?.text === message.body?.text));
        return { messages: { ...s.messages, [message.conversationId]: [...cleaned, message] } };
      });

      // Bump the conversation to the top and update its preview/unread badge.
      set((s) => {
        const existing = s.conversations.find((c) => c.conversation.id === message.conversationId);
        const isActive = s.activeConversationId === message.conversationId;
        const isMine = message.senderId === me;
        if (existing) {
          return {
            conversations: [
              {
                ...existing,
                lastMessage: message,
                unreadCount: isActive || isMine ? 0 : (existing.unreadCount ?? 0) + 1,
              },
              ...s.conversations.filter((c) => c.conversation.id !== message.conversationId),
            ],
          };
        }
        // A conversation we did not have yet (someone new messaged us).
        void get().loadConversations();
        return {};
      });

      if (get().activeConversationId === message.conversationId && message.senderId !== me) {
        get().markRead(message.conversationId, message.id);
      }
      break;
    }

    case 'message.updated': {
      const message = frame.message;
      set((s) => ({
        messages: {
          ...s.messages,
          [message.conversationId]: (s.messages[message.conversationId] ?? []).map((m) =>
            m.id === message.id ? message : m,
          ),
        },
      }));
      break;
    }

    case 'message.deleted': {
      const { id, conversationId, forEveryone } = frame;
      set((s) => ({
        messages: {
          ...s.messages,
          // "Delete for me" only hides it locally; "for everyone" removes it.
          [conversationId]: (s.messages[conversationId] ?? []).filter((m) => m.id !== id || !forEveryone),
        },
      }));
      void forEveryone;
      break;
    }

    case 'message.read': {
      const { conversationId, messageId } = frame as { conversationId: string; messageId: string };
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: (s.messages[conversationId] ?? []).map((m) =>
            m.id === messageId && m.senderId === s.profile?.id ? { ...m, status: 'read' } : m,
          ),
        },
      }));
      break;
    }

    case 'typing': {
      const { conversationId, userId, isTyping } = frame;
      set((s) => {
        const conv = { ...(s.typing[conversationId] ?? {}) };
        if (isTyping) conv[userId] = Date.now();
        else delete conv[userId];
        return { typing: { ...s.typing, [conversationId]: conv } };
      });
      // Auto-expire a typing indicator after 6s, in case the "stopped" frame is
      // lost — a stuck "typing…" is worse than a missing one.
      if (isTyping) {
        setTimeout(() => {
          set((s) => {
            const conv = s.typing[conversationId]?.[userId];
            if (!conv || Date.now() - conv < 6000) return {};
            const next = { ...(s.typing[conversationId] ?? {}) };
            delete next[userId];
            return { typing: { ...s.typing, [conversationId]: next } };
          });
        }, 6000);
      }
      break;
    }

    case 'presence': {
      const events = frame.events;
      set((s) => {
        const next = { ...s.presence };
        for (const e of events) next[e.userId] = e.state;
        return { presence: next };
      });
      break;
    }

    case 'conversation.updated': {
      const conversation = frame.conversation;
      set((s) => {
        const id = conversation.conversation.id;
        const rest = s.conversations.filter((c) => c.conversation.id !== id);
        const existing = s.conversations.find((c) => c.conversation.id === id);
        // Preserve the locally-tracked unread count when the server view does not
        // carry one, so a badge does not flicker on every update.
        const merged = existing && conversation.unreadCount === undefined
          ? { ...conversation, unreadCount: existing.unreadCount }
          : conversation;
        return { conversations: [merged, ...rest] };
      });
      break;
    }

    case 'conversation.member_joined':
    case 'conversation.member_left':
      void get().loadConversations();
      break;

    case 'error': {
      const { code, message } = frame;
      if (code === 'account_restricted' || code === 'maintenance_started') {
        get().notify('error', message);
      }
      break;
    }

    default:
      break;
  }
}
