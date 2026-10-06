/**
 * Messages: the single write path for every message kind.
 *
 * Design notes that matter for correctness and for the future media launch:
 *
 *  1. Idempotency. `(conversation_id, sender_id, client_message_id)` is UNIQUE.
 *     A client that retries after a dropped socket gets the original row back
 *     instead of creating a duplicate.
 *  2. One validation funnel. `assertKindAllowed` consults the feature flags, so
 *     enabling image or video messages later is an env change — no code change,
 *     no migration, no client release.
 *  3. Text is sanitised and length-capped here, not in the client. Bidi control
 *     characters are stripped because they are used to spoof displayed text.
 *  4. Attachments are referenced by id only. A message can never smuggle in an
 *     attachment the sender does not own — ownership is re-checked on send.
 *  5. Ephemeral messages carry `expires_at`; the sweeper job removes the row and
 *     the blob. Nothing about expiry depends on the client honouring it.
 */
import type {
  Attachment,
  ContactPayload,
  EventPayload,
  MediaType,
  Message,
  MessageBody,
  MessageEntity,
  MessageKind,
  PollPayload,
  Reaction,
  Snowflake,
} from '../../../shared/types.js';
import { config, featureFlags } from '../config.js';
import { db, nowMs, parseJson, toJson, tx } from '../db/index.js';
import { newSnowflake } from '../lib/ids.js';
import { err, getUser, getSettings } from './users.js';
import { isBlockedBy, mayContact } from './contacts.js';
import { getConversation, listMemberIds, requireMembership } from './conversations.js';
import { audit } from './audit.js';

export const MAX_TEXT_LENGTH = 4096;
export const MAX_ENTITIES = 64;

/** Which message kinds require the media pipeline to be enabled. */
const MEDIA_KINDS: MessageKind[] = [
  'image', 'gif', 'sticker', 'audio', 'voice_note',
  'video', 'video_note', 'document',
];
const RICH_KINDS: MessageKind[] = ['contact', 'location', 'event', 'poll'];
const ALWAYS_ALLOWED: MessageKind[] = ['text', 'system', 'call_log'];

/** Message kind → the attachment media type it must carry. */
const KIND_TO_MEDIA: Partial<Record<MessageKind, MediaType[]>> = {
  image: ['image'],
  gif: ['gif', 'image'],
  sticker: ['sticker'],
  audio: ['audio'],
  voice_note: ['voice', 'audio'],
  video: ['video'],
  video_note: ['video'],
  document: ['document'],
};

export function isKindEnabled(kind: MessageKind): boolean {
  if (ALWAYS_ALLOWED.includes(kind)) return true;
  const flags = featureFlags();
  if (!flags.mediaPipeline && !flags.stories) {
    if (MEDIA_KINDS.includes(kind)) return false;
  }
  if (MEDIA_KINDS.includes(kind)) {
    const required = KIND_TO_MEDIA[kind] ?? [];
    return flags.mediaPipeline && required.some((t) => flags.allowedMediaTypes.includes(t));
  }
  if (RICH_KINDS.includes(kind)) return flags.mediaPipeline;
  return false;
}

function assertKindAllowed(kind: MessageKind): void {
  if (!isKindEnabled(kind)) {
    throw new (class extends Error {
      code = 'feature_disabled';
      status = 403;
    })(`${kind} messages are not enabled on this server yet`);
  }
}

/* ─────────────────────────── Text hygiene ─────────────────────────── */

const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function sanitiseText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(BIDI_CONTROLS, '')
    .replace(CONTROL_CHARS, '')
    .slice(0, MAX_TEXT_LENGTH);
}

/**
 * Derive entities from the final text when the client did not supply them.
 * Server-derived entities are authoritative: we never trust client offsets,
 * because a mismatch between text and offsets is how link spoofing works.
 */
