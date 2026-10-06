/**
 * Settings.
 *
 * Organised by the question a user is actually asking — "who can reach me",
 * "what do I see", "is my account safe" — rather than by which database table
 * the value lives in. Every control writes through the API immediately; there is
 * no Save button, because a settings screen that can lose your changes is a
 * settings screen people do not trust.
 *
 * Sections that depend on a feature flag are rendered but visibly marked as
 * arriving later, so the surface is honest about what works today.
 */
import { useState } from 'react';
import { useApp } from '../store/appStore';
import { api, ApiError, getAccessToken, refreshAccessToken } from '../lib/api';
import { ROLE_RANK } from '@shared/types';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { displayHandle, formatBytes, formatRelative } from '../lib/format';

type SectionId = 'profile' | 'privacy' | 'notifications' | 'appearance' | 'security' | 'data' | 'about';

const SECTIONS: { id: SectionId; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'profile', label: 'Profile', icon: 'user' },
  { id: 'privacy', label: 'Privacy', icon: 'shield' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'security', label: 'Security', icon: 'lock' },
  { id: 'data', label: 'Your data', icon: 'download' },
  { id: 'about', label: 'About', icon: 'info' },
];

export function SettingsView({ onClose, onOpenAdmin }: { onClose: () => void; onOpenAdmin?: () => void }): JSX.Element {
  const [section, setSection] = useState<SectionId>('profile');
  const { profile } = useApp();
  const isStaff = (ROLE_RANK[profile?.role ?? 'user'] ?? 0) >= ROLE_RANK.moderator;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        style={{ maxWidth: 760, padding: 0, overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div style={{ display: 'grid', gridTemplateColumns: '196px 1fr', minHeight: 520 }}>
          <nav style={{ borderRight: '1px solid var(--border)', padding: '18px 12px', background: 'var(--bg-sunken)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div className="center" style={{ gap: 10, padding: '4px 8px 14px' }}>
              <Avatar seed={profile?.id ?? 'me'} handle={profile?.handle} displayName={profile?.displayName} size="sm" />
              <div style={{ minWidth: 0 }}>
                <div className="truncate strong" style={{ fontSize: 13.5 }}>{profile?.displayName || 'Anonymous'}</div>
                <div className="truncate dim mono" style={{ fontSize: 11.5 }}>{displayHandle(profile?.handle)}</div>
              </div>
            </div>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className="center"
                data-active={section === s.id}
                onClick={() => setSection(s.id)}
                style={{
                  gap: 10, padding: '9px 11px', borderRadius: 'var(--r-sm)',
                  fontSize: 13.5, fontWeight: 600, textAlign: 'left', width: '100%',
                  background: section === s.id ? 'var(--bg-elevated)' : 'transparent',
                  color: section === s.id ? 'var(--text)' : 'var(--text-secondary)',
                  boxShadow: section === s.id ? 'var(--sh-1)' : 'none',
                }}
              >
                <Icon name={s.icon} size={17} /> {s.label}
              </button>
            ))}
            {isStaff && onOpenAdmin && (
              <button
                className="center"
                onClick={onOpenAdmin}
                style={{
                  gap: 10, padding: '9px 11px', borderRadius: 'var(--r-sm)',
                  fontSize: 13.5, fontWeight: 650, textAlign: 'left', width: '100%',
                  background: 'var(--grad-soft)', color: 'var(--brand-600)', marginTop: 10,
                }}
              >
                <Icon name="shield" size={17} /> Admin panel
              </button>
            )}
            <span className="grow" />
            <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ justifyContent: 'flex-start', gap: 10 }}>
              <Icon name="close" size={16} /> Close
            </button>
          </nav>

          <div className="settings-wrap">
            <div className="settings-inner stagger" style={{ padding: '22px 22px 28px' }}>
              {section === 'profile' && <ProfileSection />}
              {section === 'privacy' && <PrivacySection />}
              {section === 'notifications' && <NotificationsSection />}
              {section === 'appearance' && <AppearanceSection />}
              {section === 'security' && <SecuritySection />}
              {section === 'data' && <DataSection />}
              {section === 'about' && <AboutSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Sections ─────────────────────────── */

function ProfileSection(): JSX.Element {
  const { profile, patchProfile, rotateHandle, notify } = useApp();
  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [busy, setBusy] = useState(false);

  return (
    <>
      <SectionHeading title="Profile" sub="Everything here is optional. An empty profile is a valid, complete profile." />

      <div className="center" style={{ gap: 16, padding: '4px 0 8px' }}>
        <Avatar seed={profile?.avatar?.seed ?? profile?.id ?? 'me'} handle={profile?.handle} displayName={profile?.displayName} size="lg" hue={profile?.avatar?.hue} />
        <div className="grow">
          <div className="strong" style={{ fontSize: 16 }}>{profile?.displayName || 'Anonymous'}</div>
          <div className="dim mono" style={{ fontSize: 13, marginTop: 2 }}>{displayHandle(profile?.handle)}</div>
          <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
            Joined {profile ? formatRelative(profile.createdAt) : ''} · {roleLabel(profile?.role)}
          </div>
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="displayName">Display name</label>
        <input
          id="displayName" className="input" maxLength={64} placeholder="Optional — leave blank to stay anonymous"
          value={displayName} onChange={(e) => setDisplayName(e.target.value)}
        />
        <span className="hint">Only people you have accepted as contacts see this.</span>
      </div>

      <div className="field">
        <label className="label" htmlFor="bio">Bio</label>
        <textarea
          id="bio" className="textarea" maxLength={280} placeholder="280 characters, or nothing at all"
          value={bio} onChange={(e) => setBio(e.target.value)}
        />
        <span className="hint" style={{ textAlign: 'right' }}>{bio.length}/280</span>
      </div>

      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await patchProfile({ displayName: displayName.trim() || null, bio: bio.trim() || null });
          setBusy(false);
        }}
      >
        {busy ? <span className="spinner" /> : 'Save profile'}
      </button>

      <hr className="divider" />

      <Row
        icon="refresh"
        title="Change handle"
        sub={`Currently ${displayHandle(profile?.handle)}. A new random handle keeps your conversations but breaks old links to you.`}
        action={<button className="btn btn-secondary btn-sm" onClick={async () => { setBusy(true); await rotateHandle(); setBusy(false); }}>Rotate</button>}
      />

      <Row
        icon="copy"
        title="Share your handle"
        sub="Your handle is the only way someone can find you. Copy it and send it however you like."
        action={
          <button
            className="btn btn-quiet btn-sm"
            onClick={async () => {
              try { await navigator.clipboard.writeText(displayHandle(profile?.handle)); notify('success', 'Handle copied'); }
              catch { notify('error', 'Could not access the clipboard'); }
            }}
          >
            <Icon name="copy" size={15} /> Copy
          </button>
        }
      />
    </>
  );
}

