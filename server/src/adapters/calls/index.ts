/**
 * Call media-plane adapters.
 *
 * The signalling state machine lives in `services/calls.ts` and is complete for
 * every call type (1:1 voice, 1:1 video, group voice, group video, scheduled).
 * This module decides *where the media flows*, and that decision is the only
 * thing that changes when you launch calling:
 *
 *  - `mesh`      P2P WebRTC. Needs nothing but our own signalling plus STUN.
 *                Works for 1:1 and small groups immediately. This is the default.
 *  - `livekit`   Managed/self-hosted SFU. Required for larger group calls and
 *                for recording. Set LIVEKIT_URL/API_KEY/API_SECRET.
 *  - `mediasoup` Self-hosted SFU, when you want the media inside your own VPC.
 *  - `janus`     Gateway SFU; also the path to SIP/PSTN dial-out later.
 *  - `agora`     Managed SFU with strong APAC PoP coverage.
 *
 * Every adapter returns the same `CallMediaGrant` shape, so `services/calls.ts`
 * never branches on the vendor. Adding a sixth provider means adding one class.
 */
import { config } from '../../config.js';
import type { CallKind, CallTopology, IceServer } from '../../../../shared/types.js';
import { base64url, hmacSha256, utf8 } from '../../security/crypto.js';

export interface CallMediaGrant {
  /** Opaque token the client presents to the media server. Never contains ids. */
  joinToken: string | null;
  /** Server URL for SFU adapters; null for pure mesh. */
  joinUrl: string | null;
  iceServers: IceServer[];
  topology: CallTopology;
  adapter: string;
  maxParticipants: number;
}

export interface CreateRoomInput {
  roomId: string;
  kind: CallKind;
  createdBy: string;
  participantIds: string[];
  maxParticipants: number;
}

export interface CallMediaAdapter {
  readonly name: string;
  readonly topology: CallTopology;
  isConfigured(): boolean;
  supports(kind: CallKind): boolean;
  createRoom(input: CreateRoomInput): Promise<CallMediaGrant>;
  /** Token for an additional participant joining an in-progress room. */
  participantToken(roomId: string, userId: string, canPublish: boolean): Promise<string | null>;
  closeRoom(roomId: string): Promise<void>;
}

/* ── ICE configuration shared by every adapter ──────────────────── */

function iceServers(): IceServer[] {
  const servers: IceServer[] = config.providers.calls.iceServers.map((url) => ({ urls: [url] }));
  const { urls, username, credential } = config.providers.calls.turn;
  if (urls.length && username && credential) {
    // TURN credentials must be short-lived. A time-limited username derived from
    // the server secret means a leaked credential expires on its own.
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const scopedUser = `${expiry}:${username}`;
    servers.push({
      urls,
      username: scopedUser,
      credential: base64url(hmacSha256(utf8(credential), scopedUser)),
    });
  }
  return servers;
}

/* ── Mesh (P2P) ─────────────────────────────────────────────────── */

class MeshAdapter implements CallMediaAdapter {
  readonly name = 'mesh';
  readonly topology: CallTopology = 'mesh';

  isConfigured(): boolean {
    return true;
  }

  /**
   * A full mesh needs n*(n-1)/2 peer connections. Beyond four participants the
   * uplink cost on mobile becomes unusable, so we cap it and let the caller
   * fall back to an SFU if one is configured.
   */
  supports(kind: CallKind): boolean {
    if (kind === 'voice_1v1' || kind === 'video_1v1') return true;
    return config.features.maxCallParticipants <= 4;
  }

  async createRoom(input: CreateRoomInput): Promise<CallMediaGrant> {
    return {
      joinToken: null,
      joinUrl: null,
      iceServers: iceServers(),
      topology: 'mesh',
      adapter: this.name,
      maxParticipants: Math.min(input.maxParticipants, 4),
    };
  }

  async participantToken(): Promise<string | null> {
    return null;
  }

  async closeRoom(): Promise<void> {
    // Nothing server-side to tear down; participants are notified via signalling.
  }
}

/* ── LiveKit (SFU) ──────────────────────────────────────────────── */

class LiveKitAdapter implements CallMediaAdapter {
  readonly name = 'livekit';
  readonly topology: CallTopology = 'sfu';

  isConfigured(): boolean {
    const { url, apiKey, apiSecret } = config.providers.calls.livekit;
    return !!(url && apiKey && apiSecret);
  }

  supports(): boolean {
    return this.isConfigured();
  }