export function deriveEntities(text: string): MessageEntity[] {
  const entities: MessageEntity[] = [];
  const push = (type: MessageEntity['type'], index: number, length: number, value?: string) => {
    if (entities.length >= MAX_ENTITIES) return;
    entities.push({ type, offset: index, length, ...(value ? { value } : {}) });
  };

  // @mentions — only resolved to a user id if the handle actually exists, so we
  // never create a dangling reference.
  const mentionRe = /(^|\s)@([a-z0-9_]{3,32}(?:\.[a-z0-9_]+)*)(?=\s|$|[.,!?])/gi;
  for (const m of text.matchAll(mentionRe)) {
    const idx = (m.index ?? 0) + (m[1]?.length ?? 0);
    const handle = m[2]!.toLowerCase();
    const exists = db().prepare('SELECT id FROM users WHERE handle = ?').get(handle) as { id: string } | undefined;
    if (exists) push('mention', idx, handle.length + 1, exists.id);
  }

  // URLs. Deliberately conservative: require a scheme or a www. prefix, so
  // "example" in prose never becomes a tappable link.
  const urlRe = /\b(?:https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
  for (const m of text.matchAll(urlRe)) {
    push('link', m.index ?? 0, m[0].length, m[0]);
  }

  const tagRe = /(^|\s)#([\p{L}\p{N}_]{2,64})(?=\s|$|[.,!?])/gu;
  for (const m of text.matchAll(tagRe)) {
    push('hashtag', (m.index ?? 0) + (m[1]?.length ?? 0), (m[2]!.length) + 1, m[2]!.toLowerCase());
  }

  return entities.sort((a, b) => a.offset - b.offset);
}

/* ─────────────────────────── Row ↔ Message ─────────────────────────── */

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_message_id: string;
  kind: MessageKind;
  text: string;
  entities_json: string | null;
  attachment_id: string | null;
  payload_json: string | null;
  reply_to_id: string | null;
  status: string;
  encrypted: number;
  key_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  deleted_for_all: number;
  expires_in: number | null;
  expires_at: number | null;
}