function PrivacySection(): JSX.Element {
  const { settings, patchSettings } = useApp();
  const p = settings?.privacy;
  if (!p) return <Loading />;

  return (
    <>
      <SectionHeading title="Privacy" sub="Defaults are set to the private end. Nothing here is required to use Vesper." />

      <ChoiceRow
        icon="eye"
        title="Who can message you"
        sub="Contacts-only means a stranger cannot open a conversation with you at all."
        value={p.whoCanMessageMe}
        options={['everyone', 'contacts', 'nobody']}
        onChange={(v) => void patchSettings({ privacy: { ...p, whoCanMessageMe: v } })}
      />
      <ChoiceRow
        icon="users"
        title="Who can add you to groups"
        sub="Applies to group invites from people you have not accepted."
        value={p.whoCanAddMeToGroups}
        options={['everyone', 'contacts', 'nobody']}
        onChange={(v) => void patchSettings({ privacy: { ...p, whoCanAddMeToGroups: v } })}
      />
      <ChoiceRow
        icon="search"
        title="Who can see your handle"
        sub="Hiding your handle makes you unsearchable — you become reachable only through existing conversations."
        value={p.whoCanSeeMyHandle}
        options={['everyone', 'contacts', 'nobody']}
        onChange={(v) => void patchSettings({ privacy: { ...p, whoCanSeeMyHandle: v } })}
      />

      <ToggleRow
        icon="globe"
        title="Show when you are online"
        sub="Off means nobody sees your presence or last-seen time, and you do not see theirs."
        checked={p.showPresence}
        onChange={(v) => void patchSettings({ privacy: { ...p, showPresence: v } })}
      />
      <ToggleRow
        icon="checks"
        title="Read receipts"
        sub="Turning this off also hides other people's receipts from you."
        checked={p.showReadReceipts}
        onChange={(v) => void patchSettings({ privacy: { ...p, showReadReceipts: v } })}
      />
      <ToggleRow
        icon="edit"
        title="Typing indicator"
        sub="Let people see when you are composing a message."
        checked={p.showTypingIndicator}
        onChange={(v) => void patchSettings({ privacy: { ...p, showTypingIndicator: v } })}
      />
      <ToggleRow
        icon="chat"
        title="Link previews"
        sub="Off means URLs you paste are never fetched by the server. Your recipient's IP and the link stay between the two of you."
        checked={p.linkPreviewEnabled}
        onChange={(v) => void patchSettings({ privacy: { ...p, linkPreviewEnabled: v } })}
      />
      <ToggleRow
        icon="user"
        title="Require contact before messaging"
        sub="An extra gate on top of the rule above: both sides must have accepted."
        checked={p.requireContactToMessage}
        onChange={(v) => void patchSettings({ privacy: { ...p, requireContactToMessage: v } })}
      />
    </>
  );
}

