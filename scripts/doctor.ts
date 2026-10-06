/**
 * Configuration doctor: answers "what is live and what is still the logging
 * dev driver?" without printing a single secret value. Run from repo root:
 *
 *   npx tsx scripts/doctor.ts
 */
const checks: { name: string; vars: string[]; hint: string }[] = [
  { name: 'Email (SMTP)', vars: ['SMTP_URL'], hint: 'smtps://user:pass@host:465' },
  { name: 'Email (AWS SES)', vars: ['SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY'], hint: 'or set SMTP_URL instead' },
  { name: 'SMS (MSG91)', vars: ['MSG91_AUTH_KEY'], hint: 'plus MSG91_SENDER_ID / MSG91_TEMPLATE_ID' },
  { name: 'Google sign-in', vars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], hint: 'OAuth client from cloud.console.google.com' },
  { name: 'Apple sign-in', vars: ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID'], hint: 'developer.apple.com → Sign in with Apple' },
  { name: 'Analytics', vars: ['VESPER_GA_ID'], hint: 'unset = analytics fully off (recommended default)' },
];

console.log('\nVesper provider status\n──────────────────────');
for (const c of checks) {
  const set = c.vars.filter((v) => process.env[v]?.trim());
  const state = set.length === c.vars.length ? 'configured' : set.length ? `partial (${set.join(', ')})` : 'dev driver (logs only)';
  console.log(`${state === 'configured' ? '●' : '○'} ${c.name.padEnd(18)} ${state.padEnd(22)} ${state === 'configured' ? '' : c.hint}`);
}
console.log(`○ feature flags       admin panel (Settings → Admin panel → Flags)\n`);