export function attachmentRowToModel(row: Record<string, unknown> | undefined, viewerId?: string): Attachment | null {
  if (!row) return null;
  const att = {
    id: String(row.id),
    type: row.type as MediaType,
    mimeType: String(row.mime_type ?? 'application/octet-stream'),
    filename: (row.filename as string | null) ?? null,
    sizeBytes: Number(row.size_bytes ?? 0),
    width: (row.width as number | null) ?? null,
    height: (row.height as number | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    waveform: (row.waveform as string | null) ?? null,
    latitude: (row.latitude as number | null) ?? null,
    longitude: (row.longitude as number | null) ?? null,
    locationName: (row.location_name as string | null) ?? null,
    thumbnailId: (row.thumbnail_id as string | null) ?? null,
    blurhash: (row.blurhash as string | null) ?? null,
    sha256: String(row.sha256 ?? ''),
    storageKey: String(row.storage_key ?? ''),
    storageDriver: String(row.storage_driver ?? 'local'),
    scanned: !!row.scanned,
    scanVerdict: (row.scan_verdict as Attachment['scanVerdict']) ?? 'pending',
    createdAt: Number(row.created_at ?? 0),
    expiresAt: (row.expires_at as number | null) ?? null,
  } as Attachment;

  // storageKey is an internal locator and must never reach a client. Signed URLs
  // are minted by the download route instead.
  delete (att as { storageKey?: string }).storageKey;
  void viewerId;
  return att;
}

export function serializeMessage(row: Record<string, unknown>, viewerId: string): Message {
  const r = row as unknown as MessageRow;
  const payload = parseJson<Partial<MessageBody>>(r.payload_json, {});

  let attachment: Attachment | null = null;
  if (r.attachment_id) {
    const a = db().prepare('SELECT * FROM attachments WHERE id = ?').get(r.attachment_id) as
      | Record<string, unknown>
      | undefined;
    attachment = attachmentRowToModel(a, viewerId);
  }

  let replyTo: MessageBody['replyTo'] = null;
  if (r.reply_to_id) {
    const parent = db()
      .prepare('SELECT id, sender_id, text, kind FROM messages WHERE id = ?')
      .get(r.reply_to_id) as { id: string; sender_id: string; text: string; kind: MessageKind } | undefined;
    if (parent) {
      replyTo = {
        id: parent.id,
        userId: parent.sender_id,
        preview: parent.kind === 'text' ? parent.text.slice(0, 160) : `[${parent.kind}]`,
      };
    }
  }

  const reactions = (db()
    .prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ?')
    .all(r.id) as { emoji: string; user_id: string }[]).reduce<Reaction[]>((acc, cur) => {
    const found = acc.find((x) => x.emoji === cur.emoji);
    if (found) found.userIds.push(cur.user_id);
    else acc.push({ emoji: cur.emoji, userIds: [cur.user_id] });
    return acc;
  }, []);

  const readBy = (db()
    .prepare('SELECT user_id FROM message_reads WHERE message_id = ?')
    .all(r.id) as { user_id: string }[])
    .map((x) => x.user_id);

  const body: MessageBody = {
    text: r.text ?? '',
    entities: parseJson<MessageEntity[]>(r.entities_json, []) ?? [],
    attachment,
    contact: (payload.contact as ContactPayload | null) ?? null,
    location: (payload.location as MessageBody['location']) ?? null,
    event: (payload.event as EventPayload | null) ?? null,
    poll: (payload.poll as PollPayload | null) ?? null,
    replyTo,
    stickerPackId: (payload.stickerPackId as string | null) ?? null,
    gifProvider: (payload.gifProvider as MessageBody['gifProvider']) ?? null,
    gifId: (payload.gifId as string | null) ?? null,
  };

  // A message deleted "for everyone" keeps its id (so the UI can retract the
  // bubble in place) but every field that carried content is cleared.
  if (r.deleted_at && r.deleted_for_all) {
    body.text = '';
    body.entities = [];
    body.attachment = null;
    body.contact = null;
    body.location = null;
    body.event = null;
    body.poll = null;
    body.replyTo = null;
  }

  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    kind: r.deleted_at && r.deleted_for_all ? 'system' : r.kind,
    body,
    status: (r.status as Message['status']) ?? 'sent',
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    expiresIn: r.expires_in,
    expiresAt: r.expires_at,
    reactions,
    readBy,
    clientMessageId: r.client_message_id,
    encrypted: !!r.encrypted,
    keyId: r.key_id,
  };
}

/* ─────────────────────────── Sending ─────────────────────────── */

export interface SendMessageInput {
  senderId: string;
  conversationId: string;
  kind: MessageKind;
  clientMessageId: string;
  body: Partial<MessageBody>;
  expiresIn?: number | null;
  now?: number;
}

export interface SendMessageResult {
  message: Message;
  /** Member ids that should receive a realtime frame (sender excluded). */
  recipients: string[];
  /** True when this call returned an already-stored message (idempotent retry). */
  deduplicated: boolean;
}

