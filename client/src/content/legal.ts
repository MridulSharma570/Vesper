/**
 * Single source of truth for Vesper's public information pages.
 *
 * These pages render in-app at /privacy, /terms, … so they ship inside the
 * same bundle as everything else — no second site to secure, no drift between
 * what the store listing links to and what the app shows. The markdown twins
 * under legal/ in the repository are generated from the same text for people
 * who prefer reading policies in a code review.
 *
 * Written plainly on purpose: a policy nobody can read is not consent.
 */

export interface LegalSection {
  h: string;
  p: string[];
}

export interface LegalDoc {
  slug: string;
  title: string;
  meta: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}

export const OPERATOR = 'Mridul Sharma';
export const CONTACT = 'vesper.privacy@proton.me';
export const COPYRIGHT = `© 2026 ${OPERATOR}. All rights reserved.`;

export const LEGAL_DOCS: LegalDoc[] = [
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    meta: 'What Vesper collects, what it never collects, and who (nobody) can read your messages.',
    updated: '2026-10-06',
    intro:
      'Vesper is built so that the shortest privacy policy is the architecture. This page says exactly what we store, why, and for how long — in plain language.',
    sections: [
      {
        h: 'What we do not collect',
        p: [
          'No real name. No phone number. No email address is required to create or use an account. We do not ask for your contacts list, your location, your photos, or your identity documents, and the app has no code paths that could upload them.',
          'We do not run advertising and we do not sell, rent, or share personal data with data brokers. There is no ad SDK in any Vesper build.',
        ],
      },
      {
        h: 'What we do collect',
        p: [
          'Account data you choose to provide: a display name or handle of your choice, an optional bio, and — only if you link them — a hashed email address or phone number used for sign-in and recovery.',
          'Operational data: message metadata needed to deliver messages (sender, conversation, timestamp, delivery state), session tokens, and device descriptors (platform and app version) that keep sessions safe.',
          'Security logs: rate-limit counters, hashed IP addresses in audit entries, and abuse reports. Hashed means the original address cannot be reconstructed from the log.',
        ],
      },
      {
        h: 'Message content',
        p: [
          'Messages are encrypted in transit with TLS 1.3 and at rest on our servers. Servers must be able to route a message to an offline recipient, so plaintext exists briefly in server memory for delivery; it is deleted from the delivery queue the moment it is acknowledged.',
          'We cannot and do not scan message content for advertising or profiling. Automated hash-matching for illegal content applies only to media attachments if the media pipeline flag is enabled by an operator, never to text.',
        ],
      },
      {
        h: 'How long we keep things',
        p: [
          'Messages: until you delete them, or until the conversation auto-delete window you configured elapses. Deleted messages are removed from the delivery queue and database within one sweep cycle (minutes).',
          'Accounts: until you delete the account. Deletion is immediate for content and queued for full row removal within 30 days. Sessions: until they expire (30 days default) or you sign out.',
          'Audit and security logs: 12 months, then purged automatically.',
        ],
      },
      {
        h: 'Cookies and local storage',
        p: [
          'The web app stores a refresh token and a device identifier in your browser\u2019s local storage so you stay signed in. There are no tracking cookies, no third-party cookies, and no fingerprinting scripts. See the Cookies page for the full list.',
        ],
      },
      {
        h: 'Analytics',
        p: [
          'If a deployment enables aggregate analytics, it is configured with IP anonymisation and never tied to your account identifier. The default build ships with analytics disabled.',
        ],
      },
      {
        h: 'Your rights',
        p: [
          'You can export everything we hold about your account from Settings at any time, and delete your account entirely from the same screen. Because accounts are pseudonymous by design, exercising these rights never requires proving who you are — possession of the account is the proof.',
          `For any privacy question, contact ${CONTACT}. Operator of record: ${OPERATOR}.`,
        ],
      },
      {
        h: 'Children',
        p: [
          'Vesper is not directed at children under 13 (or the minimum age in your jurisdiction, if higher). We do not knowingly collect data from children; if you believe a child has created an account, report it and we will remove it.',
        ],
      },
      {
        h: 'Changes to this policy',
        p: [
          'Material changes are announced in-app at least 14 days before they take effect, and the "updated" date above always reflects the current version.',
        ],
      },
    ],
  },
  {
    slug: 'terms',
    title: 'Terms & Conditions',
    meta: 'The agreement between you and Vesper: what the service is, what we promise, and what we ask of you.',
    updated: '2026-10-06',
    intro: `These Terms & Conditions govern the Vesper service ("Vesper"), operated by ${OPERATOR}. By creating an account or using any Vesper client you accept them.`,
    sections: [
      {
        h: 'The service',
        p: [
          'Vesper is a pseudonymous messaging platform provided as-is across web, mobile and desktop clients. Core text messaging is free. Some capabilities (media, calls, stories) are operator-controlled feature flags and may be unavailable in your deployment.',
        ],
      },
      {
        h: 'Your account',
        p: [
          'You are responsible for activity under your sessions. Because accounts are pseudonymous and we hold no recovery identity by default, a lost device with no linked contact means a lost account — we cannot impersonate-proof a reset without the proof you choose to link.',
          'You may link an email or phone number to enable recovery. Linking is optional and reversible in effect: unlinking removes the identifier from your account.',
        ],
      },
      {
        h: 'Acceptable use',
        p: [
          'You agree not to use Vesper to harass, impersonate, defraud, distribute malware, or share content that is illegal in your jurisdiction, including child sexual abuse material in any form. Violations lead to suspension or termination and, where legally required, referral to authorities.',
          'Automated abuse of the service — spam sending, credential stuffing, scraping the directory — is prohibited and rate-limited by design.',
        ],
      },
      {
        h: 'Content and ownership',
        p: [
          'You keep all rights to what you send. You grant Vesper only the limited licence needed to deliver, store and display your content to the recipients you chose — nothing more, and the licence ends when the content is deleted.',
          `The Vesper software, name and brand are © 2026 ${OPERATOR}. See the License page for the code licence.`,
        ],
      },
      {
        h: 'Availability and changes',
        p: [
          'We target high availability but provide no SLA in this free tier. We may change or discontinue features with reasonable notice in-app. If we discontinue the service entirely, we will give 60 days\u2019 notice and an export window.',
        ],
      },
      {
        h: 'Liability',
        p: [
          'To the maximum extent permitted by law, Vesper is provided without warranties of any kind, and our aggregate liability arising from the service is limited to twelve months of fees you paid us (zero, for the free service). Nothing in these terms limits liability that cannot be limited by law.',
        ],
      },
      {
        h: 'Termination',
        p: [
          'You may delete your account at any time from Settings. We may suspend or terminate accounts that breach these terms, with the reason recorded in an audit trail you can request.',
        ],
      },
      {
        h: 'Governing law',
        p: [
          `These terms are governed by the laws of India, without regard to conflict-of-law rules, with the courts of Ludhiana, Punjab as the agreed forum. Operator of record: ${OPERATOR}, contact ${CONTACT}.`,
        ],
      },
    ],
  },
  {
    slug: 'terms-of-use',
    title: 'Terms of Use',
    meta: 'The practical rules of the road for using Vesper clients, from app-store builds to the web app.',
    updated: '2026-10-06',
    intro:
      'The Terms of Use complement the Terms & Conditions: they describe how you may install and operate Vesper client software day to day.',
    sections: [
      {
        h: 'Licence to the clients',
        p: [
          'You receive a personal, non-exclusive, non-transferable licence to install and run official Vesper clients (web, Android, iOS, Windows) for your own lawful use. Builds distributed through the Apple App Store, Google Play and Microsoft Store are additionally subject to those stores\u2019 standard end-user terms.',
        ],
      },
      {
        h: 'No reverse engineering of the service',
        p: [
          'You may not probe, scan, or test the vulnerability of the service, bypass rate limits or authentication, or operate modified clients against the production API in ways that harm other users. Reading and modifying your own copy of the open client source for personal use is fine.',
        ],
      },
      {
        h: 'One person, many devices',
        p: [
          'A single human may hold any reasonable number of devices and pseudonymous accounts. Automated or bulk account creation is prohibited.',
        ],
      },
      {
        h: 'Session security',
        p: [
          'Vesper rotates session tokens on every connection and signs other devices out when you change your password. You agree not to share session tokens or invite others to use your signed-in device as a proxy for abuse.',
        ],
      },
      {
        h: 'Feature flags and experiments',
        p: [
          'Operators can enable experimental capabilities (media pipeline, calls, stories, end-to-end encryption beta). Experimental means exactly that: they may be incomplete, and their behaviour can change between releases without a migration path for stored experiment data.',
        ],
      },
      {
        h: 'Reporting problems',
        p: [
          'Security reports are welcome and should go to the contact on the Encryption page. Abuse reports can be filed in-app or through the public report form, with or without an account.',
        ],
      },
    ],
  },
  {
    slug: 'cookies',
    title: 'Cookies Policy',
    meta: 'The complete list of what Vesper stores in your browser — two local-storage keys and nothing else.',
    updated: '2026-10-06',
    intro:
      'Short version: Vesper sets no cookies at all. The web app uses browser local storage for exactly two values, listed below, and neither is readable by any third party.',
    sections: [
      {
        h: 'Why no cookies',
        p: [
          'Cookies travel with every request to a domain, including requests to embedded third-party content. Vesper embeds no third-party content, so cookies would add risk without benefit. Authentication uses bearer tokens sent explicitly by the app instead.',
        ],
      },
      {
        h: 'Local storage we use',
        p: [
          'vesper.refresh — an encrypted-at-rest refresh token that keeps you signed in between visits. It rotates on every use; a stolen copy is single-use.',
          'vesper.deviceId — a random identifier for this browser so sessions can be listed and revoked individually in Settings.',
        ],
      },
      {
        h: 'What happens when you clear it',
        p: [
          'Clearing site data signs you out. Nothing else is lost: your account, conversations and settings live server-side and reappear on the next sign-in.',
        ],
      },
      {
        h: 'Third-party storage',
        p: [
          'None. No advertising, no analytics cookies by default, no social widgets, no fonts or scripts from other origins. If a deployment opts into aggregate analytics, it uses a first-party configuration with IP anonymisation and is disclosed on the Privacy page.',
        ],
      },
    ],
  },
  {
    slug: 'encryption',
    title: 'Encryption Policy',
    meta: 'The cryptographic choices behind Vesper: password hashing, transport security, tokens, and the E2EE roadmap.',
    updated: '2026-10-06',
    intro:
      'This page documents the cryptography Vesper actually uses, including the parts that are still rolling out. Where a capability is experimental, we say so instead of implying it is finished.',
    sections: [
      {
        h: 'Passwords',
        p: [
          'Passwords are hashed with scrypt (N=32768, r=8, p=1) using a per-password random salt. Verification is constant-time. Password changes revoke every other session immediately.',
        ],
      },
      {
        h: 'Transport',
        p: [
          'All client-server traffic uses TLS. Production deployments are configured with HSTS (two-year max-age, includeSubDomains, preload-ready) so browsers refuse downgrade to plaintext HTTP after first contact. WebSockets run over the same TLS channel.',
        ],
      },
      {
        h: 'Sessions and tokens',
        p: [
          'Access tokens are short-lived (15 minutes) signed JWTs; refresh tokens are opaque, single-use, and rotate within a family — reuse of a rotated token revokes the whole family, which is what turns token theft into a loud, recoverable event.',
        ],
      },
      {
        h: 'Data at rest',
        p: [
          'The server database is encrypted at the storage layer where the deployment provides it. Sensitive identifiers (emails, phones, IP addresses) are stored only as keyed hashes, so a database leak does not leak the plaintext contact graph.',
        ],
      },
      {
        h: 'End-to-end encryption (experimental)',
        p: [
          'An end-to-end encryption beta exists behind an operator flag. While flagged experimental it is not enabled by default and is not yet audited; do not treat it as a guarantee. The design goal is double-ratchet style per-conversation keys with server-blind message bodies, and the roadmap will be published here before the flag defaults on.',
        ],
      },
      {
        h: 'Responsible disclosure',
        p: [
          `If you find a weakness in any of the above, please report it privately to ${CONTACT} before publishing. We triage security reports ahead of feature work and will credit you if you want the credit.`,
        ],
      },
    ],
  },
  {
    slug: 'license',
    title: 'License',
    meta: 'Copyright and licence terms for the Vesper name, brand and source code.',
    updated: '2026-10-06',
    intro: `Vesper is © 2026 ${OPERATOR}. All rights reserved unless explicitly stated below.`,
    sections: [
      {
        h: 'The software',
        p: [
          'The Vesper client and server source code in this repository is provided for inspection and personal use. You may read it, audit it, and run private instances for personal or internal evaluation.',
          'Commercial redistribution, offering Vesper as a hosted service to third parties, or use of the Vesper name and brand in another product, requires written permission from the copyright holder.',
        ],
      },
      {
        h: 'The brand',
        p: [
          'The Vesper name, the vesper-star mark, and all associated logo artwork are trademarks of the copyright holder. Unmodified redistribution of official builds is permitted; forks must rename.',
        ],
      },
      {
        h: 'Third-party components',
        p: [
          'Vesper stands on open-source libraries (Fastify, React, better-sqlite3, and others). Each remains under its own licence; the dependency manifest in the repository lists them with versions.',
        ],
      },
      {
        h: 'No warranty',
        p: [
          'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY ARISING FROM USE OF THE SOFTWARE.',
        ],
      },
    ],
  },
];

