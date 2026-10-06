/**
 * Sign-in screen.
 *
 * The default action is the one at the top: create an anonymous account with no
 * email, no phone and no provider. That ordering is a product decision, not a
 * layout convenience — an app whose stated promise is anonymity should not open
 * by asking for an email address.
 *
 * Everything else (password, email code, SMS code, magic link) is behind "more
 * ways", so a user who wants a recoverable account can have one without the
 * anonymous path feeling like the unusual choice.
 */
import { useState } from 'react';
import { useApp } from '../store/appStore';
import { Icon, Logo } from './Icon';
import { ApiError } from '../lib/api';
import { navigate, useDocumentMeta } from './PublicSite';

type Mode = 'anonymous' | 'password' | 'otp' | 'recover';

export function AuthScreen(): JSX.Element {
  const { signInAnonymously, signInWithPassword, registerWithPassword, startOtp, submitOtp, verifyStep, notify } = useApp();
  const [mode, setMode] = useState<Mode>('anonymous');
  const [isRegister, setIsRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [otpKind, setOtpKind] = useState<'otp_email' | 'otp_sms'>('otp_email');
  const [otpTarget, setOtpTarget] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  /* ── Step 2: a code has been sent ─────────────────────────────── */
  if (verifyStep) {
    return (
      <Shell>
        <div className="stack" style={{ gap: 6, textAlign: 'center', alignItems: 'center' }}>
          <span className="chip chip-brand" style={{ padding: '6px 12px' }}>
            <Icon name={verifyStep.channel === 'sms' ? 'phone' : verifyStep.channel === 'app' ? 'shield' : 'mail'} size={15} />
            {verifyStep.channel === 'sms' ? 'Text message' : verifyStep.channel === 'app' ? 'Authenticator' : 'Email'}
          </span>
          <h1 className="auth-title" style={{ marginTop: 10 }}>Check your {verifyStep.channel === 'app' ? 'app' : verifyStep.channel === 'sms' ? 'messages' : 'inbox'}</h1>
          <p className="auth-sub">
            {verifyStep.channel === 'app'
              ? 'Enter the 6-digit code from your authenticator app.'
              : <>We sent a code to <strong className="mono">{verifyStep.targetHint}</strong>. It expires in 5 minutes.</>}
          </p>
        </div>

        <form
          className="row-gap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => submitOtp(code.trim()));
          }}
        >
          <input
            className="input mono"
            style={{ textAlign: 'center', fontSize: 26, letterSpacing: '0.4em', fontWeight: 600 }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            placeholder="••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ''))}
            autoFocus
          />
          {error && <ErrorNote text={error} />}
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || code.length < 4}>
            {busy ? <Spinner /> : 'Continue'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => useApp.setState({ verifyStep: null })}>
            Use a different method
          </button>
        </form>
      </Shell>
    );
  }

  /* ── Step 1: choose a method ──────────────────────────────────── */
  return (
    <Shell>
      <div className="stack" style={{ gap: 8, textAlign: 'center', alignItems: 'center' }}>
        <Logo size={54} withWord={false} />
        <h1 className="auth-title">Vesper</h1>
        <p className="auth-sub">
          Anonymous messaging. No name, no number, nothing to trace back to you —
          unless you decide otherwise.
        </p>
      </div>

      {mode === 'anonymous' && (
        <div className="row-gap">
          <button
            className="btn btn-primary btn-lg btn-block"
            disabled={busy}
            onClick={() => void run(signInAnonymously)}
          >
            {busy ? <Spinner /> : <><Icon name="sparkle" size={18} /> Start anonymously</>}
          </button>
          <p className="hint" style={{ textAlign: 'center' }}>
            Creates a random handle and a key on this device. Nothing is sent to us —
            not an email, not a phone number.
          </p>
          {error && <ErrorNote text={error} />}
          <div className="divider" />
          <MethodLinks onPick={(m) => { setMode(m); setError(null); }} />
        </div>
      )}

      {mode === 'password' && (
        <form
          className="row-gap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              isRegister
                ? registerWithPassword({ identifier, password, handle: handle || undefined })
                : signInWithPassword(identifier, password),
            );
          }}
        >
          <div className="tabs" role="tablist">
            <button type="button" className="tab" data-active={!isRegister} onClick={() => setIsRegister(false)}>Sign in</button>
            <button type="button" className="tab" data-active={isRegister} onClick={() => setIsRegister(true)}>Create account</button>
          </div>

          <div className="field">
            <label className="label" htmlFor="identifier">Email, phone or handle</label>
            <input
              id="identifier" className="input" type="text" autoComplete="username"
              placeholder="you@example.com, +91… or quiet-otter"
              value={identifier} onChange={(e) => setIdentifier(e.target.value)} required
            />
            <span className="hint">Email and phone are stored hashed and encrypted. Never shown to anyone else.</span>
          </div>

          {isRegister && (
            <div className="field">
              <label className="label" htmlFor="handle">Handle <span className="dim">(optional)</span></label>
              <input
                id="handle" className="input" type="text" autoComplete="off"
                placeholder="quiet-otter" value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''))}
                maxLength={32}
              />
              <span className="hint">Leave blank and we will pick an anonymous one you can change later.</span>
            </div>
          )}

          <div className="field">
            <label className="label" htmlFor="password">Password</label>
            <div style={{ position: 'relative' }}>
              <input
                id="password" className="input" style={{ paddingRight: 46 }}
                type={showPassword ? 'text' : 'password'}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                placeholder={isRegister ? 'At least 10 characters' : 'Your password'}
                value={password} onChange={(e) => setPassword(e.target.value)} required minLength={isRegister ? 10 : undefined}
              />
              <button
                type="button" className="icon-btn" aria-label={showPassword ? 'Hide password' : 'Show password'}
                style={{ position: 'absolute', right: 3, top: 3, width: 38, height: 38 }}
                onClick={() => setShowPassword((v) => !v)}
              >
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
              </button>
            </div>
          </div>

          {error && <ErrorNote text={error} />}

          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
            {busy ? <Spinner /> : isRegister ? 'Create account' : 'Sign in'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => setMode('recover')}>
            Forgot your password?
          </button>
          <div className="divider" />
          <MethodLinks onPick={(m) => { setMode(m); setError(null); }} />
        </form>
      )}

      {mode === 'otp' && (
        <form
          className="row-gap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => startOtp(otpKind, otpTarget.trim()));
          }}
        >
          <div className="stack" style={{ gap: 6 }}>
            <h2 className="auth-title" style={{ fontSize: 19 }}>Sign in with a code</h2>
            <p className="auth-sub" style={{ marginTop: 0 }}>
              No password to remember. We send a single-use code, and if you are new
              an account is created for you automatically.
            </p>
          </div>

          <div className="tabs" role="tablist">
            <button type="button" className="tab" data-active={otpKind === 'otp_email'} onClick={() => setOtpKind('otp_email')}>
              Email
            </button>
            <button type="button" className="tab" data-active={otpKind === 'otp_sms'} onClick={() => setOtpKind('otp_sms')}>
              SMS
            </button>
          </div>

          <div className="field">
            <label className="label" htmlFor="otp-target">{otpKind === 'otp_email' ? 'Email address' : 'Phone number'}</label>
            <input
              id="otp-target" className="input"
              type={otpKind === 'otp_email' ? 'email' : 'tel'}
              autoComplete={otpKind === 'otp_email' ? 'email' : 'tel'}
              placeholder={otpKind === 'otp_email' ? 'you@example.com' : '+91 98123 45678'}
              value={otpTarget} onChange={(e) => setOtpTarget(e.target.value)} required
            />
          </div>

          {error && <ErrorNote text={error} />}

          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
            {busy ? <Spinner /> : 'Send code'}
          </button>
          <div className="divider" />
          <MethodLinks onPick={(m) => { setMode(m); setError(null); }} />
        </form>
      )}

      {mode === 'recover' && (
        <RecoverPane
          onBack={() => setMode('anonymous')}
          onNotify={(kind, text) => notify(kind, text)}
        />
      )}
    </Shell>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────── */