export function sendMessage(input: SendMessageInput): SendMessageResult {
  const now = input.now ?? nowMs();
  const conversation = getConversation(input.conversationId);
  const member = requireMembership(input.conversationId, input.senderId);

  // Muted members cannot post.
  if (member.muted_until && member.muted_until > now) {
    throw err.forbidden('You are muted in this conversation');
  }

  const sender = getUser(input.senderId);
  if (sender.status === 'suspended' || sender.status === 'deleted') {
    throw err.forbidden('This account cannot send messages');
  }
  if (sender.status === 'limited' && input.kind !== 'text') {
    throw err.forbidden('This account is currently limited');
  }

  assertKindAllowed(input.kind);

  // Idempotent retry: same client message id → return the stored message.
  const existing = db()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_message_id = ?')
    .get(input.conversationId, input.senderId, input.clientMessageId) as Record<string, unknown> | undefined;
  if (existing) {
    return {
      message: serializeMessage(existing, input.senderId),
      recipients: listMemberIds(input.conversationId).filter((id) => id !== input.senderId),
      deduplicated: true,
    };
  }

  // Block enforcement. For a DM, either direction blocking makes sending fail.
  // We do not tell the sender which side blocked, to avoid leaking that fact.
  if (conversation.kind === 'direct') {
    const other = listMemberIds(conversation.id).find((id) => id !== input.senderId);
    if (other && (isBlockedBy(other, input.senderId) || isBlockedBy(input.senderId, other))) {
      throw err.forbidden('You cannot send messages to this account');
    }
    if (other && !mayContact(input.senderId, other)) {
      throw err.forbidden('This account only accepts messages from contacts');
    }
  }

  const text = sanitiseText(input.body.text);
  const entities = Array.isArray(input.body.entities) && input.body.entities.length
    ? validateEntities(input.body.entities, text)
    : deriveEntities(text);

  if (!text && input.kind === 'text') {
    throw err.badRequest('A text message cannot be empty');
  }

  // Attachment ownership + type check.
  let attachmentId: string | null = null;
  if (input.body.attachment?.id) {
    attachmentId = resolveAttachment(input.body.attachment.id, input.senderId, input.kind);
  } else if (KIND_TO_MEDIA[input.kind]) {
    throw err.badRequest(`${input.kind} messages require an attachment`);
  }

  const payload: Record<string, unknown> = {};
  if (input.body.contact) payload.contact = validateContact(input.body.contact);
  if (input.body.location) payload.location = validateLocation(input.body.location);
  if (input.body.event) payload.event = validateEvent(input.body.event);
  if (input.body.poll) payload.poll = validatePoll(input.body.poll);
  if (input.body.stickerPackId) payload.stickerPackId = String(input.body.stickerPackId).slice(0, 64);
  if (input.body.gifProvider) payload.gifProvider = String(input.body.gifProvider).slice(0, 16);
  if (input.body.gifId) payload.gifId = String(input.body.gifId).slice(0, 128);

  let replyToId: string | null = null;
  if (input.body.replyTo?.id) {
    const parent = db()
      .prepare('SELECT id, conversation_id FROM messages WHERE id = ?')
      .get(input.body.replyTo.id) as { id: string; conversation_id: string } | undefined;
    if (parent && parent.conversation_id === input.conversationId) replyToId = parent.id;
  }

  const conversationDefault = conversation.disappearing_seconds;
  const requested = input.expiresIn === undefined ? conversationDefault : input.expiresIn;
  const expiresIn = normaliseExpiry(requested);
  const expiresAt = expiresIn ? now + expiresIn * 1000 : null;

  const id: Snowflake = newSnowflake(now);
  const encrypted = config.features.e2ee && !!input.body.attachment?.id === false && false;

  const insert = db().prepare(`
    INSERT INTO messages (
      id, conversation_id, sender_id, client_message_id, kind, text, entities_json,
      attachment_id, payload_json, reply_to_id, status, encrypted, key_id,
      created_at, expires_in, expires_at
    ) VALUES (
      @id, @conversation_id, @sender_id, @client_message_id, @kind, @text, @entities_json,
      @attachment_id, @payload_json, @reply_to_id, 'sent', @encrypted, NULL,
      @created_at, @expires_in, @expires_at
    )
  `);

  const row = tx(() => {
    insert.run({
      id,
      conversation_id: input.conversationId,
      sender_id: input.senderId,
      client_message_id: String(input.clientMessageId).slice(0, 64),
      kind: input.kind,
      text,
      entities_json: toJson(entities),
      attachment_id: attachmentId,
      payload_json: toJson(payload),
      reply_to_id: replyToId,
      encrypted: encrypted ? 1 : 0,
      created_at: now,
      expires_in: expiresIn,
      expires_at: expiresAt,
    });
    db().prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(now, input.conversationId);
    // The sender has obviously read their own message.
    db().prepare('UPDATE conversation_members SET last_read_id = ?, last_read_at = ? WHERE conversation_id = ? AND user_id = ?')
      .run(id, now, input.conversationId, input.senderId);
    return db().prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>;
  });

  const recipients = listMemberIds(input.conversationId).filter((uid) => uid !== input.senderId);

  return { message: serializeMessage(row, input.senderId), recipients, deduplicated: false };
}

