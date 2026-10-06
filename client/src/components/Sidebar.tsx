/**
 * Sidebar: identity, search, and the conversation list.
 *
 * Layout follows WhatsApp/Telegram rather than Instagram's feed model, because
 * this is a messenger first: the list is the primary surface and a conversation
 * is one tap away.
 *
 * Two details worth noting:
 *  - The header shows your own handle with a "tap to copy" affordance. On an
 *    anonymous app your handle IS your contact card, so sharing it must be
 *    frictionless.
 *  - Unread badges are cleared locally the instant a chat is opened, without
 *    waiting for the server, because a badge that lingers feels broken.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store/appStore';
import type { ConversationView } from '../lib/api';
import type { Contact } from '@shared/types';
import { Avatar } from './Avatar';
import { Icon, Logo } from './Icon';
import { displayHandle, formatListTime, initials, previewOf } from '../lib/format';

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const {
    conversations, profile, socketStatus, activeConversationId, openConversation,
    searchUsers, searchResults, contacts, conversationsCursor, loadingMoreConversations, loadMoreConversations,
  } = useApp();
  const myId = profile?.id ?? '';
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced directory search. 300ms is long enough that typing a handle does
  // not fire a request per keystroke, short enough that it feels immediate.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (query.trim().length < 2) {
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      void searchUsers(query);
      setSearching(false);
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, searchUsers]);

  const pendingCount = (contacts.pending ?? []).length;

  const sorted = useMemo(() => {
    const list = [...conversations];
    list.sort((a, b) => {
      // `pinned` is per-member state, so it lives on `member`, not on the view.
      if (!!a.member.pinned !== !!b.member.pinned) return a.member.pinned ? -1 : 1;
      return (b.conversation.lastMessageAt ?? b.conversation.createdAt) - (a.conversation.lastMessageAt ?? a.conversation.createdAt);
    });
    return list;
  }, [conversations]);

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <Logo size={30} />
        <span className="grow" />
        <ConnectionPill status={socketStatus} />
        <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings" title="Settings">
          <Icon name="settings" size={19} />
        </button>
      </header>

      {/* Identity strip: your handle is your contact card. */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <Avatar seed={profile?.id ?? 'me'} handle={profile?.handle} displayName={profile?.displayName} size="sm" />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="truncate strong" style={{ fontSize: 14 }}>
            {profile?.displayName || 'Anonymous'}
          </div>
          <HandleCopy handle={profile?.handle ?? ''} />
        </div>
        {pendingCount > 0 && (
          <span className="chip chip-brand" title={`${pendingCount} pending contact request(s)`}>
            <Icon name="users" size={13} /> {pendingCount}
          </span>
        )}
      </div>

      <div style={{ padding: '6px 12px 10px' }}>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>
            <Icon name="search" size={17} />
          </span>
          <input
            className="input"
            style={{ paddingLeft: 38, minHeight: 40, borderRadius: 'var(--r-pill)', background: 'var(--bg-sunken)', border: '1px solid transparent' }}
            type="search"
            placeholder="Search a handle…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search people by handle"
          />
        </div>
      </div>

      <OnlineRail />

      <div className="sidebar-scroll stagger">
        {query.trim().length >= 2 ? (
          <SearchResults results={searchResults} loading={searching} query={query} onDone={() => setQuery('')} />
        ) : sorted.length === 0 ? (
          <EmptyConversations />
        ) : (
          <>
            {sorted.map((c) => (
              <ConversationRow
                key={c.conversation.id}
                view={c}
                active={c.conversation.id === activeConversationId}
                onOpen={() => void openConversation(c.conversation.id)}
                myId={myId}
              />
            ))}
            {conversationsCursor && (
              <button
                className="btn btn-ghost btn-block"
                style={{ margin: '10px 14px', width: 'calc(100% - 28px)' }}
                disabled={loadingMoreConversations}
                onClick={() => void loadMoreConversations()}
              >
                {loadingMoreConversations ? 'Loading…' : 'Load older conversations'}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * "Online now" rail: story-style rings (Instagram) around the contacts whose
 * real presence is `online` right now. Nothing here is invented — the rail
 * simply does not render when nobody you know is around.
 */
function OnlineRail(): JSX.Element | null {
  const contacts = useApp((s) => s.contacts.contacts) as Contact[];
  const presence = useApp((s) => s.presence);
  const openDmWith = useApp((s) => s.openDmWith);
  const notify = useApp((s) => s.notify);

  const online = contacts.filter((c) => presence[c.contactUserId] === 'online');
  if (online.length === 0) return null;

  return (
    <div className="online-rail stagger" aria-label="Online now">
      {online.map((c) => {
        const p = c.profile;
        const name = c.alias || p?.displayName || displayHandle(p?.handle);
        return (
          <button
            key={c.id}
            className="rail-item"
            title={`Message ${name}`}
            onClick={() => {
              void openDmWith(c.contactUserId).catch((e) =>
                notify('error', e instanceof Error ? e.message : 'Could not open that conversation'),
              );
            }}
          >
            <span className="story-ring" data-online="true">
              <Avatar seed={c.contactUserId} handle={p?.handle} displayName={p?.displayName} size="md" />
            </span>
            <span className="rail-name">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

function ConversationRow({ view, active, onOpen, myId }: { view: ConversationView; active: boolean; onOpen: () => void; myId: string }): JSX.Element {  const { conversation, member, members, lastMessage, unreadCount } = view;
  const pinned = member.pinned;
  // The counterpart of a DM is whichever member is not you.
  const counterpart = members.find((m) => m.id !== myId) ?? null;
  const isGroup = conversation.kind === 'group';
  const isSelf = conversation.kind === 'self';
  const name = isSelf
    ? 'Saved messages'
    : isGroup
      ? conversation.title || `Group · ${(view.members ?? []).length}`
      : counterpart?.displayName || displayHandle(counterpart?.handle);

  const presence = useApp((s) => (counterpart ? s.presence[counterpart.id] : undefined));
  const preview = lastMessage ? previewOf(lastMessage as never) : 'No messages yet';
  const when = formatListTime(conversation.lastMessageAt ?? conversation.createdAt);

  return (
    <button className="conv-item" data-active={active} onClick={onOpen} aria-current={active}>
      <Avatar
        seed={isSelf ? 'saved' : counterpart?.id ?? conversation.id}
        handle={counterpart?.handle ?? conversation.title}
        displayName={counterpart?.displayName ?? conversation.title}
        size="md"
        group={isGroup}
        self={isSelf}
        online={!isGroup && !isSelf && presence === 'online'}
        showPresence={!isGroup && !isSelf}
      />
      <span className="conv-main">
        <span className="conv-top">
          <span className="conv-name">{name}</span>
          {pinned && <Icon name="pin" size={13} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />}
          <span className="conv-time">{when}</span>
        </span>
        <span className="conv-bottom">
          <span className="conv-preview">{preview}</span>
          {!!unreadCount && unreadCount > 0 && (
            <span className="badge" aria-label={`${unreadCount} unread`}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function HandleCopy({ handle }: { handle: string }): JSX.Element {
  const notify = useApp((s) => s.notify);
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    const text = displayHandle(handle);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context; fall back to a temporary field so
      // copying still works over plain HTTP in development.
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); } catch { /* nothing left to try */ }
      document.body.removeChild(el);
    }
    setCopied(true);
    notify('success', `${text} copied — share it to let someone message you`);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button
      onClick={() => void copy()}
      title="Copy your handle"
      className="center dim"
      style={{ gap: 4, fontSize: 12.5, maxWidth: '100%' }}
    >
      <span className="truncate mono">{displayHandle(handle)}</span>
      <Icon name={copied ? 'check' : 'copy'} size={12} style={{ flex: 'none', color: copied ? 'var(--success)' : undefined }} />
    </button>
  );
}

function ConnectionPill({ status }: { status: string }): JSX.Element {
  if (status === 'open') return <span style={{ width: 0 }} />;
  const label = status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? 'Connecting…' : 'Offline';
  return (
    <span className={`chip ${status === 'closed' ? 'chip-danger' : 'chip-warning'}`} style={{ fontSize: 11 }}>
      {status !== 'closed' && <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />}
      {label}
    </span>
  );
}

function EmptyConversations(): JSX.Element {
  return (
    <div style={{ padding: '36px 24px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
      <div style={{ display: 'grid', placeItems: 'center', marginBottom: 14, opacity: 0.5 }}>
        <Icon name="chats" size={40} strokeWidth={1.3} />
      </div>
      <p className="strong" style={{ color: 'var(--text-secondary)', fontSize: 14.5 }}>No conversations yet</p>
      <p className="hint" style={{ marginTop: 6, lineHeight: 1.6 }}>
        Search a handle above, or share your own. A conversation starts once the
        other person accepts your request.
      </p>
    </div>
  );
}

function SearchResults({ results, loading, query, onDone }: {
  results: unknown[]; loading: boolean; query: string; onDone: () => void;
}): JSX.Element {
  const { openDmWith, addContact, notify } = useApp();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (loading) {
    return (
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="center" style={{ gap: 12 }}>
            <div className="skeleton" style={{ width: 46, height: 46, borderRadius: '50%' }} />
            <div className="grow">
              <div className="skeleton" style={{ height: 12, width: '55%', marginBottom: 7 }} />
              <div className="skeleton" style={{ height: 10, width: '35%' }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const people = results as { id: string; handle: string; displayName: string | null }[];
  if (!people.length) {
    return (
      <div style={{ padding: '28px 20px', textAlign: 'center' }}>
        <p className="hint">No account matches “{query}”.</p>
        <p className="hint" style={{ marginTop: 8, lineHeight: 1.6 }}>
          Handles are exact. If someone set their profile to contacts-only, they
          will not appear here even if they exist.
        </p>
      </div>
    );
  }

  return (
    <div>
      {people.map((p) => (
        <div key={p.id} className="conv-item" style={{ cursor: 'default' }}>
          <Avatar seed={p.id} handle={p.handle} displayName={p.displayName} size="md" />
          <div className="conv-main">
            <div className="conv-name">{p.displayName || 'Anonymous'}</div>
            <div className="conv-preview mono" style={{ fontSize: 12.5 }}>{displayHandle(p.handle)}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
            <button
              className="btn btn-quiet btn-sm"
              disabled={busyId === p.id}
              onClick={async () => {
                setBusyId(p.id);
                try {
                  await addContact(undefined, p.id);
                } finally {
                  setBusyId(null);
                }
              }}
              title="Add contact"
            >
              <Icon name="plus" size={15} />
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={busyId === p.id}
              onClick={async () => {
                setBusyId(p.id);
                try {
                  await openDmWith(p.id);
                  onDone();
                } catch (e) {
                  notify('error', e instanceof Error ? e.message : 'Could not open that conversation');
                } finally {
                  setBusyId(null);
                }
              }}
            >
              Message
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Convenience re-export so callers can render initials consistently. */
export { initials };
