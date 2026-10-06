/**
 * Contacts and blocking.
 *
 * Vesper has no phone-book upload and no "friends who are also on Vesper"
 * scanning — that would be a direct anonymity violation. Contacts are added by
 * handle or by scanning a QR/invite link, and every add is a two-sided request
 * unless the recipient's privacy setting allows direct messages from everyone.
 */
import type { Contact, ContactStatus, PublicProfile } from '../../../shared/types.js';
import { db, nowMs } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { AppError, err, findByHandle, getUser, toPublicProfile } from './users.js';
import { audit } from './audit.js';

interface ContactRow {
  id: string;
  user_id: string;
  contact_id: string;
  status: ContactStatus;
  alias: string | null;
  created_at: number;
  accepted_at: number | null;
}

function hydrate(row: ContactRow, viewerId: string): Contact {
  const target = getUser(row.contact_id);
  const profile: PublicProfile = toPublicProfile(target, viewerId);
  return {
    id: row.id,
    userId: row.user_id,
    contactUserId: row.contact_id,
    status: row.status,
    alias: row.alias,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    profile,
  };
}

export function isContact(a: string, b: string): boolean {
  return !!db()
    .prepare("SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ? AND status = 'accepted'")
    .get(a, b);
}

export function isBlockedBy(blockerId: string, blockedId: string): boolean {
  return !!db()
    .prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?')
    .get(blockerId, blockedId);
}

/** True when `from` is allowed to open a conversation with `to`. */
export function mayContact(fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  if (isBlockedBy(toId, fromId)) return false;
  const row = db().prepare('SELECT settings_json FROM users WHERE id = ?').get(toId) as
    | { settings_json: string }
    | undefined;
  if (!row) return false;
  const rule = readWhoCanMessageMe(row.settings_json);
  if (rule === 'nobody') return false;
  if (rule === 'everyone') return true;
  return isContact(toId, fromId);
}

export function listContacts(userId: string, status?: ContactStatus): Contact[] {
  const params: unknown[] = [userId];
  let sql = 'SELECT * FROM contacts WHERE user_id = ?';
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY accepted_at DESC, created_at DESC';
  const rows = db().prepare(sql).all(...params) as ContactRow[];
  return rows
    .map((r) => {
      try {
        return hydrate(r, userId);
      } catch (e) {
        // A contact whose account was hard-deleted should not break the list.
        if (e instanceof AppError && e.code === 'not_found') return null;
        throw e;
      }
    })
    .filter((c): c is Contact => c !== null);
}

export function pendingRequests(userId: string): Contact[] {
  // Requests sent TO me that I have not answered.
  const rows = db()
    .prepare("SELECT * FROM contacts WHERE contact_id = ? AND status = 'pending' ORDER BY created_at DESC")
    .all(userId) as ContactRow[];
  return rows
    .map((r) => {
      const from = getUser(r.user_id);
      return {
        id: r.id,
        userId: r.user_id,
        contactUserId: r.contact_id,
        status: r.status,
        alias: r.alias,
        createdAt: r.created_at,
        acceptedAt: r.accepted_at,
        profile: toPublicProfile(from, userId),
      };
    });
}

export interface AddContactResult {
  contact: Contact;
  /** 'mutual' when the other side already asked, so it is accepted immediately. */
  outcome: 'pending' | 'mutual' | 'already' | 'auto_accepted';
}

export function addContactByHandle(userId: string, handle: string): AddContactResult {
  const target = findByHandle(handle);
  if (!target) throw err.notFound('No account uses that handle');
  return addContact(userId, target.id);
}

