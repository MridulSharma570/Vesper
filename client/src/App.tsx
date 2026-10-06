/**
 * App shell.
 *
 * Desktop and mobile are the same component tree with one difference: on a wide
 * screen the conversation list and the chat are side by side, on a narrow one they
 * are two panes you switch between. That is how WhatsApp and Snapchat behave, and
 * it is what people expect — so `data-pane` on the root drives it in CSS rather
 * than rendering two different trees that could drift apart.
 *
 * Theme is applied as a `data-theme` attribute on <html>, which lets the CSS
 * custom properties switch without re-rendering React.
 */
import { Component, useEffect, useState, type ReactNode } from 'react';
import { useApp } from './store/appStore';
import { AuthScreen } from './components/AuthScreen';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsView, ChangePasswordModal } from './components/SettingsView';
import { AdminView } from './components/AdminView';
import { Icon } from './components/Icon';

export function App(): JSX.Element {
  const bootstrapped = useApp((s) => s.bootstrapped);
  const profile = useApp((s) => s.profile);
  const settings = useApp((s) => s.settings);
  const bootstrap = useApp((s) => s.bootstrap);
  const activeConversationId = useApp((s) => s.activeConversationId);
  const setActiveConversation = useApp((s) => s.setActiveConversation);

  const [showSettings, setShowSettings] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [pane, setPane] = useState<'list' | 'chat'>('list');

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Every screen gets its own document title, so a tab, a screen-reader
  // announcement and a shared link all say where you actually are.
  useEffect(() => {
    document.title = showAdmin
      ? 'Admin panel · Vesper'
      : showSettings
        ? 'Settings · Vesper'
        : activeConversationId
          ? 'Conversation · Vesper'
          : 'Chats · Vesper';
  }, [showAdmin, showSettings, activeConversationId]);

  // Theme: explicit user choice wins, otherwise follow the OS.
  useEffect(() => {
    const theme = settings?.appearance.theme ?? 'system';
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);

    // Keep the browser UI (address bar, tab strip) in step with the app.
    const dark = theme === 'dark'
      || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    for (const meta of Array.from(document.querySelectorAll('meta[name="theme-color"]'))) {
      const wantsDark = meta.getAttribute('media')?.includes('dark') ?? false;
      if (wantsDark === dark) meta.setAttribute('content', dark ? '#0f1115' : '#f7f8fa');
    }
  }, [settings?.appearance.theme]);

  // Text size scales the whole document, so one root font-size does the job.
  useEffect(() => {
    const size = settings?.appearance.fontSize ?? 'medium';
    document.documentElement.style.fontSize = { small: '14px', medium: '15.5px', large: '17.5px' }[size];
  }, [settings?.appearance.fontSize]);

  // Reduced motion: mirror the setting into a class the CSS can also honour for
  // users who have not set the OS-level preference.
  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', !!settings?.appearance.reducedMotion);
  }, [settings?.appearance.reducedMotion]);

  // Escape closes the settings dialog, which is what a modal must do.
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setShowSettings(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showSettings]);

  // Selecting a conversation on mobile switches panes; on desktop both are visible.
  // This must run before any early return — hooks cannot be conditional.
  useEffect(() => {
    if (activeConversationId) setPane('chat');
  }, [activeConversationId]);

  if (!bootstrapped) return <BootSplash />;
  if (!profile) return <><AuthScreen /><ToastHost /></>;

  return (
    <>
      <div className="app" data-pane={pane}>
        <Sidebar onOpenSettings={() => setShowSettings(true)} />
        <ChatView
          onBack={() => { setActiveConversation(null); setPane('list'); }}
          onOpenInfo={() => setShowSettings(true)}
        />
        <MobileNav pane={pane} onPane={setPane} onSettings={() => setShowSettings(true)} />
      </div>
      {showSettings && (
        <SettingsView
          onClose={() => setShowSettings(false)}
          onOpenAdmin={() => { setShowSettings(false); setShowAdmin(true); }}
        />
      )}
      {showAdmin && <AdminView onClose={() => setShowAdmin(false)} />}
      {/* Staff credential resets land here: undismissable until changed. */}
      {profile?.mustChangePassword && !showAdmin && (
        <ChangePasswordModal forced onClose={() => setShowSettings(false)} />
      )}
      <ToastHost />
    </>
  );
}

