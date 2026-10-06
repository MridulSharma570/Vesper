# Vesper — anonymous, by design

> Pseudonymous messaging and social, one codebase, four targets: **Web (PWA) · Android · iOS · Windows**.
> No name. No number. No profile photo required. You sign up, you get a random handle and an ID, and you're talking — the server learns as little about you as it can.

[![Tests](https://img.shields.io/badge/tests-86%20assertions%20green-brightgreen)](tests) [![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](.nvmrc) [![License](https://img.shields.io/badge/license-proprietary-informational)](legal/LICENSE.md)

## What you get

- **Real accounts, real humans.** No demo bots, no seeded sample data — every account in a Vesper database was created by a person or by the administrator.
- **Pseudonymous by default.** Random handle (`@x9k2…`) + permanent ID. Email/phone/Google/Apple sign-in are *optional*; when linked they're stored hashed (search) and AES-256-GCM encrypted (retrieval), and never shown to other users — other people see your handle and nothing else.
- **Chat that feels finished.** DMs and groups, live WebSocket delivery with typing indicators and presence, reactions, pins, conversation list with unread badges, keyset-cursor pagination, optimistic sending.
- **Staff & moderation.** Rank-gated roles (owner 100 → moderator 40 → user 10) drive a real admin panel: user list, reports queue (in-app **and** public website reports), feature flags, audit log. Everything staff does is recorded.
- **A public website, honestly.** Landing page, privacy/terms/cookies/encryption policies, FAQ, abuse report form with honeypot, sitemap, robots, OG cards, truthful 404s. Testimonials appear only when real people give permission — never fabricated.
- **Installable everywhere.** Web app is a PWA (service worker, offline shell, standalone install on Android/iOS/Windows/macOS); Capacitor wraps native Android/iOS; Electron packages Windows installers.
- **Flag-gated futures.** Media pipeline, calls, stories and E2EE beta exist as scaffolds behind admin flags — the live product is text-only and fully functional, nothing is half-broken in production.

## Security posture

| Area | Implementation |
|---|---|
| Passwords | `node:crypto` scrypt, N=32768 r=8 p=1, per-user salt |
| Sessions | Short-lived JWTs (15 min, HS256) + rotating refresh-token families; reuse detection revokes the family |
| Data at rest | SQLite (WAL), linked identifiers encrypted with AES-256-GCM, search via keyed fingerprints |
| Transport | HSTS (2-year, preload-ready) in production, strict CSP, helmet, origin-locked WebSockets |
| Abuse | Rank-gated moderation, audit trail, rate limits per endpoint tier, honeypot forms |
| Analytics | Off by default; opt-in Google Analytics with `anonymize_ip`, spliced only when `VESPER_GA_ID` is set |
| Boot | Refuses to start in production without `JWT_SECRET`, `IDENTITY_PEPPER`, `DATA_ENCRYPTION_KEY` |

## Repository layout

```
server/    Fastify + better-sqlite3 API (src/routes, src/services, src/db, src/tools/seed.ts)
client/    React 18 + Vite web app (also the Capacitor webDir; client/android is the generated shell)
desktop/   Electron shell + electron-builder (NSIS + APPX)
shared/    Types and constants shared by server and client
tests/     baseline-batch.mjs · e2e-chat.mjs · admin-probe.mjs  (plain Node, hit a running server)
docs/      PLATFORMS.md (native builds) · PROVIDERS.md (keys) · FREE_LAUNCH.md ($0 distribution)
legal/     Policy set generated from client/src/content/legal.ts (operator: Mridul Sharma)
scripts/   setup · dev · mobile · desktop · build-all · doctor · export-legal
deploy/    Caddyfile, systemd unit and the free-deployment runbook
brand/     Marks and OG artwork
```

## Quick start (development)

```bash
git clone https://github.com/MridulSharma570/Vesper.git
cd Vesper
npm ci                       # Node 20+
npm run setup                # DB + schema + first-staff bootstrap
npm run dev                  # API + client on http://localhost:8787
```

Seed additional staff with `npm run seed -- --handle=<name> --role=<owner|admin|moderator>` (prints a one-time password). Feature flags, moderation and provider keys live in the admin panel and env — see `docs/PROVIDERS.md`. **Nothing is faked**: providers without keys use a logging dev driver (OTP emails land in `server/data/outbox/` and the console).

## Tests

```bash
node tests/baseline-batch.mjs     # product invariants (set ADMIN_PW for the official-account section)
node tests/e2e-chat.mjs           # full conversation lifecycle over HTTP + WebSocket
node tests/admin-probe.mjs        # staff, moderation and audit behaviour
```

Suites need a running server; for rate-limit-free CI runs start it with `VESPER_TEST_NO_RATELIMIT=1` (dev-only; ignored in production).

## Build the shells

```bash
npm run android    # VITE_VESPER_API=<your api> npm run build && cap sync android
npm run ios        # macOS + Xcode; see docs/PLATFORMS.md
npm run windows    # Electron NSIS + APPX into desktop/release/
```

## Deploy for $0

PWA + a free host is the entire launch kit: `docs/FREE_LAUNCH.md` walks through Oracle Cloud Always-Free (or a home machine behind a Cloudflare Tunnel) with Caddy for automatic TLS, then inviting testers with a single link. `deploy/DEPLOY.md` has the copy-paste runbook.

## License & operator

Proprietary — see [`legal/LICENSE.md`](legal/LICENSE.md). Operated by **Mridul Sharma**; privacy contact `vesper.privacy@proton.me`. © 2026.

*Vesper is anonymous by design, not lawless: every account is bound to device keys and rate limits, every report is triaged by staff, and the policies on this repo's website are the same ones the app enforces.*