/** Intercept the policy links: same-origin SPA navigation, no full reload. */
function goTo(e: React.MouseEvent<HTMLAnchorElement>): void {
  e.preventDefault();
  navigate(e.currentTarget.getAttribute('href') ?? '/');
}

function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  useDocumentMeta(
    'Vesper — anonymous, by design',
    'No name, no number, no trace. Vesper is the messaging app where your identity is yours alone.',
  );
  return (
    <div className="auth">
      {/* Brand panel: sells the promise before asking for anything. */}
      <div className="auth-hero" aria-hidden="true">
        <span className="hero-logo"><Icon name="logo" size={40} strokeWidth={1.9} /></span>
        <h1 className="hero-title">Say it quietly.<br />Stay <em>anyone</em>.</h1>
        <p className="hero-sub">
          Vesper is a messenger where your name, your number and your face are
          optional — because they should be your choice, not the price of entry.
        </p>
        <ul className="hero-points">
          <li><Icon name="shield" size={17} /> No name or phone number required, ever</li>
          <li><Icon name="lock" size={17} /> Sessions rotate on every single connection</li>
          <li><Icon name="sparkle" size={17} /> A handle you can spin again at any time</li>
          <li><Icon name="users" size={17} /> Groups, receipts and presence you control</li>
        </ul>
      </div>
      <div className="auth-card stagger">
        {children}
        <footer className="hint auth-foot" style={{ textAlign: 'center', marginTop: 4 }}>
          <span>By continuing you agree to the <a href="/terms" onClick={goTo}>Terms</a> and the <a href="/privacy" onClick={goTo}>Privacy Policy</a>.</span>
          <nav className="auth-foot-links" aria-label="About Vesper">
            <a href="/faq" onClick={goTo}>FAQ</a>
            <a href="/cookies" onClick={goTo}>Cookies</a>
            <a href="/encryption" onClick={goTo}>Encryption</a>
            <a href="/terms-of-use" onClick={goTo}>Terms of Use</a>
            <a href="/license" onClick={goTo}>License</a>
            <a href="/report" onClick={goTo}>Report abuse</a>
          </nav>
        </footer>
      </div>
    </div>
  );
}