/**
 * Mobile bottom navigation. Rendered on every viewport and hidden above 860px by
 * CSS, so there is one source of truth for the tabs.
 */
function MobileNav({ pane, onPane, onSettings }: {
  pane: 'list' | 'chat';
  onPane: (p: 'list' | 'chat') => void;
  onSettings: () => void;
}): JSX.Element {
  const setActiveConversation = useApp((s) => s.setActiveConversation);
  const unread = useApp((s) => s.conversations.reduce((n, c) => n + (c.unreadCount ?? 0), 0));

  return (
    <nav className="mobile-nav" aria-label="Primary">
      <button data-active={pane === 'list'} onClick={() => onPane('list')} aria-label="Conversations">
        <span style={{ position: 'relative' }}>
          <Icon name="chats" size={22} />
          {unread > 0 && (
            <span
              style={{
                position: 'absolute', top: -4, right: -8, minWidth: 16, height: 16, padding: '0 4px',
                borderRadius: 999, background: 'var(--brand-500)', color: '#fff',
                fontSize: 10, fontWeight: 700, display: 'grid', placeItems: 'center',
              }}
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </span>
        Chats
      </button>
      {/* Opening a conversation already switches the pane on narrow screens,
          so a second tab pointing at "the chat" only added confusion. Three
          destinations, one raised action: read, start, configure. */}
      <button onClick={onSettings} aria-label="Settings">
        <Icon name="settings" size={22} />
        Settings
      </button>
      <button
        onClick={() => { setActiveConversation(null); onPane('list'); }}
        aria-label="Start a new conversation"
        data-fab="true"
      >
        <span className="fab-ico"><Icon name="plus" size={21} /></span>
        New
      </button>
    </nav>
  );
}

function ToastHost(): JSX.Element | null {
  const toast = useApp((s) => s.toast);
  const dismiss = useApp((s) => s.dismissToast);
  if (!toast) return null;

  const icon = toast.kind === 'error' ? 'alert' : toast.kind === 'success' ? 'check' : 'info';
  const colour = toast.kind === 'error' ? 'var(--danger)' : toast.kind === 'success' ? 'var(--success)' : 'var(--info)';

  return (
    <div className="toast-host" role="status" aria-live="polite">
      <div className="toast" data-kind={toast.kind} onClick={dismiss}>
        <Icon name={icon as 'alert'} size={18} style={{ color: colour, flex: 'none' }} />
        <span className="grow">{toast.text}</span>
        <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Dismiss" onClick={dismiss}>
          <Icon name="close" size={15} />
        </button>
      </div>
    </div>
  );
}

function BootSplash(): JSX.Element {
  return (
    <div className="auth">
      <div className="stack center" style={{ gap: 18, justifyContent: 'center', alignItems: 'center' }}>
        <span className="boot-logo" aria-hidden="true">
          <Icon name="logo" size={32} strokeWidth={1.9} />
        </span>
        <p className="dim" style={{ fontSize: 13.5, letterSpacing: '0.02em' }}>Starting Vesper…</p>
        <span className="spinner" style={{ width: 22, height: 22 }} />
      </div>
    </div>
  );
}

/**
 * Last line of defence: any render-time crash shows a readable card with a
 * reload action instead of a blank white page. A blank page tells the user
 * nothing; this at least says what happened and offers a way out.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="auth">
          <div className="auth-card stack" style={{ gap: 12, textAlign: 'center', alignItems: 'center' }}>
            <h1 className="auth-title" style={{ fontSize: 20 }}>Vesper hit a snag</h1>
            <p className="auth-sub" style={{ marginTop: 0 }}>
              {String(this.state.error.message || this.state.error)}
            </p>
            <button className="btn btn-primary btn-lg" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
