/**
 * Persistence layer.
 *
 * SQLite (better-sqlite3) in WAL mode. Chosen deliberately:
 *   - synchronous API, so request handlers stay simple and there is no
 *     connection-pool exhaustion under WebSocket fan-out;
 *   - a single file, which makes backup/restore and GDPR erasure auditable;
 *   - trivially embeddable for local-first / offline desktop mode later.
 *
 * Everything goes through `db.prepare(...)` with bound parameters — no string
 * interpolation anywhere, so SQL injection is structurally impossible.
 *
 * To move to Postgres later, replace this module: the repository layer in
 * `services/` is the only caller, and it uses no SQLite-specific syntax beyond
 * `INSERT OR REPLACE` (mapped to upsert) and JSON columns (stored as TEXT).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';

export type DB = Database.Database;

let instance: DB | null = null;

export function db(): DB {
  if (instance) return instance;
  const file = config.db.file;
  mkdirSync(dirname(resolve(file)), { recursive: true });
  instance = new Database(file);
  instance.pragma('journal_mode = WAL');
  instance.pragma('synchronous = NORMAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma(`busy_timeout = ${config.db.busyTimeoutMs}`);
  // Encrypted-at-rest is handled below the filesystem (LUKS/EBS) in production;
  // see docs/SECURITY.md §"Data at rest".
  migrate(instance);
  return instance;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Run a unit of work atomically. */
export function tx<T>(fn: () => T): T {
  const d = db();
  const begin = d.transaction(fn);
  return begin();
}

/* ─────────────────────────── Schema ─────────────────────────── */

/**
 * Migrations are append-only and idempotent. Never edit an existing entry once
 * released — add a new one. `schema_migrations` records what has been applied.
 */
