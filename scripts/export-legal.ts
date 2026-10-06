/**
 * Export the in-app policy content (client/src/content/legal.ts) as markdown
 * documents under legal/, so the repository carries reviewable copies of
 * exactly what the public pages render. Run:
 *
 *   npx tsx scripts/export-legal.ts
 *
 * The client module stays the single source of truth; these files are
 * generated artifacts checked in for convenience (store submissions, code
 * review, offline reading).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGAL_DOCS, FAQ, OPERATOR, CONTACT, COPYRIGHT } from '../client/src/content/legal';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'legal');
mkdirSync(outDir, { recursive: true });

const fileNames: Record<string, string> = {
  privacy: 'PRIVACY_POLICY.md',
  terms: 'TERMS_AND_CONDITIONS.md',
  'terms-of-use': 'TERMS_OF_USE.md',
  cookies: 'COOKIES_POLICY.md',
  encryption: 'ENCRYPTION_POLICY.md',
  license: 'LICENSE.md',
};

function docToMarkdown(slug: string): string {
  const doc = LEGAL_DOCS.find((d) => d.slug === slug);
  if (!doc) throw new Error(`unknown doc ${slug}`);
  const lines = [
    `# ${doc.title}`,
    '',
    `> ${doc.meta}`,
    '',
    `*Updated ${doc.updated} · Operator: ${OPERATOR} · Contact: ${CONTACT}*`,
    '',
    doc.intro,
    '',
  ];
  for (const s of doc.sections) {
    lines.push(`## ${s.h}`, '');
    for (const p of s.p) lines.push(p, '');
  }
  lines.push('---', '', COPYRIGHT, '');
  return lines.join('\n');
}

const written: string[] = [];
for (const [slug, file] of Object.entries(fileNames)) {
  writeFileSync(join(outDir, file), docToMarkdown(slug));
  written.push(file);
}

const faq = [
  '# Frequently Asked Questions',
  '',
  '> How Vesper handles anonymity, recovery, encryption, abuse reports and platforms — answered plainly.',
  '',
  `*Operator: ${OPERATOR} · Contact: ${CONTACT}*`,
  '',
  ...FAQ.flatMap((f) => [`## ${f.q}`, '', f.a, '']),
  '---',
  '',
  'Testimonials: Vesper publishes quotes only from real users who explicitly agree to be quoted.',
  'None have been collected yet, so none are published. We do not invent them.',
  '',
  COPYRIGHT,
  '',
].join('\n');
writeFileSync(join(outDir, 'FAQ.md'), faq);
written.push('FAQ.md');

const readme = [
  '# Vesper legal set',
  '',
  `Generated from \`client/src/content/legal.ts\` — the same module the public pages`,
  'render — by `npx tsx scripts/export-legal.ts`. Edit the module, re-run, commit.',
  '',
  ...written.map((f) => `- [${f}](${f})`),
  '',
  `All documents © 2026 ${OPERATOR}.`,
  '',
].join('\n');
writeFileSync(join(outDir, 'README.md'), readme);
written.push('README.md');

console.log('wrote:', written.join(', '));