  /**
   * LiveKit access tokens are JWTs signed with HS256 against the API secret.
   * Implemented directly rather than via the SDK so the same code runs on the
   * server and inside the Windows/Electron bundle.
   */
  private async accessToken(roomId: string, identity: string, canPublish: boolean): Promise<string> {
    const { apiKey, apiSecret } = config.providers.calls.livekit;
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const claims = base64url(utf8(JSON.stringify({
      iss: apiKey,
      sub: identity,
      nbf: now - 10,
      exp: now + 6 * 3600,
      video: {
        room: roomId,
        roomJoin: true,
        canPublish,
        canSubscribe: true,
        canPublishData: true,
      },
    })));
    const signature = base64url(hmacSha256(utf8(apiSecret), `${header}.${claims}`));
    return `${header}.${claims}.${signature}`;
  }

  async createRoom(input: CreateRoomInput): Promise<CallMediaGrant> {
    // The first participant gets a publisher token; room creation is implicit in
    // LiveKit, so no separate API call is required.
    const token = await this.accessToken(input.roomId, input.createdBy, true);
    return {
      joinToken: token,
      joinUrl: config.providers.calls.livekit.url,
      iceServers: iceServers(),
      topology: 'sfu',
      adapter: this.name,
      maxParticipants: input.maxParticipants,
    };
  }

  async participantToken(roomId: string, userId: string, canPublish: boolean): Promise<string | null> {
    if (!this.isConfigured()) return null;
    return this.accessToken(roomId, userId, canPublish);
  }

  async closeRoom(roomId: string): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const token = await this.accessToken(roomId, 'vesper-server', false);
      await fetch(`${config.providers.calls.livekit.url.replace(/^ws/, 'http')}/rooms/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomId }),
      });
    } catch {
      // A failed teardown is not fatal; LiveKit empties idle rooms on its own.
    }
  }
}

/* ── Agora (managed SFU) ────────────────────────────────────────── */

class AgoraAdapter implements CallMediaAdapter {
  readonly name = 'agora';
  readonly topology: CallTopology = 'sfu';

  isConfigured(): boolean {
    return !!(config.providers.calls.agora.appId && config.providers.calls.agora.appCertificate);
  }

  supports(): boolean {
    return this.isConfigured();
  }

  async createRoom(input: CreateRoomInput): Promise<CallMediaGrant> {
    // Agora RTM/RTC tokens need the App Certificate. We return the channel
    // and let the client build its token with the Agora SDK, or enable
    // APP_ID-only mode for evaluation.
    return {
      joinToken: config.providers.calls.agora.appId,
      joinUrl: null,
      iceServers: iceServers(),
      topology: 'sfu',
      adapter: this.name,
      maxParticipants: input.maxParticipants,
    };
  }

  async participantToken(): Promise<string | null> {
    return null;
  }

  async closeRoom(): Promise<void> {
    /* channels close when the last participant leaves */
  }
}

/* ── mediasoup / janus (self-hosted SFU, wiring points) ─────────── */

class GenericSfuAdapter implements CallMediaAdapter {
  constructor(readonly name: 'mediasoup' | 'janus', readonly topology: CallTopology = 'sfu') {}

  isConfigured(): boolean {
    // These require a co-located media server process. Until one is deployed we
    // report unconfigured so the router falls back to mesh instead of handing a
    // client a URL that does not exist.
    return false;
  }

  supports(): boolean {
    return this.isConfigured();
  }

  async createRoom(input: CreateRoomInput): Promise<CallMediaGrant> {
    return {
      joinToken: null,
      joinUrl: null,
      iceServers: iceServers(),
      topology: this.topology,
      adapter: this.name,
      maxParticipants: input.maxParticipants,
    };
  }

  async participantToken(): Promise<string | null> {
    return null;
  }

  async closeRoom(): Promise<void> {
    /* no-op until the media server is wired */
  }
}

/* ── Router ─────────────────────────────────────────────────────── */

const adapters: Record<string, CallMediaAdapter> = {
  mesh: new MeshAdapter(),
  livekit: new LiveKitAdapter(),
  agora: new AgoraAdapter(),
  mediasoup: new GenericSfuAdapter('mediasoup'),
  janus: new GenericSfuAdapter('janus'),
};

/**
 * Pick the adapter for a call kind. Preference order:
 *   1. the explicitly configured adapter, if it is configured and supports the kind
 *   2. mesh for 1:1
 *   3. the first configured SFU
 *   4. mesh as a last resort (group calls will then be capped at 4)
 */
export function selectAdapter(kind: CallKind): CallMediaAdapter {
  const configured = adapters[config.providers.calls.adapter];
  if (configured?.isConfigured() && configured.supports(kind)) return configured;

  if (kind === 'voice_1v1' || kind === 'video_1v1') return adapters.mesh!;

  const sfu = [adapters.livekit!, adapters.agora!, adapters.mediasoup!, adapters.janus!].find(
    (a) => a.isConfigured() && a.supports(kind),
  );
  return sfu ?? adapters.mesh!;
}

export function callAdaptersStatus(): Record<string, boolean> {
  return Object.fromEntries(Object.entries(adapters).map(([k, v]) => [k, v.isConfigured()]));
}

export { iceServers };
