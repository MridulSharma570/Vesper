# Privacy Policy

> What Vesper collects, what it never collects, and who (nobody) can read your messages.

*Updated 2026-10-06 · Operator: Mridul Sharma · Contact: vesper.privacy@proton.me*

Vesper is built so that the shortest privacy policy is the architecture. This page says exactly what we store, why, and for how long — in plain language.

## What we do not collect

No real name. No phone number. No email address is required to create or use an account. We do not ask for your contacts list, your location, your photos, or your identity documents, and the app has no code paths that could upload them.

We do not run advertising and we do not sell, rent, or share personal data with data brokers. There is no ad SDK in any Vesper build.

## What we do collect

Account data you choose to provide: a display name or handle of your choice, an optional bio, and — only if you link them — a hashed email address or phone number used for sign-in and recovery.

Operational data: message metadata needed to deliver messages (sender, conversation, timestamp, delivery state), session tokens, and device descriptors (platform and app version) that keep sessions safe.

Security logs: rate-limit counters, hashed IP addresses in audit entries, and abuse reports. Hashed means the original address cannot be reconstructed from the log.

## Message content

Messages are encrypted in transit with TLS 1.3 and at rest on our servers. Servers must be able to route a message to an offline recipient, so plaintext exists briefly in server memory for delivery; it is deleted from the delivery queue the moment it is acknowledged.

We cannot and do not scan message content for advertising or profiling. Automated hash-matching for illegal content applies only to media attachments if the media pipeline flag is enabled by an operator, never to text.

## How long we keep things

Messages: until you delete them, or until the conversation auto-delete window you configured elapses. Deleted messages are removed from the delivery queue and database within one sweep cycle (minutes).

Accounts: until you delete the account. Deletion is immediate for content and queued for full row removal within 30 days. Sessions: until they expire (30 days default) or you sign out.

Audit and security logs: 12 months, then purged automatically.

## Cookies and local storage

The web app stores a refresh token and a device identifier in your browser’s local storage so you stay signed in. There are no tracking cookies, no third-party cookies, and no fingerprinting scripts. See the Cookies page for the full list.

## Analytics

If a deployment enables aggregate analytics, it is configured with IP anonymisation and never tied to your account identifier. The default build ships with analytics disabled.

## Your rights

You can export everything we hold about your account from Settings at any time, and delete your account entirely from the same screen. Because accounts are pseudonymous by design, exercising these rights never requires proving who you are — possession of the account is the proof.

For any privacy question, contact vesper.privacy@proton.me. Operator of record: Mridul Sharma.

## Children

Vesper is not directed at children under 13 (or the minimum age in your jurisdiction, if higher). We do not knowingly collect data from children; if you believe a child has created an account, report it and we will remove it.

## Changes to this policy

Material changes are announced in-app at least 14 days before they take effect, and the "updated" date above always reflects the current version.

---

© 2026 Mridul Sharma. All rights reserved.
