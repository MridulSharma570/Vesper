/**
 * Runtime feature flags.
 *
 * Two layers:
 *   1. A global `feature_flags` row keyed by name, editable by admins through
 *      the admin API without a redeploy.
 *   2. `.env` defaults that seed the row on first boot.
 *
 * Every gate in the codebase reads through here rather than from `config`
 * directly, so flipping `media.pipeline.enabled=true` in the admin panel starts
 * the whole media pipeline immediately — no schema change, no client release,
 * because the client also asks for flags at boot.
 */
import type { CallKind, FeatureFlags, MediaType } from '../../../shared/types.js';
import { config, featureFlags as envFlags } from '../config.js';
import { db, nowMs, parseJson } from '../db/index.js';
import { err } from './users.js';
import { audit } from './audit.js';

const DEFAULTS: FeatureFlags = {
  mediaPipeline: false,
  allowedMediaTypes: [],
  maxUploadMb: 25,
  calls: false,
  allowedCallKinds: [],
  maxCallParticipants: 4,
  stories: false,
  e2ee: false,
  registrationMethods: ['passkey', 'otp_email'],
  maxGroupSize: 256,
  maintenance: false,
};

let cache: { flags: FeatureFlags; loadedAt: number } | null = null;
const CACHE_TTL_MS = 15_000;

export function getFlags(): FeatureFlags {
  if (cache && nowMs() - cache.loadedAt < CACHE_TTL_MS) return cache.flags;
  let stored: FeatureFlags | null = null;
  try {
    const row = db().prepare("SELECT value_json FROM feature_flags WHERE name = 'global'").get() as
      | { value_json: string }
      | undefined;
    if (row) {
      const parsed = parseJson<Partial<FeatureFlags>>(row.value_json, {});
      stored = { ...DEFAULTS, ...parsed } as FeatureFlags;
    }
  } catch {
    // Table not migrated yet (very first boot) — fall back to env defaults.
  }
  const flags = { ...DEFAULTS, ...envFlags(), ...(stored ?? {}) } as FeatureFlags;
  cache = { flags, loadedAt: nowMs() };
  return flags;
}

export function invalidateFlagCache(): void {
  cache = null;
}

/**
 * Resolve the flags that apply to one user. Rank can widen the allowlist —
 * developers and admins get the new surface before everyone else, which is how
 * the media pipeline and calls are meant to be rolled out.
 */
export function flagsFor(role: string): FeatureFlags {
  const base = getFlags();
  const privileged = ['admin', 'owner', 'developer', 'controller'].includes(role);
  if (!privileged) return base;
  return {
    ...base,
    // Staff can always exercise a pipeline that is dark for the public, so it
    // can be verified end to end before the flag is flipped.
    mediaPipeline: base.mediaPipeline || !!config.providers.moderation.blocklistDir,
    calls: base.calls,
  };
}

export function setFlags(patch: Partial<FeatureFlags>, actorId: string): FeatureFlags {
  const current = getFlags();
  const next: FeatureFlags = { ...current };

  if (patch.maxUploadMb !== undefined) {
    if (patch.maxUploadMb < 1 || patch.maxUploadMb > 2048) throw err.badRequest('maxUploadMb must be between 1 and 2048');
    next.maxUploadMb = Math.round(patch.maxUploadMb);
  }
  if (patch.maxCallParticipants !== undefined) {
    if (patch.maxCallParticipants < 2 || patch.maxCallParticipants > 512) throw err.badRequest('maxCallParticipants must be between 2 and 512');
    next.maxCallParticipants = Math.round(patch.maxCallParticipants);
  }
  if (patch.maxGroupSize !== undefined) {
    if (patch.maxGroupSize < 2 || patch.maxGroupSize > 100_000) throw err.badRequest('maxGroupSize must be between 2 and 100000');
    next.maxGroupSize = Math.round(patch.maxGroupSize);
  }
  if (patch.allowedMediaTypes) {
    const allowed = new Set(Object.keys(mediaPolicyTable()));
    const bad = patch.allowedMediaTypes.filter((t) => !allowed.has(t));
    if (bad.length) throw err.badRequest(`Unknown media type(s): ${bad.join(', ')}`);
    next.allowedMediaTypes = [...new Set(patch.allowedMediaTypes)] as MediaType[];
  }
  if (patch.allowedCallKinds) {
    const allowed = new Set<CallKind>(['voice_1v1', 'video_1v1', 'group_voice', 'group_video', 'scheduled']);
    const bad = patch.allowedCallKinds.filter((k) => !allowed.has(k));
    if (bad.length) throw err.badRequest(`Unknown call kind(s): ${bad.join(', ')}`);
    next.allowedCallKinds = [...new Set(patch.allowedCallKinds)] as CallKind[];
  }
  if (patch.registrationMethods) {
    const allowed = new Set(['passkey', 'otp_email', 'otp_sms', 'google', 'apple', 'magic_link', 'device_key']);
    const bad = patch.registrationMethods.filter((m) => !allowed.has(m));
    if (bad.length) throw err.badRequest(`Unknown registration method(s): ${bad.join(', ')}`);
    next.registrationMethods = [...new Set(patch.registrationMethods)];
  }
  for (const key of ['mediaPipeline', 'calls', 'stories', 'e2ee', 'maintenance'] as const) {
    if (patch[key] !== undefined) next[key] = !!patch[key];
  }

  db().prepare(`
    INSERT INTO feature_flags (name, value_json, updated_by, updated_at) VALUES ('global', ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(JSON.stringify(next), actorId, nowMs());

  invalidateFlagCache();
  audit({
    actorId,
    action: 'admin.feature_flags_updated',
    target: { type: 'config', id: 'global' },
    severity: 'warning',
    meta: { changed: Object.keys(patch), next },
  });
  return next;
}

export function maintenanceEnabled(): boolean {
  return getFlags().maintenance;
}

function mediaPolicyTable(): Record<MediaType, { maxBytes: number }> {
  // Mirrors MEDIA_POLICY in services/media without importing it, to avoid a
  // circular dependency between the flag layer and the media layer.
  return {
    image: { maxBytes: 25 * 1024 * 1024 },
    gif: { maxBytes: 15 * 1024 * 1024 },
    sticker: { maxBytes: 512 * 1024 },
    video: { maxBytes: 200 * 1024 * 1024 },
    audio: { maxBytes: 50 * 1024 * 1024 },
    voice: { maxBytes: 25 * 1024 * 1024 },
    document: { maxBytes: 2 * 1024 * 1024 * 1024 },
    contact_card: { maxBytes: 64 * 1024 },
    location: { maxBytes: 4 * 1024 },
    event_card: { maxBytes: 64 * 1024 },
  };
}

/** The public surface the client needs at boot. No secrets, no internals. */
export function publicConfig(role: string) {
  const flags = flagsFor(role);
  return {
    app: { name: config.app.name, version: config.app.version },
    flags,
    limits: {
      maxGroupSize: flags.maxGroupSize,
      maxUploadMb: flags.maxUploadMb,
      maxCallParticipants: flags.maxCallParticipants,
      handle: { minLength: config.auth.handle.minLength, maxLength: config.auth.handle.maxLength },
      otp: { length: config.auth.otp.length, ttlSeconds: config.auth.otp.ttlSeconds },
      password: { minLength: config.auth.password.minLength, minScore: config.auth.password.minScore },
    },
    features: {
      registrationMethods: flags.registrationMethods,
      maintenance: flags.maintenance,
    },
    storage: { driver: config.storage.driver === 'local' ? 'server' : 'object-store', presignedSupported: config.storage.driver !== 'local' },
  };
}
