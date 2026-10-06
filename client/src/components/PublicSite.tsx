/**
 * The public, unauthenticated face of Vesper: policy pages, FAQ, the abuse
 * report form, and a real not-found view.
 *
 * Routing is plain pathname + history API on purpose. Adding react-router for
 * nine static pages would mean a second routing system beside the app's own
 * pane logic; these pages have no nested state worth a dependency.
 *
 * Every page sets its own document.title and meta description, so shared links
 * and search results describe what they actually point at.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { FAQ, LEGAL_DOCS, OPERATOR, COPYRIGHT, CONTACT, type LegalDoc } from '../content/legal';
import { Icon } from './Icon';

/* ── Tiny router ─────────────────────────────────────────────────────── */

export function currentPath(): string {
  const p = window.location.pathname.replace(/\/+$/, '') || '/';
  return p;
}

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Anchor that swaps pages without a full reload. */
function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/* ── Per-route title + meta description ──────────────────────────────── */

export function useDocumentMeta(title: string, description: string): void {
  useEffect(() => {
    document.title = title;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description);
  }, [title, description]);
}

/* ── Shared chrome ───────────────────────────────────────────────────── */

const NAV = [
  { to: '/faq', label: 'FAQ' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/terms', label: 'Terms' },
  { to: '/terms-of-use', label: 'Terms of Use' },
  { to: '/cookies', label: 'Cookies' },
  { to: '/encryption', label: 'Encryption' },
  { to: '/license', label: 'License' },
  { to: '/report', label: 'Report abuse' },
];

function PublicShell({ children, title }: { children: ReactNode; title: string }): JSX.Element {
  return (
    <div className="pub">
      <header className="pub-head">
        <Link to="/" className="pub-brand">
          <Icon name="logo" size={22} strokeWidth={1.9} />
          <span>Vesper</span>
        </Link>
        <h1 className="sr-only">{title}</h1>
        <nav className="pub-nav" aria-label="Site">
          {NAV.slice(0, 4).map((n) => (
            <Link key={n.to} to={n.to}>{n.label}</Link>
          ))}
          <Link to="/" className="btn btn-primary btn-sm">Open Vesper</Link>
        </nav>
      </header>

      <main className="pub-main">{children}</main>

      <footer className="pub-foot">
        <div className="pub-foot-links">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to}>{n.label}</Link>
          ))}
          <a href="/sitemap.xml">Sitemap</a>
          <a href="/robots.txt">Robots</a>
        </div>
        <p className="pub-foot-note">
          {COPYRIGHT} · Operated by {OPERATOR} · {CONTACT}
        </p>
        <p className="pub-foot-note">
          Testimonials appear here only when real users agree to be quoted. There are none yet — we will not invent them.
        </p>
      </footer>
    </div>
  );
}

/* ── Pages ───────────────────────────────────────────────────────────── */