function NotificationsSection(): JSX.Element {
  const { settings, patchSettings } = useApp();
  const n = settings?.notifications;
  if (!n) return <Loading />;

  return (
    <>
      <SectionHeading title="Notifications" sub="Vesper never sends marketing email, and never sells or shares your data." />

      <ToggleRow icon="bell" title="Notifications" sub="Master switch for every alert." checked={n.enabled} onChange={(v) => void patchSettings({ notifications: { ...n, enabled: v } })} />
      <ToggleRow icon="sparkle" title="Sound" sub="Play a sound for incoming messages." checked={n.sound} onChange={(v) => void patchSettings({ notifications: { ...n, sound: v } })} />
      <ToggleRow icon="globe" title="Desktop notifications" sub="Shown while the web app is open in a tab." checked={n.desktop} onChange={(v) => void patchSettings({ notifications: { ...n, desktop: v } })} />
      <ToggleRow icon="phone" title="Mobile notifications" sub="Push alerts on Android, iOS and Windows." checked={n.mobile} onChange={(v) => void patchSettings({ notifications: { ...n, mobile: v } })} />

      <ChoiceRow
        icon="eye"
        title="Message preview"
        sub="Controls whether message text appears on a locked screen."
        value={n.previewInNotification}
        options={['always', 'contacts', 'never']}
        onChange={(v) => void patchSettings({ notifications: { ...n, previewInNotification: v } })}
      />
      <ToggleRow
        icon="users"
        title="Groups: mentions only"
        sub="Only notify for group messages that mention you."
        checked={n.groupMentionsOnly}
        onChange={(v) => void patchSettings({ notifications: { ...n, groupMentionsOnly: v } })}
      />

      <Row
        icon="moon"
        title="Quiet hours"
        sub={n.quietHours?.enabled ? `${n.quietHours.start} – ${n.quietHours.end}` : 'Mute notifications overnight'}
        action={
          <Switch
            checked={!!n.quietHours?.enabled}
            onChange={(v) => void patchSettings({
              notifications: { ...n, quietHours: v ? { enabled: true, start: n.quietHours?.start ?? '22:00', end: n.quietHours?.end ?? '07:00' } : null },
            })}
            label="Quiet hours"
          />
        }
      />
      {n.quietHours?.enabled && (
        <div className="center" style={{ gap: 12, padding: '0 4px' }}>
          <label className="center" style={{ gap: 8 }}>
            <span className="label">From</span>
            <input
              type="time" className="input" style={{ width: 130, minHeight: 40 }}
              value={n.quietHours.start}
              onChange={(e) => void patchSettings({ notifications: { ...n, quietHours: { ...n.quietHours!, start: e.target.value } } })}
            />
          </label>
          <label className="center" style={{ gap: 8 }}>
            <span className="label">To</span>
            <input
              type="time" className="input" style={{ width: 130, minHeight: 40 }}
              value={n.quietHours.end}
              onChange={(e) => void patchSettings({ notifications: { ...n, quietHours: { ...n.quietHours!, end: e.target.value } } })}
            />
          </label>
        </div>
      )}
    </>
  );
}

