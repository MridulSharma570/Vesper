/**
 * Icon set — inline SVG.
 *
 * No icon font and no CDN: the app must render identically offline, inside a
 * sandboxed preview with no network access, and inside a Capacitor WebView on a
 * slow connection. Inlined paths also inherit `currentColor`, so an icon always
 * matches the text colour of whatever it sits in.
 *
 * All icons are drawn on a 24×24 grid with a 1.75 stroke, which is the weight
 * that stays legible at 16px without looking heavy at 28px.
 */
import type { SVGProps } from 'react';

export type IconName =
  | 'chat' | 'chats' | 'send' | 'search' | 'settings' | 'user' | 'users' | 'plus'
  | 'back' | 'close' | 'check' | 'checks' | 'clock' | 'alert' | 'shield' | 'lock'
  | 'eye' | 'eyeOff' | 'trash' | 'block' | 'flag' | 'logout' | 'refresh' | 'copy'
  | 'bell' | 'bellOff' | 'pin' | 'archive' | 'phone' | 'video' | 'smile' | 'paperclip'
  | 'camera' | 'image' | 'mic' | 'doc' | 'location' | 'calendar' | 'contact' | 'sticker'
  | 'globe' | 'moon' | 'sun' | 'key' | 'mail' | 'download' | 'chevronRight' | 'chevronDown'
  | 'more' | 'edit' | 'info' | 'sparkle' | 'logo' | 'group' | 'reply' | 'ban' | 'code';

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

