/**
 * Vesper — shared domain types.
 *
 * This single file is the contract between the server and every client
 * (web, Android, iOS, Windows). It is copied into both workspaces by
 * `npm run setup`, so there is exactly one source of truth.
 */

/* ─────────────────────────── Identifiers ─────────────────────────── */

/** Opaque ULID-style identifier. Never sequential, never leaks creation order. */
export type Id = string;

/** Orderable message id (time-ordered, base36). */
export type Snowflake = string;

/* ─────────────────────────── Roles & accounts ─────────────────────────── */

/**
 * Role ladder. Rank is strictly increasing; authorisation compares ranks.
 *  - user       : ordinary pseudonymous member
 *  - moderator  : trust & safety (reports, mutes, takedowns)
 *  - controller : operations (feature flags, rate limits, broadcasts, escalations)
 *  - developer  : technical ops (diagnostics, queues, migrations, redacted logs)
 *  - admin      : full control incl. role grants and destructive actions
 *  - owner      : immutable root; exactly one, cannot be demoted or deleted
 */
export const ROLES = ['user', 'moderator', 'controller', 'developer', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = {
  user: 10,
  moderator: 30,
  controller: 50,
  developer: 60,
  admin: 80,
  owner: 100,
};

export type AccountStatus =
  | 'pending_verification'
  | 'active'
  | 'limited'      // can read, cannot post
  | 'suspended'    // temporary, has a lift date
  | 'deactivated'  // user-initiated, reversible inside grace window
  | 'deleted';     // tombstone after purge

export type Visibility = 'public' | 'contacts' | 'private';

export type LoginMethod =
  | 'passkey'      // email/phone + password (hashed)
  | 'otp_email'
  | 'otp_sms'
  | 'google'
  | 'apple'
  | 'magic_link'
  | 'device_key';  // pure local keypair, no provider involved

/* ─────────────────────────── Profiles ─────────────────────────── */

export interface AvatarSpec {
  /** Deterministic identicon seed so an avatar renders offline with no network fetch. */
  seed: string;
  hue: number;
  attachmentId?: Id | null;
}

export interface PublicProfile {
  id: Id;
  handle: string;              // @quiet-otter — chosen or auto generated
  displayName: string | null;  // null = fully anonymous
  bio: string | null;
  avatar: AvatarSpec;
  presence: PresenceState;
  createdAt: number;
  isContact?: boolean;
  isBlocked?: boolean;
}

export interface IdentityFingerprint {
  method: LoginMethod | 'email' | 'phone';
  /** SHA-256(normalised value + server pepper), hex, first 12 chars. Safe to show the owner. */
  fingerprint: string;
  addedAt: number;
  isPrimary: boolean;
}

export interface PrivateProfile extends PublicProfile {
  status: AccountStatus;
  role: Role;
  settings: UserSettings;
  identityFingerprints: IdentityFingerprint[];
  verified: boolean;
  lastSeenAt: number | null;
  twoFactorEnabled: boolean;
  /** Set by staff tooling on credential reset: the client must force a change. */
  mustChangePassword: boolean;
}

/* ─────────────────────────── Settings ─────────────────────────── */

export const ACCENTS = ['aurora', 'dusk', 'mint', 'sand', 'rose', 'slate'] as const;
export type AccentName = (typeof ACCENTS)[number];

export interface UserSettings {
  privacy: {
    whoCanMessageMe: 'everyone' | 'contacts' | 'nobody';
    whoCanAddMeToGroups: 'everyone' | 'contacts' | 'nobody';
    whoCanSeeMyHandle: 'everyone' | 'contacts' | 'nobody';
    whoCanCallMe: 'everyone' | 'contacts' | 'nobody';
    showReadReceipts: boolean;
    showTypingIndicator: boolean;
    showPresence: boolean;
    requireContactToMessage: boolean;
    linkPreviewEnabled: boolean;
  };
  security: {
    twoFactorEnabled: boolean;
    sessionLifetimeDays: number;
    lockAfterInactivityMinutes: number | null;
    screenshotProtectionHint: boolean;
    autoDeleteMessagesAfterDays: number | null;
    encryptLocalStore: boolean;
    loginAlerts: boolean;
  };
  notifications: {
    enabled: boolean;
    sound: boolean;
    desktop: boolean;
    mobile: boolean;
    previewInNotification: 'always' | 'contacts' | 'never';
    groupMentionsOnly: boolean;
    quietHours: { enabled: boolean; start: string; end: string } | null;
  };
  appearance: {
    theme: 'light' | 'dark' | 'system';
    accent: AccentName;
    fontSize: 'small' | 'medium' | 'large';
    reducedMotion: boolean;
    chatWallpaper: string | null;
    bubbleStyle: 'soft' | 'classic' | 'compact';
  };
  data: {
    autoDownload: { wifi: MediaType[]; cellular: MediaType[] };
    storageLimitMb: number;
    keepMediaForDays: number | null;
  };
  experimental: {
    enableMediaPipeline: boolean;
    enableCalls: boolean;
    enableStories: boolean;
    enableE2eeBeta: boolean;
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  privacy: {
    whoCanMessageMe: 'contacts',
    whoCanAddMeToGroups: 'contacts',
    whoCanSeeMyHandle: 'contacts',
    whoCanCallMe: 'contacts',
    showReadReceipts: true,
    showTypingIndicator: true,
    showPresence: true,
    requireContactToMessage: false,
    linkPreviewEnabled: false,
  },
  security: {
    twoFactorEnabled: false,
    sessionLifetimeDays: 30,
    lockAfterInactivityMinutes: null,
    screenshotProtectionHint: false,
    autoDeleteMessagesAfterDays: null,
    encryptLocalStore: true,
    loginAlerts: true,
  },
  notifications: {
    enabled: true,
    sound: true,
    desktop: true,
    mobile: true,
    previewInNotification: 'contacts',
    groupMentionsOnly: false,
    quietHours: null,
  },
  appearance: {
    theme: 'system',
    accent: 'aurora',
    fontSize: 'medium',
    reducedMotion: false,
    chatWallpaper: null,
    bubbleStyle: 'soft',
  },
  data: {
    autoDownload: { wifi: ['image', 'sticker', 'gif'], cellular: ['image', 'sticker'] },
    storageLimitMb: 500,
    keepMediaForDays: 30,
  },
  experimental: {
    enableMediaPipeline: false,
    enableCalls: false,
    enableStories: false,
    enableE2eeBeta: false,
  },
};

/* ─────────────────────────── Presence ─────────────────────────── */

export type PresenceState = 'online' | 'away' | 'dnd' | 'offline';

export interface PresenceEvent {
  userId: Id;
  state: PresenceState;
  lastSeenAt: number;
}

/* ─────────────────────────── Contacts ─────────────────────────── */

export type ContactStatus = 'pending' | 'accepted' | 'blocked' | 'rejected';

export interface Contact {
  id: Id;
  userId: Id;
  contactUserId: Id;
  status: ContactStatus;
  alias: string | null;
  createdAt: number;
  acceptedAt: number | null;
  profile?: PublicProfile;
}

/* ─────────────────────────── Conversations ─────────────────────────── */

export type ConversationKind = 'direct' | 'group' | 'channel' | 'self';
export type MemberRole = 'owner' | 'admin' | 'moderator' | 'member';

export interface Conversation {
  id: Id;
  kind: ConversationKind;
  title: string | null;
  avatar: AvatarSpec | null;
  memberCount: number;
  createdAt: number;
  lastMessageAt: number | null;
  /** Conversation-wide disappearing timer (Snapchat style). Null = keep. */
  disappearingAfterSeconds: number | null;
  createdBy: Id;
  isVerified: boolean;
}

export interface ConversationMember {
  conversationId: Id;
  userId: Id;
  role: MemberRole;
  joinedAt: number;
  mutedUntil: number | null;
  lastReadMessageId: Snowflake | null;
  lastReadAt: number;
  notificationsEnabled: boolean;
  pinned: boolean;
  archived: boolean;
}

export interface ConversationView {
  conversation: Conversation;
  member: ConversationMember;
  members: PublicProfile[];
  lastMessage: Message | null;
  unreadCount: number;
  typing: Id[];
}

/* ─────────────────────────── Messages ─────────────────────────── */

/**
 * Every message is one of these kinds. `text` is the only kind enabled at
 * launch; the rest are fully implemented server-side and gated by feature
 * flags so they can be switched on without a schema change or client release.
 */
export const MESSAGE_KINDS = [
  'text',
  'image',
  'gif',
  'sticker',
  'audio',
  'voice_note',
  'video',
  'video_note',
  'document',
  'contact',
  'location',
  'event',
  'poll',
  'system',
  'call_log',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MESSAGE_STATUS = ['sending', 'sent', 'delivered', 'read', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUS)[number];

export type MediaType =
  | 'image' | 'gif' | 'sticker' | 'video' | 'audio' | 'voice'
  | 'document' | 'contact_card' | 'location' | 'event_card';

export interface Attachment {
  id: Id;
  type: MediaType;
  mimeType: string;
  filename: string | null;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  /** Base64 audio peaks for voice-note waveforms. */
  waveform?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationName?: string | null;
  thumbnailId?: Id | null;
  blurhash?: string | null;
  sha256: string;
  storageKey: string;
  storageDriver: string;
  scanned: boolean;
  scanVerdict: 'pending' | 'clean' | 'blocked' | 'review';
  createdAt: number;
  /** Signed URL, populated only on authorised read. Never persisted. */
  url?: string;
  thumbUrl?: string;
  /** Auto-purged after this timestamp when ephemeral. */
  expiresAt?: number | null;
}

export interface ContactPayload {
  displayName: string;
  phones: { label: string; value: string }[];
  emails: { label: string; value: string }[];
  /** Resolved server-side if the contact is on Vesper. Raw PII is not retained. */
  vesperUserId?: Id | null;
}

export interface EventPayload {
  title: string;
  description: string | null;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  timezone: string;
  location: string | null;
  rsvp: 'yes' | 'no' | 'maybe' | null;
  rsvpCounts: Record<'yes' | 'no' | 'maybe', number>;
}

export interface PollPayload {
  question: string;
  options: { id: string; text: string; votes: number }[];
  multiSelect: boolean;
  anonymous: boolean;
  closesAt: number | null;
  myVote: string[] | null;
}

export interface MessageEntity {
  type: 'mention' | 'link' | 'hashtag' | 'bold' | 'italic' | 'code' | 'spoiler';
  offset: number;
  length: number;
  value?: string;
}

export interface MessageBody {
  text: string;
  entities: MessageEntity[];
  attachment?: Attachment | null;
  contact?: ContactPayload | null;
  location?: { latitude: number; longitude: number; name: string | null } | null;
  event?: EventPayload | null;
  poll?: PollPayload | null;
  replyTo?: { id: Snowflake; userId: Id; preview: string } | null;
  stickerPackId?: Id | null;
  gifProvider?: 'giphy' | 'tenor' | 'internal' | null;
  gifId?: string | null;
}

export interface Reaction {
  emoji: string;
  userIds: Id[];
}

export interface Message {
  id: Snowflake;
  conversationId: Id;
  senderId: Id;
  kind: MessageKind;
  body: MessageBody;
  status: MessageStatus;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  expiresIn: number | null;
  expiresAt: number | null;
  reactions: Reaction[];
  readBy: Id[];
  /** Client-generated idempotency key so retries never duplicate. */
  clientMessageId: string;
  /** True once E2EE is on; body then travels as an opaque envelope. */
  encrypted: boolean;
  keyId: string | null;
}

/* ─────────────────────────── Media pipeline ─────────────────────────── */

export type UploadStage =
  | 'requested'   // client asked for an upload slot
  | 'uploading'   // bytes in flight (chunked)
  | 'processing'  // transcode / thumbnail / probe
  | 'scanning'    // malware + abuse-hash moderation
  | 'ready'       // attachable to a message
  | 'failed'
  | 'expired';

/** Server-issued upload grant. Keeps large bytes off the API hot path. */
export interface UploadGrant {
  uploadId: Id;
  stage: UploadStage;
  type: MediaType;
  mimeType: string;
  maxBytes: number;
  chunkSize: number;
  totalChunks: number | null;
  /** `api` = stream through the server; `presigned` = direct to object storage. */
  mode: 'api' | 'presigned';
  presignedUrls?: string[];
  headers: Record<string, string>;
  expiresAt: number;
}

export type MediaJobKind =
  | 'probe'           // dimensions / duration / bitrate
  | 'thumbnail'       // poster frame, waveform, blurhash
  | 'transcode'       // H.264/AV1 + Opus/AAC normalisation
  | 'strip_metadata'  // EXIF/GPS removal for privacy
  | 'hash'            // perceptual + SHA-256 for dedupe and abuse matching
  | 'scan'            // AV + known-abuse hash lookup
  | 'stickers'        // webp/tgs animation normalisation
  | 'gif'             // gif -> mp4/webm optimisation
  | 'waveform'        // audio peaks
  | 'cleanup';

export interface MediaJob {
  id: Id;
  uploadId: Id;
  attachmentId: Id | null;
  kind: MediaJobKind;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/* ─────────────────────────── Calls ─────────────────────────── */

export const CALL_KINDS = ['voice_1v1', 'video_1v1', 'group_voice', 'group_video', 'scheduled'] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export type CallState =
  | 'ringing' | 'connecting' | 'active' | 'on_hold'
  | 'reconnecting' | 'ended' | 'missed' | 'declined' | 'failed';

/**
 * Topology selects the media-plane adapter:
 *  - mesh : P2P WebRTC — works with signalling alone, ideal for 1:1 and <= 4 peers
 *  - sfu  : selective forwarding unit (LiveKit / mediasoup / Janus) for group calls
 *  - mcu  : mixed, required later for PSTN/SIP dial-out
 */
export type CallTopology = 'mesh' | 'sfu' | 'mcu';

export const PLATFORMS = ['web', 'android', 'ios', 'windows', 'macos', 'linux', 'unknown'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface ClientMediaCapabilities {
  audioIn: boolean;
  audioOut: boolean;
  videoIn: boolean;
  videoOut: boolean;
  screenShare: boolean;
  maxVideoWidth: number;
  maxVideoHeight: number;
  maxBitrateKbps: number;
  codecs: string[];
  platform: Platform;
}

export interface CallParticipant {
  userId: Id;
  joinedAt: number | null;
  leftAt: number | null;
  state: 'invited' | 'ringing' | 'joined' | 'left' | 'declined' | 'missed';
  audioMuted: boolean;
  videoMuted: boolean;
  capabilities: ClientMediaCapabilities;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface CallRoom {
  id: Id;
  conversationId: Id;
  kind: CallKind;
  topology: CallTopology;
  state: CallState;
  createdBy: Id;
  startedAt: number;
  endedAt: number | null;
  participants: CallParticipant[];
  /** Opaque adapter token for the media plane. Never contains user ids. */
  joinToken: string | null;
  joinUrl: string | null;
  iceServers: IceServer[];
  maxParticipants: number;
  recordingEnabled: boolean;
  scheduledFor: number | null;
}

/** Signalling frames — the complete state machine for every call type. */
export type CallSignal =
  | { t: 'call.offer'; callId: Id; conversationId: Id; kind: CallKind; sdp: string; capabilities: ClientMediaCapabilities }
  | { t: 'call.answer'; callId: Id; sdp: string; capabilities: ClientMediaCapabilities }
  | { t: 'call.ice'; callId: Id; candidate: unknown }
  | { t: 'call.decline'; callId: Id; reason?: string }
  | { t: 'call.cancel'; callId: Id }
  | { t: 'call.end'; callId: Id }
  | { t: 'call.join'; callId: Id }
  | { t: 'call.leave'; callId: Id }
  | { t: 'call.mute'; callId: Id; audio?: boolean; video?: boolean }
  | { t: 'call.participants'; callId: Id; participants: CallParticipant[] }
  | { t: 'call.state'; callId: Id; state: CallState; room?: CallRoom }
  | { t: 'call.ringing'; callId: Id; userId: Id }
  | { t: 'call.error'; callId: Id; code: string; message: string };

/* ─────────────────────────── Devices & sessions ─────────────────────────── */

export interface DeviceInfo {
  deviceId: string;
  platform: Platform;
  appVersion: string;
  osVersion: string | null;
  model: string | null;
  pushToken: string | null;
  pushProvider: 'fcm' | 'apns' | 'web' | 'wns' | 'none';
}

export interface Session {
  id: Id;
  userId: Id;
  device: DeviceInfo;
  ipHash: string;
  country: string | null;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  revokedAt: number | null;
  current: boolean;
}

/* ─────────────────────────── Realtime protocol ─────────────────────────── */

export type ClientFrame =
  | { t: 'hello'; deviceId: string; platform: Platform; appVersion: string; resumeToken?: string }
  | { t: 'ping'; ts: number }
  | { t: 'presence.set'; state: PresenceState }
  | { t: 'typing'; conversationId: Id; isTyping: boolean }
  | { t: 'message.send'; clientMessageId: string; conversationId: Id; kind: MessageKind; body: MessageBody; expiresIn?: number | null }
  | { t: 'message.edit'; id: Snowflake; text: string }
  | { t: 'message.delete'; id: Snowflake; forEveryone: boolean }
  | { t: 'message.read'; conversationId: Id; messageId: Snowflake }
  | { t: 'reaction.toggle'; messageId: Snowflake; emoji: string }
  | { t: 'conversation.subscribe'; conversationId: Id }
  | { t: 'conversation.unsubscribe'; conversationId: Id }
  | { t: 'upload.progress'; uploadId: Id; bytesSent: number }
  | CallSignal;

export type ServerFrame =
  | { t: 'ready'; userId: Id; sessionId: Id; resumeToken: string; serverTime: number; features: FeatureFlags }
  | { t: 'pong'; ts: number; latencyMs: number }
  | { t: 'error'; code: string; message: string; ref?: string }
  | { t: 'message.new'; message: Message }
  | { t: 'message.updated'; message: Message }
  | { t: 'message.deleted'; id: Snowflake; conversationId: Id; forEveryone: boolean }
  | { t: 'message.read'; conversationId: Id; userId: Id; messageId: Snowflake }
  | { t: 'message.sent'; clientMessageId: string; message: Message }
  | { t: 'reaction.updated'; messageId: Snowflake; reactions: Reaction[] }
  | { t: 'typing'; conversationId: Id; userId: Id; isTyping: boolean }
  | { t: 'presence'; events: PresenceEvent[] }
  | { t: 'conversation.updated'; conversation: ConversationView }
  | { t: 'conversation.member_joined'; conversationId: Id; member: PublicProfile }
  | { t: 'conversation.member_left'; conversationId: Id; userId: Id }
  | { t: 'upload.granted'; grant: UploadGrant }
  | { t: 'upload.progress'; uploadId: Id; stage: UploadStage; progress: number }
  | { t: 'upload.ready'; uploadId: Id; attachment: Attachment }
  | { t: 'notification'; notification: AppNotification }
  | { t: 'admin.event'; event: AdminEvent }
  | CallSignal;

export interface AppNotification {
  id: Id;
  kind: 'message' | 'mention' | 'call' | 'system' | 'security' | 'moderation';
  title: string;
  body: string;
  conversationId: Id | null;
  messageId: Snowflake | null;
  createdAt: number;
  read: boolean;
  /** Whether the raw push payload may contain message text (respects preview settings). */
  pushable: boolean;
}

export interface AdminEvent {
  id: Id;
  actorId: Id | null;
  actorRole: Role | null;
  action: string;
  target: { type: string; id: string } | null;
  reason: string | null;
  severity: 'info' | 'notice' | 'warning' | 'critical';
  createdAt: number;
  meta: Record<string, unknown>;
}

/* ─────────────────────────── Feature flags ─────────────────────────── */

export interface FeatureFlags {
  mediaPipeline: boolean;
  allowedMediaTypes: MediaType[];
  maxUploadMb: number;
  calls: boolean;
  allowedCallKinds: CallKind[];
  maxCallParticipants: number;
  stories: boolean;
  e2ee: boolean;
  registrationMethods: LoginMethod[];
  maxGroupSize: number;
  maintenance: boolean;
}

/* ─────────────────────────── Moderation ─────────────────────────── */

export const REPORT_REASONS = [
  'spam', 'harassment', 'hate_speech', 'nudity', 'violence',
  'self_harm', 'csae', 'scam', 'impersonation', 'malware', 'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface Report {
  id: Id;
  reporterId: Id;
  targetType: 'user' | 'message' | 'conversation' | 'attachment';
  targetId: string;
  reason: ReportReason;
  details: string | null;
  status: 'open' | 'reviewing' | 'actioned' | 'dismissed';
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: Id | null;
  resolution: string | null;
}

/* ─────────────────────────── API envelopes ─────────────────────────── */

export interface ApiError {
  error: { code: string; message: string; details?: unknown; ref?: string };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}
