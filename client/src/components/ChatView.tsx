/**
 * Chat view: header, transcript, composer.
 *
 * Bubble styling follows WhatsApp (mine right + coloured, theirs left + neutral)
 * with Instagram's tighter radii, because that pairing is the one people already
 * read correctly without being taught.
 *
 * Consecutive messages from the same sender within 4 minutes are "grouped": no
 * repeated avatar, no repeated name, tighter vertical rhythm. That single rule is
 * what makes a transcript feel calm rather than like a list of cards.
 *
 * Scrolling: the view sticks to the bottom while you are at the bottom, and stops
 * sticking the moment you scroll up to read history — then a "new messages" pill
 * appears. Getting this wrong is the most common way a chat UI feels broken.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store/appStore';
import type { Message } from '../lib/api';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { displayHandle, formatClock, formatDayLabel, splitLinks } from '../lib/format';

const GROUP_WINDOW_MS = 4 * 60_000;

export function ChatView({ onBack, onOpenInfo }: { onBack: () => void; onOpenInfo: () => void }): JSX.Element {
  const {
    activeConversationId, conversations, messages, profile, presence, typing,
    sendText, deleteMessage, setTyping, loadMoreMessages, loadingMessages, socketStatus,
  } = useApp();

  const view = conversations.find((c) => c.conversation.id === activeConversationId) ?? null;
  const list = (activeConversationId ? messages[activeConversationId] : undefined) ?? [];
  const isGroup = view?.conversation.kind === 'group';
  const isSelf = view?.conversation.kind === 'self';

  // A direct conversation's counterpart is the one member who is not you. The
  // server does not send a separate field for it, because `members` already
  // says everything and a second source of truth could disagree.
  const counterpart = view
    ? view.members.find((m) => m.id !== profile?.id) ?? null
    : null;
  const title = isSelf
    ? 'Saved messages'
    : isGroup
      ? view?.conversation.title || 'Group'
      : counterpart?.displayName || displayHandle(counterpart?.handle);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastCountRef = useRef(list.length);

  /* ── Scroll behaviour ─────────────────────────────────────────── */

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // useLayoutEffect rather than useEffect: measuring after paint produces a
  // visible jump when a message arrives while you are already at the bottom.
  useLayoutEffect(() => {
    if (atBottom) scrollToBottom(false);
    else if (list.length > lastCountRef.current) {
      setNewCount((n) => n + (list.length - lastCountRef.current));
    }
    lastCountRef.current = list.length;
  }, [list.length, atBottom, scrollToBottom]);

  // Opening a different conversation always starts at the bottom.
  useEffect(() => {
    setAtBottom(true);
    setNewCount(0);
    lastCountRef.current = 0;
    scrollToBottom(false);
  }, [activeConversationId, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distance < 80;
    setAtBottom(bottom);
    if (bottom) setNewCount(0);
    // Load older messages before the user hits the very top.
    if (el.scrollTop < 220 && !loadingMessages) void loadMoreMessages(activeConversationId ?? '');
  }, [activeConversationId, loadMoreMessages, loadingMessages]);

  /* ── Typing indicator ─────────────────────────────────────────── */
  // Sent on a throttle, and always followed by a "stopped" so the other side
  // never sees a stuck indicator.
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  const signalTyping = useCallback(() => {
    if (!activeConversationId) return;
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      setTyping(activeConversationId, true);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      isTypingRef.current = false;
      if (activeConversationId) setTyping(activeConversationId, false);
    }, 2200);
  }, [activeConversationId, setTyping]);

  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (isTypingRef.current && activeConversationId) setTyping(activeConversationId, false);
  }, [activeConversationId, setTyping]);

  const typers = useMemo(() => {
    if (!activeConversationId) return [];
    const bucket = typing[activeConversationId] ?? {};
    const now = Date.now();
    return Object.entries(bucket)
      .filter(([userId, ts]) => userId !== profile?.id && now - ts < 6000)
      .map(([userId]) => userId);
  }, [typing, activeConversationId, profile?.id]);

  if (!view || !activeConversationId) {
    return (
      <section className="main">
        <div className="empty">
          <div style={{ opacity: 0.35 }}><Icon name="chats" size={62} strokeWidth={1.2} /></div>
          <h2 className="empty-title">Select a conversation</h2>
          <p className="empty-text">
            Your messages are end to end between you and the people in the chat.
            Vesper relays them; it does not read them.
          </p>
        </div>
      </section>
    );
  }

  const online = counterpart ? presence[counterpart.id] === 'online' : false;

  return (
    <section className="main">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="chat-header">
        <button className="icon-btn back-btn" onClick={onBack} aria-label="Back to conversations">
          <Icon name="back" size={20} />
        </button>
        <button onClick={onOpenInfo} className="center grow" style={{ gap: 11, textAlign: 'left', minWidth: 0 }}>
          <Avatar
            seed={isSelf ? 'saved' : counterpart?.id ?? view.conversation.id}
            handle={counterpart?.handle ?? view.conversation.title}
            displayName={counterpart?.displayName ?? view.conversation.title}
            size="sm"
            group={isGroup}
            self={isSelf}
            online={online}
            showPresence={!isGroup && !isSelf}
          />
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="truncate strong" style={{ display: 'block', fontSize: 15, letterSpacing: '-0.01em' }}>
              {title}
            </span>
            <span className="truncate" style={{ display: 'block', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              {isGroup
                ? `${(view.members ?? []).length} members`
                : isSelf
                  ? 'Only visible to you'
                  : typers.length > 0
                    ? 'typing…'
                    : online
                      ? 'online'
                      : counterpart?.handle
                        ? displayHandle(counterpart.handle)
                        : ''}
            </span>
          </span>
        </button>
        {socketStatus !== 'open' && (
          <span className="chip chip-warning" style={{ fontSize: 11, flex: 'none' }}>
            <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />
            {socketStatus === 'reconnecting' ? 'Reconnecting' : 'Offline'}
          </span>
        )}
        <button className="icon-btn" onClick={onOpenInfo} aria-label="Conversation details" title="Details">
          <Icon name="info" size={19} />
        </button>
      </header>

      {/* ── Transcript ─────────────────────────────────────────── */}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {loadingMessages && (
          <div style={{ display: 'grid', placeItems: 'center', padding: '6px 0 12px' }}>
            <span className="spinner" />
          </div>
        )}

        {list.length === 0 && !loadingMessages && (
          <div className="empty" style={{ flex: 'none', padding: '48px 20px' }}>
            <div style={{ opacity: 0.3 }}><Icon name={isSelf ? 'archive' : 'chat'} size={46} strokeWidth={1.3} /></div>
            <p className="empty-text">
              {isSelf
                ? 'Notes, links and files you send here stay on your own account.'
                : 'No messages yet. Say hello — nothing is stored about who you are.'}
            </p>
          </div>
        )}

        <MessageList
          list={list}
          myId={profile?.id ?? ''}
          isGroup={!!isGroup}
          onDelete={deleteMessage}
          conversationId={activeConversationId}
        />

        {typers.length > 0 && (
          <div className="typing-row" aria-live="polite">
            <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="dim" style={{ fontSize: 12.5 }}>
              {isGroup ? `${typers.length} ${typers.length === 1 ? 'person is' : 'people are'} typing` : 'typing'}
            </span>
          </div>
        )}
      </div>

      {/* New-messages pill: appears only when you have scrolled away. */}
      {!atBottom && newCount > 0 && (
        <button
          onClick={() => { setNewCount(0); setAtBottom(true); scrollToBottom(true); }}
          className="btn btn-primary btn-sm"
          style={{ position: 'absolute', right: 18, bottom: 96, boxShadow: 'var(--sh-2)', zIndex: 3 }}
        >
          <Icon name="chevronDown" size={15} /> {newCount} new
        </button>
      )}

      <Composer
        disabled={isSelf === false && !counterpart && !isGroup ? false : false}
        onSend={(text) => {
          void sendText(activeConversationId, text);
          setAtBottom(true);
          scrollToBottom(true);
        }}
        onTyping={signalTyping}
      />
    </section>
  );
}

/* ─────────────────────────── Transcript ─────────────────────────── */

function MessageList({ list, myId, isGroup, onDelete, conversationId }: {
  list: Message[]; myId: string; isGroup: boolean;
  onDelete: (cid: string, mid: string, forEveryone: boolean) => Promise<void>;
  conversationId: string;
}): JSX.Element {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const presence = useApp((s) => s.presence);
  const conversations = useApp((s) => s.conversations);
  const members = conversations.find((c) => c.conversation.id === conversationId)?.members ?? [];

  const memberOf = useCallback((id: string) => members.find((m) => m.id === id) ?? null, [members]);

  return (
    <>
      {list.map((m, i) => {
        const prev = list[i - 1];
        const mine = m.senderId === myId;
        const sameDay = prev && new Date(prev.createdAt).toDateString() === new Date(m.createdAt).toDateString();
        const grouped = !!prev
          && sameDay
          && prev.senderId === m.senderId
          && m.createdAt - prev.createdAt < GROUP_WINDOW_MS
          && !prev.deletedAt;

        const showDaySep = !prev || !sameDay;
        const sender = memberOf(m.senderId);

        return (
          <div key={m.id} style={{ display: 'contents' }}>
            {showDaySep && <div className="day-sep">{formatDayLabel(m.createdAt)}</div>}
            <MessageBubble
              message={m}
              mine={mine}
              grouped={grouped}
              showSender={isGroup && !mine && !grouped}
              senderHandle={sender?.handle ?? null}
              senderName={sender?.displayName ?? null}
              menuOpen={menuFor === m.id}
              onToggleMenu={() => setMenuFor(menuFor === m.id ? null : m.id)}
              onCloseMenu={() => setMenuFor(null)}
              onDelete={(forEveryone) => {
                setMenuFor(null);
                void onDelete(conversationId, m.id, forEveryone);
              }}
              online={!isGroup && !mine && presence[m.senderId] === 'online'}
            />
          </div>
        );
      })}
    </>
  );
}

function MessageBubble({ message, mine, grouped, showSender, senderHandle, senderName, menuOpen, onToggleMenu, onCloseMenu, onDelete, online }: {
  message: Message; mine: boolean; grouped: boolean; showSender: boolean;
  senderHandle: string | null; senderName: string | null;
  menuOpen: boolean; onToggleMenu: () => void; onCloseMenu: () => void;
  onDelete: (forEveryone: boolean) => void; online: boolean;
}): JSX.Element {
  const pending = (message as Message & { pending?: boolean }).pending === true;
  const failed = message.status === 'failed';
  const text = message.body?.text ?? '';

  // Close the menu on any outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-msg-menu]')) onCloseMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseMenu(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, onCloseMenu]);

  return (
    <div className="msg-row" data-mine={mine} data-grouped={grouped}>
      {!mine && !grouped ? (
        <Avatar seed={message.senderId} handle={senderHandle} displayName={senderName} size="xs" online={online} />
      ) : !mine ? (
        <span style={{ width: 28, flex: 'none' }} aria-hidden="true" />
      ) : null}

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', position: 'relative' }}>
        {showSender && (
          <span className="msg-sender" style={{ paddingLeft: 4 }}>
            {senderName || displayHandle(senderHandle)}
          </span>
        )}

        <div
          className="bubble"
          onContextMenu={(e) => { e.preventDefault(); onToggleMenu(); }}
          style={failed ? { opacity: 0.75 } : pending ? { opacity: 0.72 } : undefined}
        >
          <RichText text={text} mine={mine} />
          <span className="msg-meta">
            {message.editedAt ? <span>edited</span> : null}
            <span>{formatClock(message.createdAt)}</span>
            {mine && <StatusMark status={failed ? 'failed' : pending ? 'sending' : message.status ?? 'sent'} />}
          </span>
        </div>

        {menuOpen && (
          <div
            data-msg-menu
            className="card"
            role="menu"
            style={{ position: 'absolute', top: '100%', [mine ? 'right' : 'left']: 0, marginTop: 4, padding: 4, zIndex: 5, minWidth: 178, boxShadow: 'var(--sh-3)' }}
          >
            <MenuItem icon="copy" label="Copy text" onClick={() => { void navigator.clipboard?.writeText(text); onCloseMenu(); }} />
            {mine && <MenuItem icon="trash" label="Delete for me" onClick={() => onDelete(false)} />}
            {mine && <MenuItem icon="ban" label="Delete for everyone" onClick={() => onDelete(true)} danger />}
            {!mine && <MenuItem icon="flag" label="Report message" onClick={onCloseMenu} />}
          </div>
        )}

        {!mine && (
          <button
            className="icon-btn"
            onClick={onToggleMenu}
            aria-label="Message options"
            style={{ position: 'absolute', width: 26, height: 26, top: 2, right: -30, opacity: menuOpen ? 1 : 0, transition: 'opacity 140ms ease' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
          >
            <Icon name="chevronDown" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: Parameters<typeof Icon>[0]['name']; label: string; onClick: () => void; danger?: boolean }): JSX.Element {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="center"
      style={{
        width: '100%', gap: 10, padding: '9px 11px', borderRadius: 'var(--r-sm)',
        fontSize: 13.5, textAlign: 'left', color: danger ? 'var(--danger)' : 'var(--text)',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <Icon name={icon} size={16} /> {label}
    </button>
  );
}

function StatusMark({ status }: { status: string }): JSX.Element {
  if (status === 'failed') {
    return (
      <span className="msg-status" data-status="failed" title="Not delivered — tap to retry">
        <Icon name="alert" size={13} />
      </span>
    );
  }
  if (status === 'sending') return <span className="msg-status" title="Sending"><Icon name="clock" size={13} /></span>;
  if (status === 'read') return <span className="msg-status" title="Read"><Icon name="checks" size={14} /></span>;
  if (status === 'delivered') return <span className="msg-status" title="Delivered"><Icon name="checks" size={14} style={{ opacity: 0.72 }} /></span>;
  return <span className="msg-status" title="Sent"><Icon name="check" size={13} /></span>;
}

/**
 * Render message text with clickable links but nothing else.
 *
 * React escapes by default, so this is safe without sanitisation — and it stays
 * safe if someone later adds bold or mentions, because we never set innerHTML.
 * Links get `rel="noreferrer noopener"`: a leaked Referer from an anonymous app
 * would carry the user's handle to a third party.
 */
function RichText({ text, mine }: { text: string; mine: boolean }): JSX.Element {
  if (!text) return <span className="dim">(empty)</span>;
  const parts = splitLinks(text);
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'link' ? (
          <a
            key={i}
            href={p.value}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: mine ? '#fff' : 'var(--brand-500)', textDecoration: 'underline', wordBreak: 'break-all' }}
          >
            {p.value}
          </a>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </>
  );
}

/* ─────────────────────────── Composer ─────────────────────────── */

/**
 * Every sharing kind Vesper's pipeline is built for. The server gates them
 * behind feature flags (all off at launch), so the client shows them honestly:
 * present in the menu, locked, and explained — never hidden and never faked.
 */
const ATTACH_KINDS: { icon: Parameters<typeof Icon>[0]['name']; label: string }[] = [
  { icon: 'image', label: 'Photo' },
  { icon: 'camera', label: 'Camera' },
  { icon: 'video', label: 'Video' },
  { icon: 'smile', label: 'GIF' },
  { icon: 'mic', label: 'Voice' },
  { icon: 'doc', label: 'File' },
  { icon: 'location', label: 'Place' },
  { icon: 'contact', label: 'Contact' },
  { icon: 'sticker', label: 'Sticker' },
  { icon: 'calendar', label: 'Event' },
];

function Composer({ onSend, onTyping }: { disabled: boolean; onSend: (text: string) => void; onTyping: () => void }): JSX.Element {
  const [draft, setDraft] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const notify = useApp((s) => s.notify);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Close the attach popover on outside click or Escape, like any menu.
  useEffect(() => {
    if (!attachOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-attach-pop]') && !t.closest('[data-attach-btn]')) setAttachOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setAttachOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [attachOpen]);

  // Auto-grow to fit the draft, capped so a long message cannot push the
  // transcript off screen.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  function submit(): void {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
    requestAnimationFrame(() => areaRef.current?.focus());
  }

  return (
    <div className="composer safe-bottom">
      {attachOpen && (
        <div className="attach-pop card stagger" data-attach-pop role="menu" aria-label="Attachment types">
          {ATTACH_KINDS.map((k) => (
            <button
              key={k.label}
              className="attach-item"
              role="menuitem"
              onClick={() => {
                setAttachOpen(false);
                notify('info', `${k.label} sharing is built and waiting on its feature flag — text chat launches first.`);
              }}
            >
              <span className="attach-ico">
                <Icon name={k.icon} size={19} />
                <span className="lockdot"><Icon name="lock" size={9} strokeWidth={2.4} /></span>
              </span>
              <span>{k.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-row">
        <button
          className="icon-btn"
          data-attach-btn
          onClick={() => setAttachOpen((v) => !v)}
          aria-label="Attach"
          aria-expanded={attachOpen}
          title="Photos, files, location, contacts and more"
          style={{ marginBottom: 2, flex: 'none' }}
        >
          <Icon name="paperclip" size={19} />
        </button>
        <textarea
          ref={areaRef}
          className="composer-input"
          rows={1}
          placeholder="Message…"
          value={draft}
          aria-label="Message"
          onChange={(e) => { setDraft(e.target.value); onTyping(); }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline. This is the WhatsApp
            // web convention and the one people try first.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {draft.trim() ? (
          <button className="send-btn" onClick={submit} aria-label="Send message">
            <Icon name="send" size={19} />
          </button>
        ) : (
          <button className="send-btn" disabled aria-label="Nothing to send" title="Media and calls arrive in a later release">
            <Icon name="mic" size={19} />
          </button>
        )}
      </div>
      <p className="hint" style={{ textAlign: 'center', marginTop: 8, fontSize: 11.5 }}>
        Enter to send · Shift+Enter for a new line · Photos, voice notes and calls arrive in a later release
      </p>
    </div>
  );
}