export function addContact(userId: string, targetId: string): AddContactResult {
  if (userId === targetId) throw err.badRequest('You cannot add yourself');
  const target = getUser(targetId);
  if (target.status !== 'active') throw err.badRequest('That account is not available');
  if (isBlockedBy(targetId, userId)) {
    // Do not reveal the block; behave as if the handle does not exist.
    throw err.notFound('No account uses that handle');
  }
  if (isBlockedBy(userId, targetId)) {
    throw err.badRequest('Unblock this account before adding it');
  }

  const existing = db()
    .prepare('SELECT * FROM contacts WHERE user_id = ? AND contact_id = ?')
    .get(userId, targetId) as ContactRow | undefined;

  if (existing?.status === 'accepted') {
    return { contact: hydrate(existing, userId), outcome: 'already' };
  }

  const reverse = db()
    .prepare("SELECT * FROM contacts WHERE user_id = ? AND contact_id = ? AND status = 'pending'")
    .get(targetId, userId) as ContactRow | undefined;

  const now = nowMs();

  // They already asked for me → accept both directions at once.
  if (reverse) {
    db().prepare("UPDATE contacts SET status = 'accepted', accepted_at = ? WHERE id = ?").run(now, reverse.id);
    if (existing) {
      db().prepare("UPDATE contacts SET status = 'accepted', accepted_at = ? WHERE id = ?").run(now, existing.id);
    } else {
      db().prepare(`
        INSERT INTO contacts (id, user_id, contact_id, status, created_at, accepted_at)
        VALUES (?, ?, ?, 'accepted', ?, ?)
      `).run(newId(), userId, targetId, now, now);
    }
    audit({ actorId: userId, action: 'contact.mutual_accept', target: { type: 'user', id: targetId } });
    const row = db()
      .prepare('SELECT * FROM contacts WHERE user_id = ? AND contact_id = ?')
      .get(userId, targetId) as ContactRow;
    return { contact: hydrate(row, userId), outcome: 'mutual' };
  }

  if (existing) {
    db().prepare('UPDATE contacts SET created_at = ? WHERE id = ?').run(now, existing.id);
    return { contact: hydrate(existing, userId), outcome: 'pending' };
  }

  const id = newId();
  db().prepare(`
    INSERT INTO contacts (id, user_id, contact_id, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(id, userId, targetId, now);

  // If the recipient accepts messages from everyone, skip the request round-trip.
  if (mayContact(userId, targetId)) {
    db().prepare("UPDATE contacts SET status = 'accepted', accepted_at = ? WHERE id = ?").run(now, id);
    db().prepare(`
      INSERT OR IGNORE INTO contacts (id, user_id, contact_id, status, created_at, accepted_at)
      VALUES (?, ?, ?, 'accepted', ?, ?)
    `).run(newId(), targetId, userId, now, now);
    const row = db().prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;
    return { contact: hydrate(row, userId), outcome: 'auto_accepted' };
  }

  const row = db().prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;
  audit({ actorId: userId, action: 'contact.requested', target: { type: 'user', id: targetId } });
  return { contact: hydrate(row, userId), outcome: 'pending' };
}

export function respondToRequest(userId: string, requestId: string, accept: boolean): Contact {
  const row = db()
    .prepare("SELECT * FROM contacts WHERE id = ? AND contact_id = ? AND status = 'pending'")
    .get(requestId, userId) as ContactRow | undefined;
  if (!row) throw err.notFound('That request does not exist or was already answered');
  const now = nowMs();

  if (accept) {
    db().prepare("UPDATE contacts SET status = 'accepted', accepted_at = ? WHERE id = ?").run(now, row.id);
    db().prepare(`
      INSERT INTO contacts (id, user_id, contact_id, status, created_at, accepted_at)
      VALUES (?, ?, ?, 'accepted', ?, ?)
      ON CONFLICT(user_id, contact_id) DO UPDATE SET status = 'accepted', accepted_at = excluded.accepted_at
    `).run(newId(), userId, row.user_id, now, now);
  } else {
    db().prepare("UPDATE contacts SET status = 'rejected' WHERE id = ?").run(row.id);
  }

  const updated = db().prepare('SELECT * FROM contacts WHERE id = ?').get(row.id) as ContactRow;
  audit({
    actorId: userId,
    action: accept ? 'contact.accepted' : 'contact.rejected',
    target: { type: 'user', id: row.user_id },
  });
  return hydrate(updated, userId);
}

export function removeContact(userId: string, contactId: string): void {
  db().prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(userId, contactId);
  db().prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(contactId, userId);
  audit({ actorId: userId, action: 'contact.removed', target: { type: 'user', id: contactId } });
}

export function setAlias(userId: string, contactId: string, alias: string | null): Contact {
  const clean = alias?.trim().slice(0, 48) || null;
  const res = db()
    .prepare('UPDATE contacts SET alias = ? WHERE user_id = ? AND contact_id = ?')
    .run(clean, userId, contactId);
  if (!res.changes) throw err.notFound('Contact');
  const row = db()
    .prepare('SELECT * FROM contacts WHERE user_id = ? AND contact_id = ?')
    .get(userId, contactId) as ContactRow;
  return hydrate(row, userId);
}

/**
 * Blocking is one-sided and silent: the blocked account is never notified, and
 * its view of the blocker degrades to "not found" so the block is not leakable.
 */
export function blockUser(userId: string, targetId: string, reason?: string): void {
  if (userId === targetId) throw err.badRequest('You cannot block yourself');
  getUser(targetId);
  const now = nowMs();
  db().prepare(`
    INSERT INTO blocks (user_id, blocked_id, reason, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, blocked_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at
  `).run(userId, targetId, reason?.slice(0, 500) ?? null, now);
  db().prepare('DELETE FROM contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)')
    .run(userId, targetId, targetId, userId);
  audit({ actorId: userId, action: 'user.blocked', target: { type: 'user', id: targetId }, severity: 'notice' });
}

export function unblockUser(userId: string, targetId: string): void {
  const res = db().prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(userId, targetId);
  if (!res.changes) throw err.notFound('Block');
  audit({ actorId: userId, action: 'user.unblocked', target: { type: 'user', id: targetId } });
}

export function listBlocks(userId: string): PublicProfile[] {
  const rows = db()
    .prepare('SELECT blocked_id, created_at FROM blocks WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as { blocked_id: string }[];
  return rows
    .map((r) => {
      try {
        return toPublicProfile(getUser(r.blocked_id), userId);
      } catch {
        return null;
      }
    })
    .filter((p): p is PublicProfile => p !== null);
}

/** Read the messaging rule out of a raw settings blob, defaulting to 'contacts'. */
function readWhoCanMessageMe(settingsJson: string): 'everyone' | 'contacts' | 'nobody' {
  try {
    const parsed = JSON.parse(settingsJson) as { privacy?: { whoCanMessageMe?: unknown } };
    const value = parsed.privacy?.whoCanMessageMe;
    return value === 'everyone' || value === 'nobody' ? value : 'contacts';
  } catch {
    return 'contacts';
  }
}