function LegalPage({ doc }: { doc: LegalDoc }): JSX.Element {
  useDocumentMeta(`${doc.title} · Vesper`, doc.meta);
  return (
    <PublicShell title={doc.title}>
      <article className="legal">
        <p className="pub-kicker">Policy · updated {doc.updated}</p>
        <h2 className="pub-title">{doc.title}</h2>
        <p className="pub-intro">{doc.intro}</p>
        {doc.sections.map((s) => (
          <section key={s.h}>
            <h3>{s.h}</h3>
            {s.p.map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </section>
        ))}
        <nav className="legal-next" aria-label="Other policies">
          {LEGAL_DOCS.filter((d) => d.slug !== doc.slug).map((d) => (
            <Link key={d.slug} to={`/${d.slug}`}>{d.title}</Link>
          ))}
        </nav>
      </article>
    </PublicShell>
  );
}

function FaqPage(): JSX.Element {
  useDocumentMeta('Frequently asked questions · Vesper', 'How Vesper handles anonymity, recovery, encryption, abuse reports and platforms — answered plainly.');
  const [open, setOpen] = useState<number | null>(0);
  return (
    <PublicShell title="Frequently asked questions">
      <article className="legal">
        <p className="pub-kicker">Answers</p>
        <h2 className="pub-title">Frequently asked questions</h2>
        <p className="pub-intro">Everything people ask before trusting a messenger with their silence.</p>
        <div className="faq">
          {FAQ.map((f, i) => (
            <div className="faq-item" key={f.q}>
              <button
                className="faq-q"
                aria-expanded={open === i}
                onClick={() => setOpen(open === i ? null : i)}
              >
                <span>{f.q}</span>
                <Icon name={open === i ? 'chevronDown' : 'chevronRight'} size={16} />
              </button>
              {open === i && <p className="faq-a">{f.a}</p>}
            </div>
          ))}
        </div>
        <nav className="legal-next" aria-label="Policies">
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/encryption">Encryption Policy</Link>
          <Link to="/report">Report abuse</Link>
        </nav>
      </article>
    </PublicShell>
  );
}

const REPORT_REASONS_UI: { id: string; label: string }[] = [
  { id: 'spam', label: 'Spam or bulk messaging' },
  { id: 'harassment', label: 'Harassment or threats' },
  { id: 'impersonation', label: 'Impersonation' },
  { id: 'illegal_content', label: 'Illegal content' },
  { id: 'csae', label: 'Child safety (urgent)' },
  { id: 'self_harm', label: 'Self-harm risk (urgent)' },
  { id: 'malware', label: 'Malware or phishing' },
  { id: 'scam', label: 'Fraud or scam' },
  { id: 'other', label: 'Something else' },
];

function ReportPage(): JSX.Element {
  useDocumentMeta('Report abuse · Vesper', 'Report abuse on Vesper with or without an account. Urgent categories are triaged first.');
  const [reason, setReason] = useState('spam');
  const [details, setDetails] = useState('');
  const [contact, setContact] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/public/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, details, contact: contact || undefined, website: honeypot || undefined }),
      });
      const json = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok || !json?.message) throw new Error(json?.message ?? 'The report could not be filed right now.');
      setDone(json.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell title="Report abuse">
      <article className="legal" style={{ maxWidth: 640 }}>
        <p className="pub-kicker">Safety</p>
        <h2 className="pub-title">Report abuse</h2>
        <p className="pub-intro">
          You do not need an account to file a report. Urgent categories (child safety,
          self-harm) jump the moderation queue.
        </p>

        {done ? (
          /* The thank-you state: a report that vanishes into silence is why
           * people stop reporting. */
          <div className="thanks" role="status">
            <Icon name="check" size={34} strokeWidth={1.5} />
            <h3>Thank you — it&apos;s in the queue.</h3>
            <p>{done}</p>
            <p className="muted">
              If you left a contact we may follow up with the outcome. Otherwise this
              report stays anonymous, exactly as filed.
            </p>
            <div className="center" style={{ gap: 8, marginTop: 12 }}>
              <Link to="/" className="btn btn-primary">Open Vesper</Link>
              <button className="btn btn-ghost" onClick={() => { setDone(null); setDetails(''); }}>File another report</button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="pub-form">
            <div className="field">
              <label className="label" htmlFor="rp-reason">What are you reporting?</label>
              <select id="rp-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REPORT_REASONS_UI.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="rp-details">Details (at least 10 characters)</label>
              <textarea
                id="rp-details" className="input" rows={6} maxLength={1000}
                placeholder="Links, handles, timestamps — whatever helps a moderator act."
                value={details}
                onChange={(e) => setDetails(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="rp-contact">Contact for follow-up (optional)</label>
              <input
                id="rp-contact" className="input" type="text" maxLength={254}
                placeholder="An email or handle — only if you want the outcome"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
            </div>
            {/* Honeypot: invisible to humans, irresistible to bots. Filling it
                makes the server answer politely and store nothing. */}
            <div className="hp" aria-hidden="true">
              <label htmlFor="rp-website">Website</label>
              <input id="rp-website" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
            </div>
            {error && <p role="alert" className="danger" style={{ fontSize: 13 }}>{error}</p>}
            <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || details.trim().length < 10}>
              {busy ? 'Filing…' : 'File report'}
            </button>
          </form>
        )}
      </article>
    </PublicShell>
  );
}

function NotFoundPage(): JSX.Element {
  useDocumentMeta('Page not found · Vesper', 'This Vesper page does not exist. Head back to the app or browse the policy pages.');
  return (
    <PublicShell title="Page not found">
      <div className="notfound">
        <p className="notfound-code">404</p>
        <h2 className="pub-title">This corner of the quiet is empty.</h2>
        <p className="pub-intro">
          The page you were looking for does not exist — or it was removed. Nothing is
          wrong with your account or your device.
        </p>
        <div className="center" style={{ gap: 8, marginTop: 16 }}>
          <Link to="/" className="btn btn-primary btn-lg">Back to Vesper</Link>
          <Link to="/faq" className="btn btn-secondary btn-lg">Read the FAQ</Link>
        </div>
      </div>
    </PublicShell>
  );
}

/* ── Router ──────────────────────────────────────────────────────────── */

export function PublicSite(): JSX.Element {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const onPop = (): void => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const doc = LEGAL_DOCS.find((d) => `/${d.slug}` === path);
  if (doc) return <LegalPage doc={doc} />;
  if (path === '/faq') return <FaqPage />;
  if (path === '/report') return <ReportPage />;
  return <NotFoundPage />;
}
