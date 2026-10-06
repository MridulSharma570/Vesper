/**
 * Admin panel — the staff surface for running Vesper.
 *
 * Visibility is layered by rank, exactly like the API:
 *   moderator (30)+  overview, users, reports
 *   controller (50)+ feature flags, audit log
 * The server re-checks every call; this UI only hides what you cannot do, so
 * a moderator never sees a button that would 403.
 *
 * Destructive actions always require a written reason: the reason lands in
 * the audit log, which is the point — accountability for every power used.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../store/appStore';
import { adminApi, type AdminStats, type AdminUserRow } from '../lib/api';
import type { AdminEvent, FeatureFlags, Report, Role } from '@shared/types';
import { ROLE_RANK } from '@shared/types';
import { Icon, type IconName } from './Icon';

type Tab = 'overview' | 'users' | 'reports' | 'flags' | 'audit';

const TABS: { id: Tab; label: string; rank: number; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', rank: 30, icon: 'info' },
  { id: 'users', label: 'Users', rank: 30, icon: 'users' },
  { id: 'reports', label: 'Reports', rank: 30, icon: 'flag' },
  { id: 'flags', label: 'Feature flags', rank: 50, icon: 'sparkle' },
  { id: 'audit', label: 'Audit log', rank: 50, icon: 'shield' },
];

const ALL_ROLES: Role[] = ['user', 'moderator', 'controller', 'developer', 'admin'];

function when(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function AdminView({ onClose }: { onClose: () => void }): JSX.Element {
  const profile = useApp((s) => s.profile);
  const myRank = ROLE_RANK[profile?.role ?? 'user'] ?? 0;
  const tabs = TABS.filter((t) => myRank >= t.rank);
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'overview');

  // Escape closes, like every overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} role="presentation" />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Admin panel">
        <header className="sheet-header">
          <span className="chip chip-brand"><Icon name="shield" size={14} /> Staff</span>
          <span className="strong" style={{ fontSize: 16, letterSpacing: '-0.01em' }}>Admin panel</span>
          <span className="chip" style={{ fontSize: 11 }}>{profile?.role}</span>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label="Close admin panel">
            <Icon name="close" size={18} />
          </button>
        </header>

        <nav className="admin-tabs" aria-label="Admin sections">
          {tabs.map((t) => (
            <button key={t.id} className="admin-tab" data-active={tab === t.id} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={16} /> {t.label}
            </button>
          ))}
        </nav>

        <div className="sheet-scroll">
          <div className="sheet-inner stagger">
            {tab === 'overview' && <OverviewTab />}
            {tab === 'users' && <UsersTab myRank={myRank} />}
            {tab === 'reports' && <ReportsTab />}
            {tab === 'flags' && <FlagsTab />}
            {tab === 'audit' && <AuditTab />}
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Overview ─────────────────────────────────────────────────────── */

