/**
 * CLI: create or reset a staff account.
 *
 *   npm run seed -- --handle=ops --password='…' --role=admin
 *
 * This exists for one reason: an operator who has lost every admin account needs
 * a way back in that does not require editing the database by hand. Running it
 * requires local filesystem access — the same trust level as already holding the
 * database file and the encryption key — so it does not widen the attack surface.
 *
 * Every invocation writes a `critical` audit row.
 */
import { closeDb } from '../db/index.js';
import { seedFromCli } from '../seed.js';

function main(): void {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      `\nUsage: npm run seed -- --handle=<handle> --password=<password> [--role=<role>]\n\n` +
      `  --handle    3-32 characters, a-z 0-9 and underscore\n` +
      `  --password  at least 12 characters\n` +
      `  --role      admin | moderator | controller | developer | owner   (default: admin)\n\n` +
      `If the handle already exists its password and role are reset and the account is\n` +
      `flagged to change its password on next sign-in.\n\n`,
    );
    return;
  }

  try {
    const account = seedFromCli(argv);
    if (!account) {
      process.stderr.write('Nothing was created.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `\n✓ ${account.role} account ready\n` +
      `    handle    ${account.handle}\n` +
      `    id        ${account.id}\n` +
      `    password  ${account.password}\n\n` +
      `  The account must change this password on first sign-in.\n\n`,
    );
  } catch (e) {
    process.stderr.write(`\n✗ ${e instanceof Error ? e.message : String(e)}\n\n`);
    process.exitCode = 1;
  } finally {
    try { closeDb(); } catch { /* already closed */ }
  }
}

main();