function AppearanceSection(): JSX.Element {
  const { settings, patchSettings } = useApp();
  const a = settings?.appearance;
  if (!a) return <Loading />;

  const accents = [
    { name: 'aurora', hue: 245 }, { name: 'dusk', hue: 275 }, { name: 'mint', hue: 158 },
    { name: 'sand', hue: 34 }, { name: 'rose', hue: 344 }, { name: 'slate', hue: 214 },
  ] as const;

  return (
    <>
      <SectionHeading title="Appearance" sub="Applies on this device and follows your account everywhere else." />

      <ChoiceRow
        icon={a.theme === 'dark' ? 'moon' : 'sun'}
        title="Theme"
        sub="System follows your device setting."
        value={a.theme}
        options={['system', 'light', 'dark']}
        onChange={(v) => void patchSettings({ appearance: { ...a, theme: v } })}
      />

      <div className="row">
        <Icon name="sparkle" size={18} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
        <div className="row-text">
          <div className="row-title">Accent</div>
          <div className="row-sub">The colour of your own message bubbles.</div>
        </div>
        <div className="center" style={{ gap: 8, flex: 'none' }}>
          {accents.map((acc) => (
            <button
              key={acc.name}
              onClick={() => void patchSettings({ appearance: { ...a, accent: acc.name } })}
              aria-label={`${acc.name} accent`}
              title={acc.name}
              style={{
                width: 26, height: 26, borderRadius: '50%',
                background: `linear-gradient(145deg, hsl(${acc.hue} 78% 66%), hsl(${acc.hue + 30} 72% 52%))`,
                border: a.accent === acc.name ? '2.5px solid var(--text)' : '2.5px solid transparent',
                transition: 'transform 120ms ease',
                transform: a.accent === acc.name ? 'scale(1.12)' : 'none',
              }}
            />
          ))}
        </div>
      </div>

      <ChoiceRow
        icon="edit"
        title="Text size"
        sub="Scales the whole interface, not just messages."
        value={a.fontSize}
        options={['small', 'medium', 'large']}
        onChange={(v) => void patchSettings({ appearance: { ...a, fontSize: v } })}
      />
      <ChoiceRow
        icon="chat"
        title="Bubble style"
        sub="Soft is the default; compact fits more on screen."
        value={a.bubbleStyle}
        options={['soft', 'compact', 'classic']}
        onChange={(v) => void patchSettings({ appearance: { ...a, bubbleStyle: v } })}
      />
      <ToggleRow
        icon="refresh"
        title="Reduce motion"
        sub="Removes animations and transitions throughout the app."
        checked={a.reducedMotion}
        onChange={(v) => void patchSettings({ appearance: { ...a, reducedMotion: v } })}
      />
    </>
  );
}

