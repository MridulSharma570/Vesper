/**
 * HTTP client.
 *
 * Every path is relative, so the same bundle works when served by the API
 * (production, same origin), through the Vite dev proxy, and inside a sandboxed
 * preview where an absolute `localhost` origin would be unreachable.
 *
 * Token handling: the access token lives in memory only. The refresh token is
 * kept in localStorage so a page reload does not sign you out, and it is rotated
 * on every use — the server treats a replayed refresh token as theft and revokes
 * the whole session family.
 *
 * A 401 triggers exactly one refresh attempt; concurrent 401s share that single
 * in-flight refresh rather than stampeding the endpoint.
 */
import type { AdminEvent, ConversationView, FeatureFlags, Message, PrivateProfile, Report, Session, UserSettings } from '@shared/types';
import { safeStorage } from './safeStorage';

const REFRESH_KEY = 'vesper.refresh';
const DEVICE_KEY = 'vesper.deviceId';

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

/** Stable per-install id, so the server can tell your devices apart. */
export function deviceId(): string {
  let id = safeStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    safeStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function deviceInfo() {
  return {
    deviceId: deviceId(),
    platform: 'web' as const,
    appVersion: '1.0.0',
    osVersion: navigator.platform || null,
    model: null,
    pushToken: null,
    pushProvider: 'none' as const,
  };
}

/**
 * Route a free-typed identifier to the right server field: emails contain @,
 * phone numbers are digits and separators, anything else is a handle. Getting
 * this wrong server-side would mean a handle landing in the phone column and
 * being rejected for length.
 */
function identifierField(identifier: string): { email?: string; phone?: string; handle?: string } {
  const v = identifier.trim();
  if (v.includes('@')) return { email: v };
  if (/^\+?[\d\s()-]{7,}$/.test(v)) return { phone: v };
  return { handle: v };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function getRefreshToken(): string | null {
  return safeStorage.getItem(REFRESH_KEY);
}
export function setRefreshToken(token: string | null): void {
  if (token) safeStorage.setItem(REFRESH_KEY, token);
  else safeStorage.removeItem(REFRESH_KEY);
}

export function clearAuth(): void {
  accessToken = null;
  setRefreshToken(null);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Skip the automatic refresh-and-retry, e.g. on the auth endpoints themselves. */
  raw?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const doFetch = async (token: string | null): Promise<Response> =>
    fetch(path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Vesper-Platform': 'web',
        'X-Vesper-Device-Id': deviceId(),
        'X-Vesper-App-Version': '1.0.0',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      // Never let a browser cache an identity-bearing response.
      cache: 'no-store',
    });

  let res = await doFetch(accessToken);

  if (res.status === 401 && !opts.raw && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await doFetch(refreshed);
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    const err = (json ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
    throw new ApiError(
      res.status,
      err.error?.code ?? 'request_failed',
      err.error?.message ?? `Request failed (${res.status})`,
      err.error?.details,
    );
  }
  return json as T;
}

/**
 * Exchange the refresh token for a new access token. Concurrent callers share
 * one in-flight request, because the server invalidates a refresh token the
 * moment it is used — two parallel refreshes would revoke the session.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  const token = getRefreshToken();
  if (!token) return null;

  refreshPromise = (async () => {
    try {
      const res = await request<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
        method: 'POST',
        raw: true,
        body: { refreshToken: token, device: deviceInfo() },
      });
      setAccessToken(res.accessToken);
      setRefreshToken(res.refreshToken);
      return res.accessToken;
    } catch {
      // Rotation failed — most likely the token was replayed and the family was
      // revoked. Clearing forces a clean sign-in instead of a retry loop.
      clearAuth();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

/* ─────────────────────────── Typed endpoints ─────────────────────────── */

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  session?: Session;
  profile: PrivateProfile;
  created?: boolean;
  method?: string;
  flags?: FeatureFlags;
}

export interface VerifyStep {
  step: 'verify';
  challengeId: string;
  kind: string;
  channel: 'email' | 'sms' | 'app';
  targetHint: string;
  ttlSeconds: number;
}

export type AuthResult = AuthResponse | VerifyStep;

function storeAuth(r: AuthResponse): void {
  setAccessToken(r.accessToken);
  setRefreshToken(r.refreshToken);
}

export const api = {
  /* auth */
  async deviceKeySignIn(): Promise<AuthResult> {
    // A fresh anonymous identity per install. The private key never leaves the
    // device; the server stores only a hash of the public half.
    const identityKey = safeStorage.getItem('vesper.identityKey') ?? `web-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    safeStorage.setItem('vesper.identityKey', identityKey);
    const r = await request<AuthResult>('/auth/register', {
      method: 'POST',
      raw: true,
      body: { method: 'device_key', identityKey, device: deviceInfo() },
    });
    if (!('step' in r)) storeAuth(r);
    return r;
  },

  async passwordSignIn(identifier: string, password: string): Promise<AuthResult> {
    const r = await request<AuthResult>('/auth/login', {
      method: 'POST',
      raw: true,
      body: {
        method: 'passkey',
        ...identifierField(identifier),
        password,
        device: deviceInfo(),
      },
    });
    if (!('step' in r)) storeAuth(r);
    return r;
  },

  async passwordRegister(input: {
    identifier: string;
    password: string;
    handle?: string;
    displayName?: string;
  }): Promise<AuthResult> {
    const isEmail = input.identifier.includes('@');
    const r = await request<AuthResult>('/auth/register', {
      method: 'POST',
      raw: true,
      body: {
        method: 'passkey',
        ...(isEmail ? { email: input.identifier } : { phone: input.identifier }),
        password: input.password,
        handle: input.handle,
        displayName: input.displayName,
        device: deviceInfo(),
      },
    });
    if (!('step' in r)) storeAuth(r);
    return r;
  },

  async startOtp(kind: 'otp_email' | 'otp_sms', target: string): Promise<{ challengeId: string; ttlSeconds: number }> {
    return request('/auth/otp/start', { method: 'POST', raw: true, body: { kind, target } });
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/users/me/password', {
      method: 'PATCH',
      body: { currentPassword, newPassword },
    });
  },

  /* Optional email/phone linking: start proves nothing yet — it attaches the
   * identifier as UNVERIFIED and sends an OTP. Only verify marks it trusted. */
  async startLink(method: 'email' | 'phone', value: string): Promise<{ challengeId: string; method: 'email' | 'phone' }> {
    return request<{ challengeId: string; method: 'email' | 'phone' }>('/users/me/link/start', {
      method: 'POST',
      body: { method, value },
    });
  },

  async verifyLink(challengeId: string, code: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/users/me/link/verify', {
      method: 'POST',
      body: { challengeId, code },
    });
  },

  async verifyOtp(challengeId: string, code: string): Promise<AuthResponse> {
    const r = await request<AuthResponse>('/auth/otp/verify', {
      method: 'POST',
      raw: true,
      body: { challengeId, code, device: deviceInfo(), purpose: 'signin' },
    });
    storeAuth(r);
    return r;
  },

  async requestMagicLink(email: string): Promise<{ ok: boolean; challengeId: string }> {
    return request('/auth/magic-link', { method: 'POST', raw: true, body: { email } });
  },

  async logout(all = false): Promise<void> {
    try {
      await request('/auth/logout', { method: 'POST', body: { all } });
    } finally {
      clearAuth();
    }
  },

  async realtimeTicket(): Promise<{ ticket: string; expiresIn: number }> {
    return request('/auth/realtime-ticket', { method: 'POST', body: {} });
  },

  /* me */
  me: () => request<{ profile: PrivateProfile; settings: UserSettings }>('/users/me'),
  patchMe: (body: { displayName?: string | null; bio?: string | null }) =>
    request<{ profile: PrivateProfile }>('/users/me', { method: 'PATCH', body }),
  rotateHandle: () => request<{ profile: PrivateProfile }>('/users/me/handle/rotate', { method: 'POST', body: {} }),
  settings: () => request<{ settings: UserSettings }>('/settings'),
  patchSettings: (body: Record<string, unknown>) =>
    request<{ settings: UserSettings }>('/settings', { method: 'PATCH', body }),
  exportData: () => request<Record<string, unknown>>('/users/me/export'),
  sessions: () => request<{ sessions: Session[] }>('/users/me/sessions'),
  deleteAccount: (confirmation: string) =>
    request<{ ok: boolean; deleteAfter: number }>('/users/me/delete', { method: 'POST', body: { confirmation } }),

  /* directory & contacts */
  search: (q: string) => request<{ users: unknown[] }>(`/users/search?q=${encodeURIComponent(q)}`),
  byHandle: (handle: string) =>
    request<{ user: unknown; presence: unknown }>(`/users/by-handle/${encodeURIComponent(handle.replace(/^@/, ''))}`),
  contacts: () => request<{ contacts: unknown[]; pending: unknown[] }>('/contacts'),
  addContact: (userId?: string, handle?: string) =>
    request<{ contact: unknown; outcome: string }>('/contacts', { method: 'POST', body: { userId, handle } }),
  respondContact: (requestId: string, accept: boolean) =>
    request<{ contact: unknown }>('/contacts/respond', { method: 'POST', body: { requestId, accept } }),
  removeContact: (userId: string) => request<{ ok: boolean }>(`/contacts/${userId}`, { method: 'DELETE' }),
  blockUser: (userId: string) => request<{ ok: boolean }>(`/contacts/${userId}/block`, { method: 'POST', body: {} }),
  unblockUser: (userId: string) => request<{ ok: boolean }>(`/contacts/${userId}/block`, { method: 'DELETE' }),

  /* conversations */
  conversations: (cursor?: string | null) =>
    request<{ conversations: ConversationView[]; nextCursor: string | null }>(
      `/conversations?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  openDm: (userId: string) =>
    request<{ conversation: unknown }>(`/users/${userId}/conversation`, { method: 'POST' }),
  createGroup: (title: string, memberIds: string[]) =>
    request<{ conversation: { id: string } }>('/conversations/groups', {
      method: 'POST',
      body: { title, memberIds },
    }),
  conversation: (id: string) => request<{ conversation: ConversationView }>(`/conversations/${id}`),
  messages: (id: string, before?: string) =>
    request<{ messages: Message[]; nextCursor: string | null }>(
      `/conversations/${id}/messages?limit=50${before ? `&before=${before}` : ''}`,
    ),
  sendMessage: (body: {
    conversationId: string;
    kind: string;
    clientMessageId: string;
    body: Record<string, unknown>;
  }) => request<{ message: Message; deduplicated: boolean }>('/messages', { method: 'POST', body }),
  deleteMessage: (id: string, forEveryone: boolean) =>
    request<{ ok: boolean }>(`/messages/${id}?forEveryone=${forEveryone}`, { method: 'DELETE' }),
  leaveConversation: (id: string) => request<{ ok: boolean }>(`/conversations/${id}/leave`, { method: 'POST' }),
  setPrefs: (id: string, prefs: Record<string, unknown>) =>
    request<{ conversation: ConversationView }>(`/conversations/${id}/prefs`, { method: 'PATCH', body: prefs }),

  /* reports */
  report: (body: { targetType: string; targetId: string; reason: string; details?: string }) =>
    request<{ reportId: string; message: string }>('/reports', { method: 'POST', body }),
};

/*
 * The wire shapes are the shared contract, not a client-local approximation.
 * Duplicating them here is how a client and server silently drift apart: the
 * client keeps rendering a field the server renamed, and nobody notices until a
 * user reports missing messages.
 */
export type { ConversationView, Message, PublicProfile, PrivateProfile, UserSettings } from '@shared/types';

/* ── Staff / admin surface ──────────────────────────────────────────
 * Thin typed wrappers over /admin/*. Every call is role-gated server-side;
 * the UI hides what your rank cannot use, but the server is the authority.
 */
export interface AdminUserRow {
  id: string;
  handle: string;
  role: string;
  status: string;
  createdAt: number;
  lastSeenAt: number | null;
  verified: boolean;
  suspensionUntil: number | null;
}

export interface AdminStats {
  users: Record<string, number>;
  online: { sockets: number; users: number };
  messages: { total: number; last24h: number };
  conversations: number;
  uploads: { pending: number; failed: number };
  jobs: { queued: number; running: number; failed: number };
  reports: { open: number; total: number };
  storage: { driver: string };
}

export const adminApi = {
  stats: (): Promise<AdminStats> => request<AdminStats>('/admin/stats'),
  providers: (): Promise<Record<string, unknown>> => request<Record<string, unknown>>('/admin/providers'),
  users: (q: { query?: string; status?: string; role?: string; cursor?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    return request<{ users: AdminUserRow[]; nextCursor: string | null; counts: Record<string, number> }>(
      `/admin/users?${p.toString()}`,
    );
  },
  setRole: (id: string, role: string, reason: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/admin/users/${id}/role`, { method: 'POST', body: { role, reason } }),
  setStatus: (id: string, status: string, reason: string, durationDays?: number): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/admin/users/${id}/status`, { method: 'POST', body: { status, reason, durationDays } }),
  reports: (status?: string): Promise<{ reports: Report[] }> =>
    request<{ reports: Report[] }>(`/admin/reports${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  resolveReport: (id: string, status: 'reviewing' | 'actioned' | 'dismissed', resolution?: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>(`/admin/reports/${id}/resolve`, { method: 'POST', body: { status, resolution } }),
  flags: (): Promise<{ flags: FeatureFlags; config: unknown }> => request<{ flags: FeatureFlags; config: unknown }>('/admin/flags'),
  patchFlags: (patch: Record<string, unknown>): Promise<{ flags: FeatureFlags }> =>
    request<{ flags: FeatureFlags }>('/admin/flags', { method: 'PATCH', body: patch }),
  audit: (limit = 100): Promise<{ items: AdminEvent[]; nextCursor: number | null }> =>
    request<{ items: AdminEvent[]; nextCursor: number | null }>(`/admin/audit?limit=${limit}`),
};