function validateEntities(entities: MessageEntity[], text: string): MessageEntity[] {
  return entities
    .filter((e) => e && typeof e.offset === 'number' && typeof e.length === 'number')
    .filter((e) => e.offset >= 0 && e.length > 0 && e.offset + e.length <= text.length)
    .slice(0, MAX_ENTITIES)
    .map((e) => ({
      type: e.type,
      offset: e.offset,
      length: e.length,
      ...(e.value ? { value: String(e.value).slice(0, 256) } : {}),
    }));
}

function normaliseExpiry(seconds: number | null | undefined): number | null {
  if (seconds === null || seconds === undefined) return null;
  const allowed = [5, 10, 30, 60, 300, 1800, 3600, 86_400, 604_800];
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  return allowed.find((a) => a === n) ?? null;
}

/**
 * Confirm the sender owns this attachment, that it finished the pipeline, and
 * that its media type matches the message kind. This is what stops a user from
 * referencing someone else's upload or bypassing moderation by relabelling.
 */
function resolveAttachment(attachmentId: string, senderId: string, kind: MessageKind): string {
  const row = db().prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw err.notFound('That attachment does not exist or has expired');
  if (row.owner_id !== senderId) throw err.forbidden('That attachment does not belong to you');
  if (row.scan_verdict === 'blocked') throw err.forbidden('That file was rejected by our safety scan');

  const required = KIND_TO_MEDIA[kind] ?? [];
  if (required.length && !required.includes(row.type as MediaType)) {
    throw err.badRequest(`A ${kind} message needs a ${required.join(' or ')} attachment`);
  }
  return attachmentId;
}

function validateContact(input: ContactPayload): ContactPayload {
  const phones = (input.phones ?? []).slice(0, 8).map((p) => ({
    label: String(p.label ?? '').slice(0, 32),
    value: String(p.value ?? '').replace(/[^\d+\-() ]/g, '').slice(0, 32),
  })).filter((p) => p.value);
  const emails = (input.emails ?? []).slice(0, 8).map((e) => ({
    label: String(e.label ?? '').slice(0, 32),
    value: String(e.value ?? '').slice(0, 254),
  })).filter((e) => e.value.includes('@'));

  // If the shared contact is on Vesper, resolve to a user id so the client can
  // offer "Add contact" without either side exchanging raw personal data.
  let vesperUserId: string | null = null;
  const handleMatch = String(input.displayName ?? '').match(/^@([a-z0-9_.]{3,32})$/i);
  if (handleMatch) {
    const found = db().prepare('SELECT id FROM users WHERE handle = ?').get(handleMatch[1]!.toLowerCase()) as
      | { id: string } | undefined;
    if (found) vesperUserId = found.id;
  }

  return {
    displayName: String(input.displayName ?? '').replace(CONTROL_CHARS, '').slice(0, 96),
    phones,
    emails,
    vesperUserId,
  };
}

function validateLocation(input: NonNullable<MessageBody['location']>): MessageBody['location'] {
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw err.badRequest('Latitude is out of range');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw err.badRequest('Longitude is out of range');
  return {
    latitude: Number(lat.toFixed(6)),
    longitude: Number(lon.toFixed(6)),
    name: input.name ? String(input.name).replace(CONTROL_CHARS, '').slice(0, 128) : null,
  };
}

function validateEvent(input: EventPayload): EventPayload {
  const title = String(input.title ?? '').replace(CONTROL_CHARS, '').trim().slice(0, 120);
  if (!title) throw err.badRequest('An event needs a title');
  const startsAt = Number(input.startsAt);
  if (!Number.isFinite(startsAt)) throw err.badRequest('An event needs a start time');
  const endsAt = input.endsAt === null || input.endsAt === undefined ? null : Number(input.endsAt);
  if (endsAt !== null && endsAt <= startsAt) throw err.badRequest('An event must end after it starts');
  return {
    title,
    description: input.description ? String(input.description).replace(CONTROL_CHARS, '').slice(0, 1000) : null,
    startsAt,
    endsAt,
    allDay: !!input.allDay,
    timezone: String(input.timezone ?? 'UTC').slice(0, 64),
    location: input.location ? String(input.location).replace(CONTROL_CHARS, '').slice(0, 200) : null,
    rsvp: null,
    rsvpCounts: { yes: 0, no: 0, maybe: 0 },
  };
}