function SecuritySection(): JSX.Element {
  const { profile, settings, patchSettings, signOut, notify } = useApp();
  const sec = settings?.security;
  const [sessions, setSessions] = useState<{ id: string; device: { platform: string; deviceId: string }; createdAt: number; lastActiveAt: number; current: boolean }[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [changeOpen, setChangeOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  async function load(): Promise<void> {
    try {
      const r = await api.sessions() as { sessions: never[] };
      setSessions(r.sessions as typeof sessions);
    } catch { /* non-fatal */ }
  }
  useState(() => { void load(); });

  if (!sec) return <Loading />;

  return (
    <>
      <SectionHeading title="Security" sub="Vesper cannot read your messages and cannot recover an account you lose access to. These settings are how you stay in control." />

      <div className="row">
        <div className="row-text">
          <div className="row-title">Password</div>
          <div className="row-sub">Change it any time. A change signs out every other device immediately.</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => setChangeOpen(true)}>Change</button>
      </div>
      {changeOpen && <ChangePasswordModal onClose={() => setChangeOpen(false)} />}

      <div className="row">
        <div className="row-text">
          <div className="row-title">Email &amp; phone</div>
          <div className="row-sub">
            Optional. Link a contact to sign in with it or recover the account. It is stored
            hashed and is never shown to anyone else — not even people you chat with.
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => setLinkOpen(true)}>
          {profile?.identityFingerprints?.length ? 'Manage' : 'Link'}
        </button>
      </div>
      {linkOpen && <LinkContactModal onClose={() => setLinkOpen(false)} />}

      <ToggleRow
        icon="bell"
        title="Login alerts"
        sub="Email you when a new device signs in. Requires a verified email address."
        checked={sec.loginAlerts}
        onChange={(v) => void patchSettings({ security: { ...sec, loginAlerts: v } })}
      />
      <ToggleRow
        icon="lock"
        title="Encrypt local storage"
        sub="Encrypt cached messages on this device with a key derived from your session."
        checked={sec.encryptLocalStore}
        onChange={(v) => void patchSettings({ security: { ...sec, encryptLocalStore: v } })}
      />
      <ToggleRow
        icon="eye"
        title="Screenshot protection hint"
        sub="Warn the other person when the app cannot block a screenshot (desktop and web)."
        checked={sec.screenshotProtectionHint}
        onChange={(v) => void patchSettings({ security: { ...sec, screenshotProtectionHint: v } })}
      />

      <Row
        icon="shield"
        title="Two-factor authentication"
        sub={sec.twoFactorEnabled ? 'Enabled — a code is required in addition to your password' : 'Not enabled. Requires a password on your account.'}
        action={<span className={`chip ${sec.twoFactorEnabled ? 'chip-success' : ''}`}>{sec.twoFactorEnabled ? 'On' : 'Off'}</span>}
      />

      <Row
        icon="clock"
        title="Session lifetime"
        sub="How long a device stays signed in without activity."
        action={
          <select
            className="select"
            style={{ width: 128, minHeight: 38 }}
            value={sec.sessionLifetimeDays}
            onChange={(e) => void patchSettings({ security: { ...sec, sessionLifetimeDays: Number(e.target.value) } })}
          >
            {[1, 7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
          </select>
        }
      />

      <hr className="divider" />

      <div className="section">
        <div className="between">
          <div className="section-title">Active sessions</div>
          <button className="btn btn-ghost btn-sm" onClick={() => void load()}><Icon name="refresh" size={15} /> Refresh</button>
        </div>
        {sessions.length === 0 && <p className="hint">No other devices are signed in.</p>}
        {sessions.map((s) => (
          <div className="row" key={s.id}>
            <Icon name={platformIcon(s.device.platform)} size={18} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
            <div className="row-text">
              <div className="row-title">
                {s.device.platform} {s.current && <span className="chip chip-success" style={{ marginLeft: 6 }}>this device</span>}
              </div>
              <div className="row-sub">Last active {formatRelative(s.lastActiveAt ?? s.createdAt)}</div>
            </div>
            {!s.current && (
              <button
                className="btn btn-ghost btn-sm danger"
                onClick={async () => {
                  try {
                    await fetch(`/auth/sessions/${s.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await token()}` } });
                    notify('success', 'Session signed out');
                    await load();
                  } catch { notify('error', 'Could not sign out that session'); }
                }}
              >
                Sign out
              </button>
            )}
          </div>
        ))}
        <button className="btn btn-secondary" onClick={async () => { await signOut(true); notify('info', 'Signed out everywhere else'); }}>
          <Icon name="logout" size={16} /> Sign out all other devices
        </button>
      </div>

      <hr className="divider" />

      <div className="section">
        <div className="section-title" style={{ color: 'var(--danger)' }}>Danger zone</div>
        {!confirmDelete ? (
          <button className="btn btn-secondary" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--border-strong))' }} onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={16} /> Delete account
          </button>
        ) : (
          <div className="card" style={{ padding: 16, borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border))', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: 14, lineHeight: 1.6 }}>
              Your account stops working immediately. Messages, contacts and media are
              permanently erased within 30 days. Signing back in during that window
              cancels the deletion.
            </p>
            <p className="hint">
              Type <strong className="mono">DELETE</strong> or your handle <strong className="mono">{profile?.handle}</strong> to confirm.
            </p>
            <input className="input" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} placeholder="DELETE" autoComplete="off" />
            <div className="center" style={{ gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => { setConfirmDelete(false); setDeleteText(''); }}>Cancel</button>
              <button
                className="btn btn-danger btn-sm"
                disabled={deleteText !== 'DELETE' && deleteText !== profile?.handle}
                onClick={async () => { await useApp.getState().deleteAccount(deleteText); setConfirmDelete(false); }}
              >
                Permanently delete
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function DataSection(): JSX.Element {
  const { notify } = useApp();
  const [busy, setBusy] = useState(false);
  const d = useApp((s) => s.settings?.data);

  async function exportData(): Promise<void> {
    setBusy(true);
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vesper-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      notify('success', 'Export downloaded');
    } catch {
      notify('error', 'Could not generate your export');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionHeading title="Your data" sub="What Vesper stores, and how to get a copy or have it removed." />

      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={{ fontSize: 14, lineHeight: 1.65 }}>
          <strong>What we store:</strong> a random handle, an id, your settings, your
          messages, and — only if you added one — an email address or phone number,
          stored hashed and encrypted so that neither is readable from the database.
        </p>
        <p style={{ fontSize: 14, lineHeight: 1.65 }}>
          <strong>What we never store:</strong> your real name, your location, your
          contacts list, advertising identifiers, or a link between your account and
          anyone else's.
        </p>
        <p style={{ fontSize: 14, lineHeight: 1.65 }}>
          <strong>Retention:</strong> messages persist until you delete them. A deleted
          account is erased within 30 days. Audit logs of staff actions are kept for
          one year so that any moderation decision can be reviewed.
        </p>
      </div>

      <Row
        icon="download"
        title="Download your data"
        sub="A single JSON file with everything the server holds about you. Identifiers appear as fingerprints, not plaintext."
        action={<button className="btn btn-secondary btn-sm" onClick={() => void exportData()} disabled={busy}>{busy ? <span className="spinner" /> : 'Export'}</button>}
      />

      {d && (
        <Row
          icon="archive"
          title="Keep media for"
          sub={d.keepMediaForDays === null ? 'Media is kept until you delete it' : `Media older than ${d.keepMediaForDays} days is deleted automatically`}
          action={
            <select
              className="select" style={{ width: 138, minHeight: 38 }}
              value={d.keepMediaForDays ?? 'never'}
              onChange={(e) => void useApp.getState().patchSettings({ data: { ...d, keepMediaForDays: e.target.value === 'never' ? null : Number(e.target.value) } })}
            >
              <option value="never">Forever</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </select>
          }
        />
      )}

      <Row
        icon="doc"
        title="Storage used"
        sub={d ? `${formatBytes(0)} of ${d.storageLimitMb} MB — media arrives in a later release` : 'Media arrives in a later release'}
        action={<span className="chip">Text only</span>}
      />
    </>
  );
}

function AboutSection(): JSX.Element {
  const flags = useApp((s) => s.flags);
  const profile = useApp((s) => s.profile);

  return (
    <>
      <SectionHeading title="About" sub="Vesper — anonymous messaging, by design." />

      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="between">
          <span className="muted">Version</span>
          <span className="strong mono">1.0.0</span>
        </div>
        <div className="between"><span className="muted">Your role</span><span className="strong">{roleLabel(profile?.role)}</span></div>
        <div className="between"><span className="muted">Account id</span><span className="mono dim truncate" style={{ maxWidth: 200 }}>{profile?.id}</span></div>
      </div>

      <div className="section">
        <div className="section-title">Feature availability</div>
        <p className="hint">These are controlled server-side, so new capabilities appear without an app update.</p>
        <FeatureRow label="Text messaging" on />
        <FeatureRow label="Group conversations" on />
        <FeatureRow label="Anonymous accounts (no email or phone)" on />
        <FeatureRow label="Media: photos, GIFs, stickers, voice notes" on={flags?.mediaPipeline ?? false} />
        <FeatureRow label="Voice, video and group calls" on={flags?.calls ?? false} />
        <FeatureRow label="Stories" on={flags?.stories ?? false} />
        <FeatureRow label="End-to-end encryption" on={flags?.e2ee ?? false} />
      </div>

      <div className="section">
        <div className="section-title">Legal</div>
        <div className="card" style={{ padding: 4 }}>
          {[
            { label: 'Privacy Policy', href: '/legal/privacy.html' },
            { label: 'Terms of Service', href: '/legal/terms.html' },
            { label: 'Community Guidelines', href: '/legal/guidelines.html' },
            { label: 'Licences', href: '/legal/licences.html' },
          ].map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer noopener" className="row" style={{ textDecoration: 'none', border: 0, background: 'transparent' }}>
              <Icon name="doc" size={17} style={{ color: 'var(--text-secondary)' }} />
              <span className="row-text"><span className="row-title">{l.label}</span></span>
              <Icon name="chevronRight" size={16} style={{ color: 'var(--text-tertiary)' }} />
            </a>
          ))}
        </div>
      </div>
    </>
  );
}

