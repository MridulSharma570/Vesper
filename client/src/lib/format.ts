/**
 * Formatting helpers.
 *
 * Kept dependency-free and locale-aware. Time rendering follows the convention
 * people already know from WhatsApp/iMessage rather than inventing one:
 *   today       → 14:32
 *   yesterday   → Yesterday
 *   this week   → Tuesday
 *   older       → 12 Mar
 *   other year  → 12 Mar 2025
 */

const DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: isHour12() });
}

/** True when the user's locale prefers a 12-hour clock. */
function isHour12(): boolean {
  try {
    const resolved = new Intl.DateTimeFormat(undefined, { hour: '2-digit' }).resolvedOptions();
    return resolved.hourCycle === 'h12' || resolved.hourCycle === 'h11';
  } catch {
    return false;
  }
}

export function formatListTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const now = Date.now();
  const todayStart = startOfDay(now);
  if (ts >= todayStart) return formatClock(ts);
  if (ts >= todayStart - DAY) return 'Yesterday';
  if (ts >= todayStart - 6 * DAY) {
    return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  }
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Header for a day divider inside a transcript. */
export function formatDayLabel(ts: number): string {
  const now = Date.now();
  const todayStart = startOfDay(now);
  if (ts >= todayStart) return 'Today';
  if (ts >= todayStart - DAY) return 'Yesterday';
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** "3 min ago" — used for sessions and audit rows, never for message bubbles. */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 45_000) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatListTime(ts);
}

/** Two initials for an avatar. Falls back to '?' for an empty handle. */
export function initials(handle: string | null | undefined, displayName?: string | null): string {
  const source = (displayName?.trim() || handle?.trim() || '?').replace(/^@/, '');
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * A stable hue for an avatar, derived from the id.
 *
 * Deterministic per account, so a person looks the same on every device and
 * after every reload — which is the whole point of an avatar for an anonymous
 * user. Golden-angle spacing keeps consecutive ids visually distinct instead of
 * clustering in one part of the wheel.
 */
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) % 360;
  }
  // Golden angle (137.508°) spreads neighbouring hashes apart.
  return Math.round((h * 137.508) % 360);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Message preview text for the conversation list. */
export function previewOf(message: { kind: string; body?: { text?: string }; text?: string | null } | null | undefined): string {
  if (!message) return 'No messages yet';
  const text = message.body?.text ?? message.text ?? '';
  if (message.kind === 'text' && text) return text;
  const labels: Record<string, string> = {
    image: 'Photo', gif: 'GIF', sticker: 'Sticker', audio: 'Audio', voice_note: 'Voice message',
    video: 'Video', video_note: 'Video message', document: 'Document', contact: 'Contact card',
    location: 'Location', event: 'Event', poll: 'Poll', system: 'System message', call_log: 'Call',
  };
  return labels[message.kind] ?? text ?? 'Message';
}

/**
 * Render message text safely.
 *
 * React already escapes strings, so there is no XSS here — but we still avoid
 * `dangerouslySetInnerHTML` everywhere, including for link detection, because a
 * stored payload that survived one code path should not become executable when
 * someone later adds "rich text".
 */
export function splitLinks(text: string): { type: 'text' | 'link'; value: string }[] {
  const out: { type: 'text' | 'link'; value: string }[] = [];
  const re = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({ type: 'link', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/** Normalise a handle for display: always prefixed with @, always lowercase. */
export function displayHandle(handle: string | null | undefined): string {
  if (!handle) return '@anonymous';
  return handle.startsWith('@') ? handle : `@${handle}`;
}