/* ─────────────────────────── FAQ ─────────────────────────── */

export interface FaqEntry {
  q: string;
  a: string;
}

export const FAQ: FaqEntry[] = [
  {
    q: 'Do I need a phone number or email to sign up?',
    a: 'No. Vesper creates a pseudonymous account with a random handle and identity key. You can link an email or phone later for recovery, but it stays optional forever and is stored only as a hash.',
  },
  {
    q: 'Can people I chat with see who I am?',
    a: 'Only what you choose to show: your display name, handle and avatar. Your linked contacts, device details and IP address are never exposed to other users.',
  },
  {
    q: 'What happens if I lose my device?',
    a: 'If you linked an email or phone, you can recover the account with a verification code. If you did not, the account cannot be recovered — that is the trade-off of not storing any identity about you. We will never ask you for ID documents.',
  },
  {
    q: 'Is Vesper end-to-end encrypted?',
    a: 'Messages are encrypted in transit (TLS) and at rest on the server. A true end-to-end encryption mode exists as an operator-controlled experimental flag and is documented honestly on the Encryption page, including what is not finished yet.',
  },
  {
    q: 'Can I change my handle or disappear?',
    a: 'Yes. Rotate your handle from Settings whenever you like; old handles are released, not forwarded. Deleting your account removes your content within one sweep cycle and the remaining rows within 30 days.',
  },
  {
    q: 'Does Vesper show ads or sell data?',
    a: 'No ads, no data sales, no brokers, no ad SDKs. The business model is the operator\u2019s own; your attention and your data are not the product.',
  },
  {
    q: 'Which platforms are supported?',
    a: 'One codebase ships to the web, Android, iOS and Windows from the same source tree, so behaviour and security properties stay identical everywhere.',
  },
  {
    q: 'How do I report abuse?',
    a: 'In-app: long-press a message or open a profile and choose Report. Without an account: the public report form on this site. Both paths reach the same moderated queue, and statutory categories (CSAE, self-harm) jump it.',
  },
  {
    q: 'What are people saying about Vesper?',
    a: 'We publish testimonials only from real users who explicitly agree to be quoted, and none have been collected yet — so you will not see any on this site. When real ones exist, they will appear here with permission, unedited.',
  },
  {
    q: 'Who runs Vesper?',
    a: `Vesper is operated by ${OPERATOR}. Policy questions go to ${CONTACT}; security reports are triaged ahead of feature work.`,
  },
];
