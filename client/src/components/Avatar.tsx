/**
 * Avatar.
 *
 * Generated, never uploaded. Every account gets a deterministic gradient and
 * ring pattern derived from its own id, so an anonymous user still has a stable,
 * recognisable face across devices and reloads — without ever providing a photo
 * that could identify them.
 *
 * The concentric rings echo the logo: sound waves, i.e. a vesper. The hue comes
 * from the server's `avatarHue` when present, and falls back to a local derivation
 * so the component works for ids the server has not described (search results,
 * optimistic messages).
 */
import { hueFromId, initials } from '../lib/format';
import { Icon } from './Icon';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface Props {
  seed: string;
  handle?: string | null;
  displayName?: string | null;
  size?: AvatarSize;
  /** Hue override from the server (0-359). */
  hue?: number | null;
  online?: boolean;
  showPresence?: boolean;
  group?: boolean;
  self?: boolean;
}

export function Avatar({
  seed, handle, displayName, size = 'md', hue, online = false,
  showPresence = false, group = false, self = false,
}: Props): JSX.Element {
  const h = hue ?? hueFromId(seed);
  const label = displayName?.trim() || handle?.replace(/^@/, '') || '';

  return (
    <span
      className={`avatar avatar-${size} avatar-rings`}
      // The hue is the only per-instance value; everything else comes from CSS.
      style={{ ['--hue' as string]: h }}
      role="img"
      aria-label={label ? `Avatar for ${label}` : 'Anonymous avatar'}
      title={label ? `@${handle ?? label}` : 'Anonymous'}
    >
      {self ? (
        <Icon name="archive" size={sizePx(size) * 0.46} strokeWidth={1.9} />
      ) : group ? (
        <Icon name="users" size={sizePx(size) * 0.46} strokeWidth={1.9} />
      ) : (
        <span>{initials(handle, displayName)}</span>
      )}
      {showPresence && <i className="presence-dot" data-online={online} />}
    </span>
  );
}

function sizePx(size: AvatarSize): number {
  return { xs: 28, sm: 36, md: 46, lg: 64, xl: 96 }[size];
}

/**
 * A row of overlapping avatars, for group conversation previews.
 * `max` caps the render so a 256-member group does not draw 256 gradients.
 */
export function AvatarStack({ members, max = 3, size = 'xs' }: {
  members: { id: string; handle?: string | null; displayName?: string | null }[];
  max?: number;
  size?: AvatarSize;
}): JSX.Element {
  const shown = members.slice(0, max);
  const extra = members.length - shown.length;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {shown.map((m, i) => (
        <span key={m.id} style={{ marginLeft: i === 0 ? 0 : -8, zIndex: shown.length - i, boxShadow: '0 0 0 2px var(--bg-elevated)', borderRadius: '50%' }}>
          <Avatar seed={m.id} handle={m.handle} displayName={m.displayName} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span
          className={`avatar avatar-${size}`}
          style={{ marginLeft: -8, background: 'var(--bg-active)', color: 'var(--text-secondary)', fontSize: 10, boxShadow: '0 0 0 2px var(--bg-elevated)' }}
          aria-label={`${extra} more members`}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