function OverviewTab(): JSX.Element {
  const notify = useApp((s) => s.notify);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [providers, setProviders] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(() => {
    adminApi.stats().then(setStats).catch((e) => notify('error', e instanceof Error ? e.message : 'Stats failed'));
    adminApi.providers().then(setProviders).catch(() => setProviders(null));
  }, [notify]);

  useEffect(load, [load]);

  if (!stats) return <div className="empty"><span className="spinner" style={{ width: 24, height: 24 }} /></div>;

  const cards: { label: string; value: string | number }[] = [
    { label: 'Online users', value: stats.online.users },
    { label: 'Open sockets', value: stats.online.sockets },
    { label: 'Messages (24h)', value: stats.messages.last24h },
    { label: 'Messages (all)', value: stats.messages.total },
    { label: 'Conversations', value: stats.conversations },
    { label: 'Open reports', value: stats.reports.open },
    { label: 'Failed jobs', value: stats.jobs.failed },
    { label: 'Storage', value: stats.storage.driver },
  ];

  return (
    <>
      <SectionHead title="Live operations" sub="Counts are read straight from the database and the connection hub." onRefresh={load} />
      <div className="stat-grid">
        {cards.map((c) => (
          <div key={c.label} className="stat-card">
            <span className="stat-value">{c.value}</span>
            <span className="stat-label">{c.label}</span>
          </div>
        ))}
      </div>

      <SectionHead title="Registered accounts" sub="By lifecycle status." />
      <div className="stat-grid">
        {Object.entries(stats.users).map(([k, v]) => (
          <div key={k} className="stat-card">
            <span className="stat-value">{v as number}</span>
            <span className="stat-label">{k}</span>
          </div>
        ))}
      </div>

      {providers && (
        <>
          <SectionHead title="Providers" sub="What is actually configured in this deployment. Unconfigured providers run in dev mode: they log instead of sending." />
          <div className="wrap" style={{ display: 'flex', gap: 8 }}>
            {Object.entries(providers).map(([k, v]) => {
              const configured = typeof v === 'object' && v !== null && 'configured' in v
                ? Boolean((v as { configured?: boolean }).configured)
                : null;
              return (
                <span key={k} className={`chip ${configured === null ? '' : configured ? 'chip-success' : 'chip-warning'}`}>
                  {k}{configured !== null && (configured ? ' · live' : ' · dev')}
                </span>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

/* ── Users ────────────────────────────────────────────────────────── */

function UsersTab({ myRank }: { myRank: number }): JSX.Element {
  const notify = useApp((s) => s.notify);
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.users(query ? { query } : {}).then((r) => setRows(r.users))
      .catch((e) => notify('error', e instanceof Error ? e.message : 'Could not load users'));
  }, [query, notify]);

  useEffect(() => {
    const t = setTimeout(load, query ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  const grantable = ALL_ROLES.filter((r) => (ROLE_RANK[r] ?? 0) < myRank);

  async function act(row: AdminUserRow, fn: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(row.id);
    try {
      await fn();
      notify('success', done);
      setExpanded(null);
      setReason('');
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Action refused');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <SectionHead title="Accounts" sub="Search by handle or id. Role changes need admin; suspension needs controller for long durations." />
      <input
        className="input"
        style={{ borderRadius: 'var(--r-pill)', background: 'var(--bg-sunken)', border: '1px solid transparent' }}
        placeholder="Search handle or user id…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search accounts"
      />

      {!rows && <div className="empty"><span className="spinner" /></div>}
      {rows?.length === 0 && <p className="hint">No accounts match.</p>}

      {rows?.map((u) => (
        <div key={u.id} className="admin-row-block">
          <div className="admin-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="center" style={{ gap: 8 }}>
                <span className="strong truncate" style={{ fontSize: 14 }}>@{u.handle}</span>
                <span className={`chip ${u.status === 'active' ? 'chip-success' : 'chip-danger'}`} style={{ fontSize: 10.5 }}>{u.status}</span>
                <span className="chip chip-info" style={{ fontSize: 10.5 }}>{u.role}</span>
              </div>
              <div className="dim mono" style={{ fontSize: 11, marginTop: 3 }}>
                {u.id} · joined {when(u.createdAt)} · seen {when(u.lastSeenAt)}
              </div>
            </div>
            <button className="btn btn-quiet btn-sm" onClick={() => { setExpanded(expanded === u.id ? null : u.id); setReason(''); }}>
              <Icon name={expanded === u.id ? 'chevronDown' : 'chevronRight'} size={15} /> Manage
            </button>
          </div>

          {expanded === u.id && (
            <div className="admin-detail">
              <div className="field">
                <span className="label">Reason (recorded in the audit log)</span>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you taking this action?" />
              </div>
              <div className="wrap" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {grantable.map((r) => (
                  <button
                    key={r}
                    className="btn btn-secondary btn-sm"
                    disabled={busy === u.id || r === u.role || reason.trim().length < 4}
                    onClick={() => void act(u, () => adminApi.setRole(u.id, r, reason.trim()), `Role set to ${r}`)}
                  >
                    → {r}
                  </button>
                ))}
                {u.status === 'active' ? (
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={busy === u.id || reason.trim().length < 4}
                    onClick={() => void act(u, () => adminApi.setStatus(u.id, 'suspended', reason.trim(), 1), 'Account suspended for 1 day')}
                  >
                    <Icon name="block" size={14} /> Suspend 1d
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={busy === u.id || reason.trim().length < 4}
                    onClick={() => void act(u, () => adminApi.setStatus(u.id, 'active', reason.trim()), 'Account restored')}
                  >
                    <Icon name="check" size={14} /> Restore
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/* ── Reports ──────────────────────────────────────────────────────── */

function ReportsTab(): JSX.Element {
  const notify = useApp((s) => s.notify);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.reports().then((r) => setReports(r.reports))
      .catch((e) => notify('error', e instanceof Error ? e.message : 'Could not load reports'));
  }, [notify]);

  useEffect(load, [load]);

  async function resolve(r: Report, status: 'actioned' | 'dismissed'): Promise<void> {
    setBusy(r.id);
    try {
      await adminApi.resolveReport(r.id, status, status === 'actioned' ? 'Action taken after review' : 'Reviewed, no action needed');
      notify('success', `Report ${status}`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Could not resolve');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <SectionHead title="Reports" sub="Every report from every client lands here. Dismiss or action — both are audited." onRefresh={load} />
      {!reports && <div className="empty"><span className="spinner" /></div>}
      {reports?.length === 0 && (
        <div className="empty">
          <Icon name="check" size={34} strokeWidth={1.4} />
          <p className="empty-title">Queue clear</p>
          <p className="empty-text">No reports filed yet.</p>
        </div>
      )}
      {reports?.map((r) => (
        <div key={r.id} className="admin-row" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="center" style={{ gap: 8 }}>
              <span className={`chip ${r.status === 'open' ? 'chip-warning' : r.status === 'actioned' ? 'chip-danger' : ''}`} style={{ fontSize: 10.5 }}>{r.status}</span>
              <span className="chip" style={{ fontSize: 10.5 }}>{r.targetType}</span>
              <span className="strong" style={{ fontSize: 13.5 }}>{r.reason}</span>
            </div>
            {r.details && <p className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{r.details}</p>}
            <div className="dim mono" style={{ fontSize: 11, marginTop: 6 }}>
              target {r.targetId} · by {r.reporterId} · {when(r.createdAt)}
            </div>
          </div>
          {r.status === 'open' || r.status === 'reviewing' ? (
            <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
              <button className="btn btn-secondary btn-sm" disabled={busy === r.id} onClick={() => void resolve(r, 'dismissed')}>Dismiss</button>
              <button className="btn btn-danger btn-sm" disabled={busy === r.id} onClick={() => void resolve(r, 'actioned')}>Action</button>
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

/* ── Feature flags ────────────────────────────────────────────────── */

function FlagsTab(): JSX.Element {
  const notify = useApp((s) => s.notify);
  const [flags, setFlags] = useState<FeatureFlags | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    adminApi.flags().then((r) => setFlags(r.flags))
      .catch((e) => notify('error', e instanceof Error ? e.message : 'Could not load flags'));
  }, [notify]);

  async function flip(key: keyof FeatureFlags, value: boolean): Promise<void> {
    setBusy(String(key));
    try {
      const r = await adminApi.patchFlags({ [key]: value });
      setFlags(r.flags);
      notify('success', `${String(key)} ${value ? 'enabled' : 'disabled'} — live, no redeploy`);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Could not flip flag');
    } finally {
      setBusy(null);
    }
  }

  if (!flags) return <div className="empty"><span className="spinner" /></div>;

  const toggles: { key: keyof FeatureFlags; title: string; sub: string }[] = [
    { key: 'mediaPipeline', title: 'Media pipeline', sub: 'Photos, video, audio, documents, stickers, GIFs, locations, contacts, events.' },
    { key: 'calls', title: 'Calls', sub: 'Voice, video and group calls through the SFU adapter.' },
    { key: 'stories', title: 'Stories', sub: 'Ephemeral 24-hour posts.' },
    { key: 'e2ee', title: 'End-to-end encryption', sub: 'Client-side encryption for new conversations.' },
    { key: 'maintenance', title: 'Maintenance mode', sub: 'Announces maintenance to everyone currently connected.' },
  ];

  return (
    <>
      <SectionHead title="Feature flags" sub="The code for these features is deployed and tested; flags are how they launch. Flips apply live to every connected client." />
      {toggles.map((t) => (
        <div key={String(t.key)} className="row">
          <div className="row-text">
            <div className="row-title">{t.title}</div>
            <div className="row-sub">{t.sub}</div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={Boolean(flags[t.key])}
              disabled={busy === String(t.key)}
              onChange={(e) => void flip(t.key, e.target.checked)}
            />
            <span className="switch-track" />
            <span className="switch-thumb" />
          </label>
        </div>
      ))}
      <div className="row">
        <div className="row-text">
          <div className="row-title">Limits</div>
          <div className="row-sub">
            max upload {flags.maxUploadMb} MB · max group {flags.maxGroupSize} · max call participants {flags.maxCallParticipants}
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Audit log ────────────────────────────────────────────────────── */

function AuditTab(): JSX.Element {
  const notify = useApp((s) => s.notify);
  const [items, setItems] = useState<AdminEvent[] | null>(null);

  useEffect(() => {
    adminApi.audit(120).then((r) => setItems(r.items))
      .catch((e) => notify('error', e instanceof Error ? e.message : 'Could not load audit log'));
  }, [notify]);

  const severityChip: Record<string, string> = {
    info: '', notice: 'chip-info', warning: 'chip-warning', critical: 'chip-danger',
  };

  return (
    <>
      <SectionHead title="Audit log" sub="Every privileged action, every auth event, every moderation step. Append-only." />
      {!items && <div className="empty"><span className="spinner" /></div>}
      {items?.map((e) => (
        <div key={e.id} className="admin-row" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="center" style={{ gap: 8 }}>
              <span className={`chip ${severityChip[e.severity] ?? ''}`} style={{ fontSize: 10.5 }}>{e.severity}</span>
              <span className="strong mono" style={{ fontSize: 12.5 }}>{e.action}</span>
            </div>
            <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
              actor {e.actorId ?? 'system'}{e.actorRole ? ` (${e.actorRole})` : ''}
              {e.target ? ` · ${e.target.type} ${e.target.id}` : ''}
              {e.reason ? ` · “${e.reason}”` : ''}
            </div>
          </div>
          <span className="dim" style={{ fontSize: 11.5, flex: 'none' }}>{when(e.createdAt)}</span>
        </div>
      ))}
    </>
  );
}

function SectionHead({ title, sub, onRefresh }: { title: string; sub?: string; onRefresh?: () => void }): JSX.Element {
  return (
    <div className="between" style={{ alignItems: 'flex-start' }}>
      <div>
        <h3 className="section-title" style={{ padding: 0 }}>{title}</h3>
        {sub && <p className="hint" style={{ marginTop: 4, maxWidth: '62ch' }}>{sub}</p>}
      </div>
      {onRefresh && (
        <button className="icon-btn" onClick={onRefresh} aria-label="Refresh" title="Refresh">
          <Icon name="refresh" size={16} />
        </button>
      )}
    </div>
  );
}
