# Encryption Policy

> The cryptographic choices behind Vesper: password hashing, transport security, tokens, and the E2EE roadmap.

*Updated 2026-10-06 · Operator: Mridul Sharma · Contact: vesper.privacy@proton.me*

This page documents the cryptography Vesper actually uses, including the parts that are still rolling out. Where a capability is experimental, we say so instead of implying it is finished.

## Passwords

Passwords are hashed with scrypt (N=32768, r=8, p=1) using a per-password random salt. Verification is constant-time. Password changes revoke every other session immediately.

## Transport

All client-server traffic uses TLS. Production deployments are configured with HSTS (two-year max-age, includeSubDomains, preload-ready) so browsers refuse downgrade to plaintext HTTP after first contact. WebSockets run over the same TLS channel.

## Sessions and tokens

Access tokens are short-lived (15 minutes) signed JWTs; refresh tokens are opaque, single-use, and rotate within a family — reuse of a rotated token revokes the whole family, which is what turns token theft into a loud, recoverable event.

## Data at rest

The server database is encrypted at the storage layer where the deployment provides it. Sensitive identifiers (emails, phones, IP addresses) are stored only as keyed hashes, so a database leak does not leak the plaintext contact graph.

## End-to-end encryption (experimental)

An end-to-end encryption beta exists behind an operator flag. While flagged experimental it is not enabled by default and is not yet audited; do not treat it as a guarantee. The design goal is double-ratchet style per-conversation keys with server-blind message bodies, and the roadmap will be published here before the flag defaults on.

## Responsible disclosure

If you find a weakness in any of the above, please report it privately to vesper.privacy@proton.me before publishing. We triage security reports ahead of feature work and will credit you if you want the credit.

---

© 2026 Mridul Sharma. All rights reserved.