/** Stroke-based paths. `d` values are kept short; clarity beats cleverness. */
const PATHS: Record<IconName, string[]> = {
  chat: ['M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.4-.6L3 21l1.7-4.4A8 8 0 0 1 3.6 11 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z'],
  chats: ['M8.5 14.5A7 7 0 0 1 15.5 4a7 7 0 0 1 6.3 4', 'M15 20a7 7 0 1 0-6.3-10', 'M4 21l1.4-3.3A6.6 6.6 0 0 1 3.5 13'],
  send: ['M4.5 12 20 4.5 15.5 20l-4-6.5Z', 'M11.5 13.5 20 4.5'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M16.2 16.2 21 21'],
  settings: ['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z', 'M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3.3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1Z'],
  user: ['M12 11.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4.5 20.5a7.5 7.5 0 0 1 15 0'],
  users: ['M9.5 11a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z', 'M2.5 20a7 7 0 0 1 14 0', 'M16.5 4.2a3.75 3.75 0 0 1 0 7.1', 'M18 14.4a7 7 0 0 1 3.5 5.6'],
  group: ['M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M5 19.5a7 7 0 0 1 14 0', 'M18.5 5.5a3 3 0 0 1 0 5.8', 'M5.5 5.5a3 3 0 0 0 0 5.8'],
  plus: ['M12 5v14', 'M5 12h14'],
  back: ['M15 5l-7 7 7 7'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  check: ['M4.5 12.5 9.5 17.5 19.5 7'],
  checks: ['M2 12.5 6.5 17 15 8', 'M9.5 14.5 11 16 21 6.5'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7.5V12l3 2'],
  alert: ['M12 3.5 22 20H2Z', 'M12 10v4', 'M12 17.2v.1'],
  shield: ['M12 21.5s7.5-3.2 7.5-9V6l-7.5-3L4.5 6v6.5c0 5.8 7.5 9 7.5 9Z', 'M9 12l2 2 4-4'],
  lock: ['M6.5 11h11v9.5h-11Z', 'M8.75 11V7.75a3.25 3.25 0 0 1 6.5 0V11'],
  key: ['M15.5 3.5a5 5 0 1 0-4.2 7.7L3.5 19v2h2.5l.9-.9V18h2v-2h2l1.4-1.4A5 5 0 0 0 15.5 3.5Z', 'M16.8 7.2v.01'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  eyeOff: ['M4 4l16 16', 'M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 4.1', 'M6.3 7.9A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.6-.7', 'M9.9 10.2a3 3 0 0 0 4.1 4.2'],
  trash: ['M4 6.5h16', 'M9.5 6.5V4.2h5v2.3', 'M6.5 6.5 7.6 20.5h8.8L17.5 6.5', 'M10.2 10v7', 'M13.8 10v7'],
  block: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M5.6 5.6l12.8 12.8'],
  ban: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M5.6 5.6l12.8 12.8'],
  flag: ['M5.5 21V4', 'M5.5 5h11l-1.8 3.6L16.5 12h-11'],
  logout: ['M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15', 'M10 8l-4 4 4 4', 'M6 12h10'],
  refresh: ['M20 11a8 8 0 1 0-1.6 5.6', 'M20 5.5V11h-5.5'],
  copy: ['M9 9h10.5v10.5H9Z', 'M15 9V4.5H4.5V15H9'],
  bell: ['M6.5 10a5.5 5.5 0 1 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10Z', 'M10.2 19a2 2 0 0 0 3.6 0'],
  bellOff: ['M4 4l16 16', 'M8.3 5.9A5.5 5.5 0 0 1 17.5 10c0 1.4.2 2.5.5 3.3', 'M6.2 8.4A5.6 5.6 0 0 0 6.5 10c0 4-1.5 5.5-1.5 5.5h11', 'M10.2 19a2 2 0 0 0 3.6 0'],
  pin: ['M9 3.5h6l-1 5.2 3.2 3.3H5.8L9 8.7Z', 'M12 12v8.5'],
  archive: ['M3.5 5.5h17v4h-17Z', 'M5.5 9.5v9.5h13V9.5', 'M10 13h4'],
  phone: ['M6.6 3.5h3l1.5 4-2 1.4a12 12 0 0 0 5.9 5.9l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A17.5 17.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z'],
  video: ['M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h8.1a1.7 1.7 0 0 1 1.7 1.7v9.6a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z', 'M15 10.5l5.5-3.2v9.4L15 13.5Z'],
  smile: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M8.8 14.2a4 4 0 0 0 6.4 0', 'M9.2 9.4v.1', 'M14.8 9.4v.1'],
  paperclip: ['M20 11.5 12.4 19a4.6 4.6 0 0 1-6.5-6.5l7.6-7.6a3.1 3.1 0 0 1 4.4 4.4l-7.6 7.6a1.6 1.6 0 0 1-2.2-2.2l6.9-6.9'],
  camera: ['M3.5 8.5h3.2l1.5-2.5h7.6l1.5 2.5h3.2v10.5H3.5Z', 'M12 16.2a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z'],
  image: ['M4 5h16v14H4Z', 'M4 16l4.5-4.5 3.5 3.5 3-3L20 16.5', 'M9 9.5v.01'],
  mic: ['M12 14.5a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5.5a3 3 0 0 0 3 3Z', 'M18.5 11a6.5 6.5 0 0 1-13 0', 'M12 17.5V21'],
  doc: ['M13.5 3.5H7v17h10V8Z', 'M13.5 3.5V8H17', 'M9.5 12.5h5', 'M9.5 16h5'],
  location: ['M12 21.5s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z', 'M12 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
  calendar: ['M4 6h16v14.5H4Z', 'M4 10.5h16', 'M8.5 3.5V7', 'M15.5 3.5V7'],
  contact: ['M5 3.5h14v17H5Z', 'M3 8h2', 'M3 12.5h2', 'M3 17h2', 'M9.5 8.5h6', 'M9.5 12h6', 'M9.5 15.5h3.5'],
  sticker: ['M20.5 12.4V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v12A2.5 2.5 0 0 0 6 20.5h6.4Z', 'M20.5 12.4h-5.6a2.5 2.5 0 0 0-2.5 2.5v5.6'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3.2 9.5h17.6', 'M3.2 14.5h17.6', 'M12 3a15 15 0 0 1 0 18', 'M12 3a15 15 0 0 0 0 18'],
  moon: ['M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z'],
  sun: ['M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z', 'M12 2v2.2', 'M12 19.8V22', 'M2 12h2.2', 'M19.8 12H22', 'M4.9 4.9l1.6 1.6', 'M17.5 17.5l1.6 1.6', 'M19.1 4.9l-1.6 1.6', 'M6.5 17.5l-1.6 1.6'],
  mail: ['M3.5 5.5h17v13h-17Z', 'm3.5 6.5 8.5 6.5 8.5-6.5'],
  download: ['M12 3.5v11', 'M7.5 10.5 12 15l4.5-4.5', 'M4.5 19.5h15'],
  chevronRight: ['M9 5l7 7-7 7'],
  chevronDown: ['M5 9l7 7 7-7'],
  more: ['M12 6.2v.01', 'M12 12v.01', 'M12 17.8v.01'],
  edit: ['M4.5 19.5h4L19 9a2.5 2.5 0 0 0-3.5-3.5L5 16Z', 'M14.5 6.5 17.5 9.5'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5.5', 'M12 7.8v.01'],
  sparkle: ['M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9Z', 'M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z'],
  reply: ['M9 7 4 12l5 5', 'M4 12h9.5a6.5 6.5 0 0 1 6.5 6.5V20'],
  code: ['M8.5 7.5 4 12l4.5 4.5', 'M15.5 7.5 20 12l-4.5 4.5', 'M13.5 4.5l-3 15'],
  // Concentric sound waves — the Vesper mark.
  logo: ['M12 13.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z', 'M8.2 15.8a5.4 5.4 0 0 1 0-7.6', 'M15.8 8.2a5.4 5.4 0 0 1 0 7.6', 'M5.4 18.6a9.3 9.3 0 0 1 0-13.2', 'M18.6 5.4a9.3 9.3 0 0 1 0 13.2'],
};

/** Icons that read better filled than stroked. */
const FILLED: ReadonlySet<IconName> = new Set(['more']);

export function Icon({ name, size = 20, strokeWidth = 1.75, ...rest }: Props): JSX.Element {
  const paths = PATHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={FILLED.has(name) ? 'currentColor' : 'none'}
      stroke={FILLED.has(name) ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {FILLED.has(name)
        // 'more' is three dots; the path data is unused for it.
        ? paths.map((_d, i) => <circle key={i} cx="12" cy={6 + i * 5.8} r="1.9" />)
        : paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** The Vesper wordmark + logo, used on the sign-in screen and in the sidebar. */
export function Logo({ size = 34, withWord = true }: { size?: number; withWord?: boolean }): JSX.Element {
  return (
    <span className="center" style={{ gap: withWord ? 9 : 0 }}>
      <span
        aria-hidden="true"
        style={{
          width: size, height: size, borderRadius: size * 0.3,
          display: 'grid', placeItems: 'center', flex: 'none',
          background: 'linear-gradient(145deg, var(--brand-400), var(--brand-700))',
          color: '#fff', boxShadow: 'var(--glow-brand)',
        }}
      >
        <Icon name="logo" size={size * 0.66} strokeWidth={1.9} />
      </span>
      {withWord && (
        <span style={{ fontSize: size * 0.55, fontWeight: 750, letterSpacing: '-0.035em' }}>
          Vesper
        </span>
      )}
    </span>
  );
}