function FeatureRow({ label, on }: { label: string; on: boolean }): JSX.Element {
  return (
    <div className="row">
      <Icon name={on ? 'check' : 'clock'} size={17} style={{ color: on ? 'var(--success)' : 'var(--text-tertiary)', flex: 'none' }} />
      <div className="row-text"><div className="row-title">{label}</div></div>
      <span className={`chip ${on ? 'chip-success' : ''}`}>{on ? 'Available' : 'Coming later'}</span>
    </div>
  );
}

/* ─────────────────────────── Primitives ─────────────────────────── */

function SectionHeading({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <div className="stack" style={{ gap: 4, marginBottom: 4 }}>
      <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em' }}>{title}</h2>
      <p className="hint" style={{ fontSize: 13.5, lineHeight: 1.6 }}>{sub}</p>
    </div>
  );
}

function Row({ icon, title, sub, action }: {
  icon: Parameters<typeof Icon>[0]['name']; title: string; sub: string; action: React.ReactNode;
}): JSX.Element {
  return (
    <div className="row">
      <Icon name={icon} size={18} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
      <div className="row-text">
        <div className="row-title">{title}</div>
        <div className="row-sub">{sub}</div>
      </div>
      {action}
    </div>
  );
}

function ToggleRow({ icon, title, sub, checked, onChange }: {
  icon: Parameters<typeof Icon>[0]['name']; title: string; sub: string; checked: boolean; onChange: (v: boolean) => void;
}): JSX.Element {
  return <Row icon={icon} title={title} sub={sub} action={<Switch checked={checked} onChange={onChange} label={title} />} />;
}