function MethodLinks({ onPick }: { onPick: (m: Mode) => void }): JSX.Element {
  return (
    <div className="method-grid">
      <button className="btn btn-secondary btn-block" type="button" onClick={() => onPick('password')}>
        <Icon name="lock" size={17} /> Use a password
      </button>
      <button className="btn btn-ghost btn-block" type="button" onClick={() => onPick('otp')}>
        <Icon name="mail" size={17} /> Email or SMS code
      </button>
    </div>
  );
}

/**
 * Recovery uses the same code flow as sign-in. There is deliberately no
 * "reset link" that works without proving control of an identifier, because
 * email-only recovery is the weakest link in most account systems.
 */
function RecoverPane({ onBack, onNotify }: { onBack: () => void; onNotify: (k: 'info' | 'error' | 'success', t: string) => void }): JSX.Element {
  const { startOtp } = useApp();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="row-gap"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const kind = target.includes('@') ? 'otp_email' : 'otp_sms';
          await startOtp(kind, target.trim());
          onNotify('info', 'If that address is on an account, a code is on its way.');
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Could not start recovery');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="stack" style={{ gap: 6 }}>
        <h2 className="auth-title" style={{ fontSize: 19 }}>Regain access</h2>
        <p className="auth-sub" style={{ marginTop: 0 }}>
          Enter the email or phone number on your account. We will send a code that
          signs you in and lets you set a new password.
        </p>
      </div>

      <div className="field">
        <label className="label" htmlFor="recover-target">Email or phone number</label>
        <input
          id="recover-target" className="input" type="text" autoComplete="username"
          placeholder="you@example.com or +91…"
          value={target} onChange={(e) => setTarget(e.target.value)} required
        />
        <span className="hint">
          Accounts created anonymously have no email or phone on file. If that is you,
          recovery is only possible on a device where you are still signed in.
        </span>
      </div>

      {error && <ErrorNote text={error} />}
      <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
        {busy ? <Spinner /> : 'Send recovery code'}
      </button>
      <button className="btn btn-ghost btn-block" type="button" onClick={onBack}>Back</button>
    </form>
  );
}

function ErrorNote({ text }: { text: string }): JSX.Element {
  return (
    <p
      role="alert"
      style={{
        display: 'flex', gap: 8, alignItems: 'flex-start',
        padding: '10px 12px', borderRadius: 'var(--r-md)',
        background: 'var(--danger-bg)', color: 'var(--danger)',
        fontSize: 13.5, lineHeight: 1.5,
      }}
    >
      <Icon name="alert" size={16} style={{ flex: 'none', marginTop: 1 }} />
      <span>{text}</span>
    </p>
  );
}

function Spinner(): JSX.Element {
  return <span className="spinner" style={{ borderColor: 'rgba(255,255,255,.35)', borderTopColor: '#fff' }} />;
}