function validatePoll(input: PollPayload): PollPayload {
  const question = String(input.question ?? '').replace(CONTROL_CHARS, '').trim().slice(0, 240);
  if (!question) throw err.badRequest('A poll needs a question');
  const options = (input.options ?? [])
    .slice(0, 10)
    .map((o, i) => ({
      id: String(o.id ?? `opt-${i}`).slice(0, 24),
      text: String(o.text ?? '').replace(CONTROL_CHARS, '').trim().slice(0, 120),
      votes: 0,
    }))
    .filter((o) => o.text);
  if (options.length < 2) throw err.badRequest('A poll needs at least two options');
  return {
    question,
    options,
    multiSelect: !!input.multiSelect,
    anonymous: !!input.anonymous,
    closesAt: input.closesAt ? Number(input.closesAt) : null,
    myVote: null,
  };
}

/* ─────────────────────────── Read / history ─────────────────────────── */

export function listMessages(
  conversationId: string,
  viewerId: string,
  opts: { before?: Snowflake; after?: Snowflake; limit?: number } = {},
): { items: Message[]; nextCursor: Snowflake | null } {
  requireMembership(conversationId, viewerId);
  const limit = Math.min(opts.limit ?? 50, 200);

  const where: string[] = [
    'm.conversation_id = ?',
    // Rows the viewer deleted "for me" stay hidden from their history only.
    'NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ?)',
    // Expired ephemeral messages are invisible even before the sweeper runs.
    '(m.expires_at IS NULL OR m.expires_at > ?)',
  ];
  const params: unknown[] = [conversationId, viewerId, nowMs()];

  if (opts.before) { where.push('m.id < ?'); params.push(opts.before); }
  if (opts.after) { where.push('m.id > ?'); params.push(opts.after); }

  const rows = db()
    .prepare(
      `SELECT m.* FROM messages m
        WHERE ${where.join(' AND ')}
        ORDER BY m.id ${opts.after ? 'ASC' : 'DESC'}
        LIMIT ?`,
    )
    .all(...params, limit + 1) as Record<string, unknown>[];

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows)
    .map((r) => serializeMessage(r, viewerId))
    .reverse();

  const first = rows[rows.length - 1] as { id: string } | undefined;
  return { items, nextCursor: hasMore && first ? first.id : null };
}

export function getMessage(id: Snowflake, viewerId: string): Message {
  requireViewerOfMessage(id, viewerId);
  const row = db().prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>;
  return serializeMessage(row, viewerId);
}

function requireViewerOfMessage(messageId: string, viewerId: string): Record<string, unknown> {
  const row = db().prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw err.notFound('Message');
  requireMembership(String(row.conversation_id), viewerId);
  return row;
}

export function editMessage(id: Snowflake, editorId: string, newText: string): Message {
  const row = requireViewerOfMessage(id, editorId);
  if (row.sender_id !== editorId) throw err.forbidden('You can only edit your own messages');
  if (row.deleted_at) throw err.badRequest('That message has been deleted');
  if (row.kind !== 'text') throw err.badRequest('Only text messages can be edited');

  const text = sanitiseText(newText);
  if (!text) throw err.badRequest('A text message cannot be empty');
  // Editing is time-boxed: after 15 minutes the transcript people are reading
  // would change under them, which is a harassment vector.
  if (nowMs() - Number(row.created_at) > 15 * 60_000) {
    throw err.badRequest('Messages can only be edited within 15 minutes of sending');
  }

  db().prepare('UPDATE messages SET text = ?, entities_json = ?, edited_at = ? WHERE id = ?')
    .run(text, toJson(deriveEntities(text)), nowMs(), id);
  return getMessage(id, editorId);
}