function ChoiceRow<T extends string>({ icon, title, sub, value, options, onChange }: {
  icon: Parameters<typeof Icon>[0]['name']; title: string; sub: string;
  value: T; options: readonly T[]; onChange: (v: T) => void;
}): JSX.Element {
  return (
    <Row
      icon={icon}
      title={title}
      sub={sub}
      action={
        <div className="segmented" role="group" aria-label={title}>
          {options.map((o) => (
            <button key={o} data-active={value === o} onClick={() => onChange(o)} aria-pressed={value === o}>
              {o}
            </button>
          ))}
        </div>
      }
    />
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <span className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="switch-track" />
      <span className="switch-thumb" />
    </span>
  );
}

function Loading(): JSX.Element {
  return <div className="center" style={{ padding: 32, justifyContent: 'center' }}><span className="spinner" /></div>;
}

function roleLabel(role?: string | null): string {
  switch (role) {
    case 'owner': return 'Owner';
    case 'admin': return 'Administrator';
    case 'developer': return 'Developer';
    case 'controller': return 'Controller';
    case 'moderator': return 'Moderator';
    default: return 'Member';
  }
}

function platformIcon(platform: string): Parameters<typeof Icon>[0]['name'] {
  if (platform === 'android' || platform === 'ios') return 'phone';
  if (platform === 'windows' || platform === 'macos' || platform === 'linux') return 'code';
  return 'globe';
}

/** Fetch a current access token for the handful of raw calls above. */
async function token(): Promise<string> {
  return getAccessToken() ?? (await refreshAccessToken()) ?? '';
}

/* ─────────────────────────── Password change ─────────────────────────── */

/**
 * Password change dialog.
 *
 * `forced` mode is what staff credential resets produce: the account carries
 * must_change_password, the dialog cannot be dismissed, and the only way out
 * is changing the password or signing out. That is the honest enforcement of
 * a reset — a banner the user can close is not.
 */
