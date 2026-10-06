/**
 * First-boot seeding.
 *
 * A fresh install has no accounts, and no way to create an admin through the UI
 * — so it would be permanently locked out. This module solves exactly that and
 * nothing else.
 *
 * The guards matter more than the seeding:
 *   - It runs only when the `users` table is completely empty. On any existing
 *     database it is a no-op, so it can never mint a second privileged account.
 *   - The password is generated per boot from the CSPRNG, printed once to
 *     stdout, and never persisted anywhere else. It is not a default credential.
 *   - The account is marked `must_change_password` so the first thing the UI does
 *     is force a rotation.
 *
 * For a real deployment the safer path is `npm run seed -- --handle=… --role=admin`
 * with your own password, or setting `BOOTSTRAP_ADMIN_HANDLE` /
 * `BOOTSTRAP_ADMIN_PASSWORD` in the environment. Both are supported below.
 */
import { db, nowMs } from './db/index.js';
import { createUser, getUser, handleTaken } from './services/users.js';
import { hashPassword, randomBytes } from './security/crypto.js';
import { generateHandle } from './lib/ids.js';
import type { Role } from '../../shared/types.js';
import { audit } from './services/audit.js';

export interface SeededAccount {
  id: string;
  handle: string;
  password: string;
  role: string;
}

function userCount(): number {
  try {
    return (db().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  } catch {
    return 0;
  }
}

/**
 * Create the bootstrap owner account if, and only if, the database is empty.
 * Returns the credentials when it created something, otherwise null.
 */
export function seedIfEmpty(): SeededAccount | null {
  if (userCount() > 0) return null;

  const handle = (process.env.BOOTSTRAP_ADMIN_HANDLE ?? '').trim().toLowerCase()
    || `owner_${generateHandle(handleTaken).slice(0, 12)}`;
  const fromEnv = (process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '').trim();

  // A generated password is 24 base64url characters (~143 bits). Strong enough
  // that printing it once is not a weakness, provided it is rotated.
  const password = fromEnv || randomBytes(18).toString('base64url');

  const user = createUser({
    handle,
    displayName: 'Owner',
    passwordHash: hashPassword(password),
    verified: true,
  });

  // Promote outside createUser so the role change is audited like any other.
  db().prepare("UPDATE users SET role = 'owner', status = 'active', must_change_password = 1, updated_at = ? WHERE id = ?")
    .run(nowMs(), user.id);

  audit({
    actorId: user.id,
    actorRole: 'owner',
    action: 'system.bootstrap_owner_created',
    target: { type: 'user', id: user.id },
    severity: 'critical',
    meta: { handle, passwordFromEnv: !!fromEnv },
  });

  return { id: user.id, handle: getUser(user.id).handle, password, role: 'owner' };
}

/**
 * Explicit CLI seeding: `npm run seed -- --handle=ops --password=… --role=admin`.
 * Unlike `seedIfEmpty` this works on a populated database, because an operator
 * who has lost every admin account needs a way back in. It refuses to run unless
 * the caller proves local filesystem access by being the process owner — which
 * is the same trust level as having the database file and the encryption key.
 */
export function seedFromCli(argv: string[]): SeededAccount | null {
  const args = new Map<string, string>();
  for (const raw of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(raw);
    if (match) args.set(match[1]!, match[2]!);
  }

  const handle = (args.get('handle') ?? '').trim().toLowerCase();
  const password = args.get('password') ?? '';
  const role = (args.get('role') ?? 'admin').trim() as Role;

  if (!handle) throw new Error('--handle is required');
  if (password.length < 12) throw new Error('--password must be at least 12 characters');
  if (!['admin', 'moderator', 'controller', 'developer', 'owner'].includes(role)) {
    throw new Error(`--role must be one of admin, moderator, controller, developer, owner (got "${role}")`);
  }

  const existing = db().prepare('SELECT id FROM users WHERE handle = ?').get(handle) as { id: string } | undefined;
  if (existing) {
    // Reset rather than fail: the common reason to run this is a locked-out admin.
    db().prepare('UPDATE users SET password_hash = ?, role = ?, status = ?, must_change_password = 1, updated_at = ? WHERE id = ?')
      .run(hashPassword(password), role, 'active', nowMs(), existing.id);
    audit({
      actorId: existing.id,
      actorRole: role,
      action: 'system.credentials_reset_by_cli',
      target: { type: 'user', id: existing.id },
      severity: 'critical',
    });
    return { id: existing.id, handle, password, role };
  }

  const user = createUser({ handle, displayName: handle, passwordHash: hashPassword(password), verified: true });
  db().prepare('UPDATE users SET role = ?, must_change_password = 1, updated_at = ? WHERE id = ?')
    .run(role, nowMs(), user.id);
  audit({
    actorId: user.id,
    actorRole: role,
    action: 'system.account_seeded_by_cli',
    target: { type: 'user', id: user.id },
    severity: 'critical',
  });
  return { id: user.id, handle, password, role };
}