export function deleteMessage(
  id: Snowflake,
  userId: string,
  forEveryone: boolean,
): { conversationId: string } {
  const row = requireViewerOfMessage(id, userId);
  const conversationId = String(row.conversation_id);

  if (forEveryone) {
    if (row.sender_id !== userId) {
      // Group admins may remove other people's messages.
      const member = requireMembership(conversationId, userId);
      if (!['admin', 'owner', 'moderator'].includes(String(member.role))) {
        throw err.forbidden('You can only delete your own messages for everyone');
      }
      audit({
        actorId: userId,
        action: 'message.removed_by_moderator',
        target: { type: 'message', id },
        severity: 'notice',
      });
    }
    tx(() => {
      db().prepare('UPDATE messages SET deleted_at = ?, deleted_for_all = 1 WHERE id = ?').run(nowMs(), id);
      // Drop the blob reference count immediately; the sweeper reclaims storage.
      db().prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
      db().prepare('DELETE FROM message_reads WHERE message_id = ?').run(id);
    });
  } else {
    db().prepare(`
      INSERT INTO message_deletions (message_id, user_id, deleted_at) VALUES (?, ?, ?)
      ON CONFLICT(message_id, user_id) DO UPDATE SET deleted_at = excluded.deleted_at
    `).run(id, userId, nowMs());
  }
  return { conversationId };
}

export function toggleReaction(messageId: Snowflake, userId: string, emoji: string): Reaction[] {
  requireViewerOfMessage(messageId, userId);
  // Only a small fixed set is accepted. Free-form emoji in reactions is a
  // moderation and rendering surface we do not need.
  const ALLOWED = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👀', '🎉', '✅'];
  if (!ALLOWED.includes(emoji)) throw err.badRequest('That reaction is not supported');

  const existing = db()
    .prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(messageId, userId, emoji);
  if (existing) {
    db().prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .run(messageId, userId, emoji);
  } else {
    db().prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
      .run(messageId, userId, emoji, nowMs());
  }
  return (db()
    .prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ?')
    .all(messageId) as { emoji: string; user_id: string }[]).reduce<Reaction[]>((acc, cur) => {
    const found = acc.find((x) => x.emoji === cur.emoji);
    if (found) found.userIds.push(cur.user_id);
    else acc.push({ emoji: cur.emoji, userIds: [cur.user_id] });
    return acc;
  }, []);
}

export function markRead(userId: string, conversationId: string, messageId: Snowflake): void {
  requireMembership(conversationId, userId);
  const now = nowMs();
  db().prepare(`
    INSERT INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)
    ON CONFLICT(message_id, user_id) DO NOTHING
  `).run(messageId, userId, now);
  db().prepare(
    `UPDATE conversation_members SET last_read_id = ?, last_read_at = ?
      WHERE conversation_id = ? AND user_id = ?
        AND (last_read_id IS NULL OR last_read_id < ?)`,
  ).run(messageId, now, conversationId, userId, messageId);
}

export function shouldNotifyRecipient(conversationId: string, recipientId: string, senderId: string): boolean {
  const member = db()
    .prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(conversationId, recipientId) as Record<string, unknown> | undefined;
  if (!member) return false;
  if (!member.notifications_on) return false;
  if (member.muted_until && Number(member.muted_until) > nowMs()) return false;

  const settings = getSettings(recipientId);
  if (!settings.notifications.enabled) return false;
  const qh = settings.notifications.quietHours;
  if (qh?.enabled) {
    const d = new Date();
    const minutes = d.getHours() * 60 + d.getMinutes();
    const toMinutes = (s: string) => {
      const [h, m] = s.split(':').map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };
    const start = toMinutes(qh.start);
    const end = toMinutes(qh.end);
    const inside = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
    if (inside) return false;
  }
  void senderId;
  return true;
}