export function ChangePasswordModal({ forced = false, onClose }: { forced?: boolean; onClose: () => void }): JSX.Element {
  const notify = useApp((s) => s.notify);
  const signOut = useApp((s) => s.signOut);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (next.trim().length < 10) { setError('Use at least 10 characters.'); return; }
    if (next !== confirm) { setError('The two new passwords do not match.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      const me = await api.me();
      useApp.setState({ profile: me.profile, settings: me.settings });
      notify('success', 'Password changed. Every other device was signed out.');
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={forced ? undefined : onClose}
      role="presentation"
    >
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Change password">
        <div className="between">
          <h2 className="modal-title">Change password</h2>
          {!forced && (
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="close" size={17} />
            </button>
          )}
        </div>

        {forced && (
          <p className="hint" style={{ background: 'var(--warning-bg)', color: 'var(--warning)', padding: '10px 12px', borderRadius: 'var(--r-md)' }}>
            A staff member reset this account's credentials. Choose your own
            password to continue — this dialog cannot be dismissed.
          </p>
        )}

        <div className="field">
          <label className="label" htmlFor="pw-current">Current password</label>
          <input id="pw-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="pw-next">New password</label>
          <input id="pw-next" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 10 characters" />
        </div>
        <div className="field">
          <label className="label" htmlFor="pw-confirm">Repeat new password</label>
          <input id="pw-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        {error && <p role="alert" className="danger" style={{ fontSize: 13 }}>{error}</p>}

        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !current || !next || !confirm} onClick={() => void submit()}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
        {forced && (
          <button className="btn btn-ghost" onClick={() => void signOut()}>
            Sign out instead
          </button>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Optional contact linking ─────────────────────────── */

/**
 * Two-step dialog for linking an email or phone number.
 *
 * Step 1 sends a one-time code to the contact (the server attaches it as
 * UNVERIFIED until then); step 2 proves control. Nothing about the account
 * changes until the code is confirmed, so a typo can never hijack someone
 * else's recovery path. In development the code is printed to the server
 * console and saved to server/data/outbox — real keys send real messages.
 */
function LinkContactModal({ onClose }: { onClose: () => void }): JSX.Element {
  const notify = useApp((s) => s.notify);
  const profile = useApp((s) => s.profile);
  const [method, setMethod] = useState<'email' | 'phone'>('email');
  const [value, setValue] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await api.startLink(method, value.trim());
      setChallengeId(r.challengeId);
      notify('success', method === 'email' ? 'Check your inbox for the Vesper code.' : 'Check your messages for the Vesper code.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the verification.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyLink(challengeId, code.trim());
      const me = await api.me();
      useApp.setState({ profile: me.profile, settings: me.settings });
      notify('success', 'Contact linked and verified.');
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  const linked = profile?.identityFingerprints ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Link email or phone">
        <div className="between">
          <h2 className="modal-title">{challengeId ? 'Enter the code' : 'Link a contact'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={17} />
          </button>
        </div>

        {linked.length > 0 && (
          <div className="hint" style={{ marginBottom: 12 }}>
            Already linked:{' '}
            {linked.map((f) => (
              <span key={f.method + f.fingerprint} className="chip" style={{ marginLeft: 6 }}>
                {f.method} · {f.fingerprint}
              </span>
            ))}
          </div>
        )}

        {!challengeId ? (
          <>
            <p className="hint">
              Stays optional forever. Vesper stores the contact hashed; nobody — including
              people you message — can ever see it.
            </p>
            <div className="field">
              <label className="label" htmlFor="link-method">Contact type</label>
              <div className="seg" role="radiogroup" aria-label="Contact type">
                <button
                  role="radio" aria-checked={method === 'email'}
                  className={`seg-btn${method === 'email' ? ' seg-on' : ''}`}
                  onClick={() => setMethod('email')}
                >Email</button>
                <button
                  role="radio" aria-checked={method === 'phone'}
                  className={`seg-btn${method === 'phone' ? ' seg-on' : ''}`}
                  onClick={() => setMethod('phone')}
                >Phone</button>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="link-value">{method === 'email' ? 'Email address' : 'Phone number (with country code)'}</label>
              <input
                id="link-value" className="input"
                type={method === 'email' ? 'email' : 'tel'}
                autoComplete={method === 'email' ? 'email' : 'tel'}
                placeholder={method === 'email' ? 'you@example.com' : '+91…'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            {error && <p role="alert" className="danger" style={{ fontSize: 13 }}>{error}</p>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || value.trim().length < 3} onClick={() => void start()}>
              {busy ? 'Sending code…' : 'Send verification code'}
            </button>
          </>
        ) : (
          <>
            <p className="hint">
              We sent a 6-digit code to your {method}. It expires in a few minutes.
              In development builds the code is printed to the server console.
            </p>
            <div className="field">
              <label className="label" htmlFor="link-code">Verification code</label>
              <input
                id="link-code" className="input" inputMode="numeric" autoComplete="one-time-code"
                placeholder="••••••" maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            {error && <p role="alert" className="danger" style={{ fontSize: 13 }}>{error}</p>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.trim().length < 4} onClick={() => void confirm()}>
              {busy ? 'Verifying…' : 'Verify and link'}
            </button>
            <button className="btn btn-ghost" onClick={() => { setChallengeId(null); setCode(''); setError(null); }}>
              Use a different {method}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