const MIGRATIONS: { version: number; name: string; sql: string[] }[] = [
  {
    version: 1,
    name: 'core_identity_and_messaging',
    sql: [
      /* ── Accounts ──────────────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS users (
        id                 TEXT PRIMARY KEY,
        handle             TEXT NOT NULL UNIQUE,
        display_name       TEXT,
        bio                TEXT,
        avatar_seed        TEXT NOT NULL,
        avatar_hue         INTEGER NOT NULL DEFAULT 0,
        avatar_attachment  TEXT,
        password_hash      TEXT,
        role               TEXT NOT NULL DEFAULT 'user',
        status             TEXT NOT NULL DEFAULT 'active',
        verified           INTEGER NOT NULL DEFAULT 0,
        two_factor_secret  TEXT,
        two_factor_enabled INTEGER NOT NULL DEFAULT 0,
        settings_json      TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        last_seen_at       INTEGER,
        deactivated_at     INTEGER,
        delete_after       INTEGER,
        suspension_until   INTEGER,
        trust_score        INTEGER NOT NULL DEFAULT 100
      )`,
      `CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`,
      `CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`,
      `CREATE INDEX IF NOT EXISTS idx_users_delete_after ON users(delete_after) WHERE delete_after IS NOT NULL`,

      /* Optional recovery identifiers. Encrypted at rest, looked up by keyed hash
         so we never need to decrypt to authenticate. */
      `CREATE TABLE IF NOT EXISTS identities (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        method         TEXT NOT NULL,
        identifier_hash TEXT NOT NULL,
        encrypted_value TEXT,
        fingerprint    TEXT NOT NULL,
        verified       INTEGER NOT NULL DEFAULT 0,
        is_primary     INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        last_used_at   INTEGER,
        UNIQUE(method, identifier_hash)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_identities_lookup ON identities(method, identifier_hash)`,

      /* Federated identity subjects (Google `sub`, Apple `sub`). Immutable and
         never stores the email unless the user explicitly links it. */
      `CREATE TABLE IF NOT EXISTS oauth_identities (
        provider      TEXT NOT NULL,
        subject       TEXT NOT NULL,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email_hash    TEXT,
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER,
        PRIMARY KEY (provider, subject)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_identities(user_id)`,

      /* ── Devices & sessions ─────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS devices (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform      TEXT NOT NULL,
        app_version   TEXT NOT NULL,
        os_version    TEXT,
        model         TEXT,
        push_token    TEXT,
        push_provider TEXT NOT NULL DEFAULT 'none',
        identity_key  TEXT,
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        UNIQUE(user_id, id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)`,

      `CREATE TABLE IF NOT EXISTS sessions (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id      TEXT,
        token_hash     TEXT NOT NULL UNIQUE,
        ip_hash        TEXT,
        country        TEXT,
        user_agent     TEXT,
        created_at     INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        revoked_at     INTEGER,
        revoke_reason  TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,

      `CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        family      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        used_at     INTEGER,
        replaced_by TEXT,
        revoked_at  INTEGER
      )`,
      /* Reuse of a rotated refresh token is a theft signal — see services/auth.ts */
      `CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family)`,

      /* ── Step-up challenges (OTP, magic link, 2FA) ──────────────── */
      `CREATE TABLE IF NOT EXISTS challenges (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        channel      TEXT,
        target_hash  TEXT,
        user_id      TEXT,
        code_hash    TEXT,
        token_hash   TEXT,
        attempts     INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        consumed_at  INTEGER,
        last_sent_at INTEGER,
        context_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_challenges_expiry ON challenges(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_challenges_target ON challenges(kind, target_hash)`,

      /* ── Contacts ───────────────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS contacts (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        contact_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status         TEXT NOT NULL DEFAULT 'pending',
        alias          TEXT,
        created_at     INTEGER NOT NULL,
        accepted_at    INTEGER,
        UNIQUE(user_id, contact_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id, status)`,

      `CREATE TABLE IF NOT EXISTS blocks (
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason      TEXT,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (user_id, blocked_id)
      )`,

      /* ── Conversations ──────────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS conversations (
        id                  TEXT PRIMARY KEY,
        kind                TEXT NOT NULL,
        title               TEXT,
        avatar_seed         TEXT,
        avatar_hue          INTEGER,
        avatar_attachment   TEXT,
        created_by          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at          INTEGER NOT NULL,
        last_message_at     INTEGER,
        disappearing_seconds INTEGER,
        is_verified         INTEGER NOT NULL DEFAULT 0,
        member_count        INTEGER NOT NULL DEFAULT 0,
        state               TEXT NOT NULL DEFAULT 'active'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_last ON conversations(last_message_at DESC)`,

      `CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role              TEXT NOT NULL DEFAULT 'member',
        joined_at         INTEGER NOT NULL,
        left_at           INTEGER,
        muted_until       INTEGER,
        last_read_id      TEXT,
        last_read_at      INTEGER NOT NULL DEFAULT 0,
        notifications_on  INTEGER NOT NULL DEFAULT 1,
        pinned            INTEGER NOT NULL DEFAULT 0,
        archived          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id, archived, pinned)`,

      /* Direct-message lookup: a canonical pair key prevents duplicate DM rows. */
      `CREATE TABLE IF NOT EXISTS direct_conversations (
        pair_key        TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE
      )`,

      /* ── Messages ───────────────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS messages (
        id                TEXT PRIMARY KEY,
        conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_message_id TEXT NOT NULL,
        kind              TEXT NOT NULL DEFAULT 'text',
        text              TEXT NOT NULL DEFAULT '',
        entities_json     TEXT,
        attachment_id     TEXT,
        payload_json      TEXT,
        reply_to_id       TEXT,
        status            TEXT NOT NULL DEFAULT 'sent',
        encrypted         INTEGER NOT NULL DEFAULT 0,
        key_id            TEXT,
        created_at        INTEGER NOT NULL,
        edited_at         INTEGER,
        deleted_at        INTEGER,
        deleted_for_all   INTEGER NOT NULL DEFAULT 0,
        expires_in        INTEGER,
        expires_at        INTEGER,
        UNIQUE(conversation_id, sender_id, client_message_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL`,

      `CREATE TABLE IF NOT EXISTS message_reads (
        message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at         INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id)
      )`,

      `CREATE TABLE IF NOT EXISTS reactions (
        message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      )`,

      /* Per-user deletion ("delete for me") without touching the message row. */
      `CREATE TABLE IF NOT EXISTS message_deletions (
        message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        deleted_at  INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id)
      )`,

      /* ── Media pipeline ─────────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS uploads (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT,
        type          TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        filename      TEXT,
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        declared_bytes INTEGER NOT NULL,
        chunk_size    INTEGER NOT NULL,
        total_chunks  INTEGER,
        received_chunks INTEGER NOT NULL DEFAULT 0,
        mode          TEXT NOT NULL DEFAULT 'api',
        stage         TEXT NOT NULL DEFAULT 'requested',
        storage_key   TEXT,
        storage_driver TEXT,
        sha256        TEXT,
        grant_json    TEXT,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_uploads_expiry ON uploads(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, stage)`,

      `CREATE TABLE IF NOT EXISTS attachments (
        id            TEXT PRIMARY KEY,
        upload_id     TEXT REFERENCES uploads(id) ON DELETE SET NULL,
        owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type          TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        filename      TEXT,
        size_bytes    INTEGER NOT NULL,
        width         INTEGER,
        height        INTEGER,
        duration_ms   INTEGER,
        waveform      TEXT,
        latitude      REAL,
        longitude     REAL,
        location_name TEXT,
        thumbnail_id  TEXT,
        blurhash      TEXT,
        sha256        TEXT NOT NULL,
        phash         TEXT,
        storage_key   TEXT NOT NULL,
        storage_driver TEXT NOT NULL,
        scanned       INTEGER NOT NULL DEFAULT 0,
        scan_verdict  TEXT NOT NULL DEFAULT 'pending',
        metadata_stripped INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256)`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_expiry ON attachments(expires_at) WHERE expires_at IS NOT NULL`,

      /* Sticker packs. Shipped packs have owner_id NULL. */
      `CREATE TABLE IF NOT EXISTS sticker_packs (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        is_public   INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS stickers (
        id          TEXT PRIMARY KEY,
        pack_id     TEXT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        emoji       TEXT,
        keywords    TEXT,
        position    INTEGER NOT NULL DEFAULT 0
      )`,

      /* ── Media jobs (transcode, thumbnail, scan) ────────────────── */
      `CREATE TABLE IF NOT EXISTS media_jobs (
        id            TEXT PRIMARY KEY,
        upload_id     TEXT,
        attachment_id TEXT,
        kind          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'queued',
        progress      REAL NOT NULL DEFAULT 0,
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 3,
        payload_json  TEXT,
        result_json   TEXT,
        error         TEXT,
        available_at  INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_queue ON media_jobs(status, available_at)`,

      /* ── Calls ──────────────────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS calls (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        created_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL,
        topology        TEXT NOT NULL DEFAULT 'mesh',
        state           TEXT NOT NULL DEFAULT 'ringing',
        started_at      INTEGER NOT NULL,
        answered_at     INTEGER,
        ended_at        INTEGER,
        end_reason      TEXT,
        join_token_hash TEXT,
        join_url        TEXT,
        media_server    TEXT,
        media_room_id   TEXT,
        ice_json        TEXT,
        max_participants INTEGER NOT NULL DEFAULT 8,
        recording_on    INTEGER NOT NULL DEFAULT 0,
        scheduled_for   INTEGER,
        duration_seconds INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_calls_conv ON calls(conversation_id, started_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_calls_active ON calls(state) WHERE ended_at IS NULL`,

      `CREATE TABLE IF NOT EXISTS call_participants (
        call_id      TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id    TEXT,
        state        TEXT NOT NULL DEFAULT 'invited',
        invited_at   INTEGER NOT NULL,
        joined_at    INTEGER,
        left_at      INTEGER,
        audio_muted  INTEGER NOT NULL DEFAULT 0,
        video_muted  INTEGER NOT NULL DEFAULT 1,
        capabilities_json TEXT,
        PRIMARY KEY (call_id, user_id, device_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_call_parts_user ON call_participants(user_id, state)`,

      /* ── Stories / ephemeral posts (scaffolded) ─────────────────── */
      `CREATE TABLE IF NOT EXISTS stories (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        attachment_id TEXT REFERENCES attachments(id) ON DELETE CASCADE,
        caption       TEXT,
        visibility    TEXT NOT NULL DEFAULT 'contacts',
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        reply_count   INTEGER NOT NULL DEFAULT 0,
        view_count    INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_stories_active ON stories(user_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS story_views (
        story_id  TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        viewed_at INTEGER NOT NULL,
        PRIMARY KEY (story_id, user_id)
      )`,

      /* ── Moderation ─────────────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS reports (
        id          TEXT PRIMARY KEY,
        reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        reason      TEXT NOT NULL,
        details     TEXT,
        status      TEXT NOT NULL DEFAULT 'open',
        priority    INTEGER NOT NULL DEFAULT 50,
        snapshot_json TEXT,
        created_at  INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by TEXT,
        resolution  TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_reports_open ON reports(status, priority DESC, created_at DESC)`,

      `CREATE TABLE IF NOT EXISTS moderation_actions (
        id          TEXT PRIMARY KEY,
        actor_id    TEXT,
        target_type TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        action      TEXT NOT NULL,
        reason      TEXT,
        expires_at  INTEGER,
        created_at  INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mod_target ON moderation_actions(target_type, target_id)`,

      /* Known-abuse hashes. Matching is on SHA-256 and perceptual hash. */
      `CREATE TABLE IF NOT EXISTS hash_blocklist (
        hash        TEXT PRIMARY KEY,
        hash_type   TEXT NOT NULL,
        category    TEXT NOT NULL,
        severity    TEXT NOT NULL DEFAULT 'block',
        source      TEXT,
        created_at  INTEGER NOT NULL
      )`,

      /* ── Notifications ──────────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS notifications (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL,
        conversation_id TEXT,
        message_id      TEXT,
        data_json       TEXT,
        read_at         INTEGER,
        pushed_at       INTEGER,
        created_at      INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)`,

      /* ── Admin / operations ─────────────────────────────────────── */
      `CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id    TEXT,
        actor_role  TEXT,
        action      TEXT NOT NULL,
        target_type TEXT,
        target_id   TEXT,
        reason      TEXT,
        severity    TEXT NOT NULL DEFAULT 'info',
        ip_hash     TEXT,
        meta_json   TEXT,
        created_at  INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id)`,

      `CREATE TABLE IF NOT EXISTS feature_flags (
        key         TEXT PRIMARY KEY,
        value_json  TEXT NOT NULL,
        updated_by  TEXT,
        updated_at  INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS broadcasts (
        id          TEXT PRIMARY KEY,
        author_id   TEXT,
        audience    TEXT NOT NULL DEFAULT 'all',
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        severity    TEXT NOT NULL DEFAULT 'info',
        action_url  TEXT,
        starts_at   INTEGER NOT NULL,
        expires_at  INTEGER,
        created_at  INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS settings_kv (
        key         TEXT PRIMARY KEY,
        value_json  TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS rate_limit_state (
        bucket      TEXT PRIMARY KEY,
        count       INTEGER NOT NULL DEFAULT 0,
        reset_at    INTEGER NOT NULL
      )`,

      /* Login anomaly detection: repeated failures trip a lockout. */
      `CREATE TABLE IF NOT EXISTS auth_attempts (
        key         TEXT PRIMARY KEY,
        failures    INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        updated_at  INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  INTEGER NOT NULL
      )`,
    ],
  },

  /* ─────────────────────────────────────────────────────────────────────
     v2 — realtime presence, offline delivery queue, and password-rotation
     state. Appended rather than folded into v1 because migrations are
     append-only: an existing install must reach the same schema by running
     v2, not by re-running a v1 that has silently changed shape.

     `deliveries` is what makes a message survive a dropped socket. Frames that
     could not be written to a live connection are parked here and replayed on
     reconnect, so a mobile network handover loses nothing.

     `user_presence` is separate from `users.presence` on purpose: the users
     column is the denormalised value everyone reads, while this row carries the
     timestamp and is written on every connect/disconnect. Keeping the hot write
     path off the wide `users` row avoids rewriting a large record (and its
     settings JSON) on each socket event.
     ───────────────────────────────────────────────────────────────────── */
  {
    version: 2,
    name: 'presence_delivery_and_password_rotation',
    sql: [
      `ALTER TABLE users ADD COLUMN presence TEXT NOT NULL DEFAULT 'offline'`,
      `ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`,

      `CREATE TABLE IF NOT EXISTS user_presence (
        user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        state        TEXT NOT NULL DEFAULT 'offline',
        last_seen_at INTEGER,
        updated_at   INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS deliveries (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      )`,
      // Oldest-first replay per user, and the retention sweep both filter on
      // (user_id, created_at), so one composite index serves both.
      `CREATE INDEX IF NOT EXISTS idx_deliveries_user_created ON deliveries(user_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_deliveries_created ON deliveries(created_at)`,

      `CREATE INDEX IF NOT EXISTS idx_users_presence ON users(presence) WHERE presence = 'online'`,
    ],
  },
];

function migrate(d: DB): void {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    (d.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const run = d.transaction(() => {
      for (const stmt of m.sql) d.exec(stmt);
      d.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
    run();
  }
  // Integrity + performance housekeeping on boot.
  d.pragma('optimize');
}

/** Convenience: JSON column encode/decode with a fallback so a bad row can never crash a list. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function nowMs(): number {
  return Date.now();
}
