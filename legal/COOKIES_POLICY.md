# Cookies Policy

> The complete list of what Vesper stores in your browser — two local-storage keys and nothing else.

*Updated 2026-10-06 · Operator: Mridul Sharma · Contact: vesper.privacy@proton.me*

Short version: Vesper sets no cookies at all. The web app uses browser local storage for exactly two values, listed below, and neither is readable by any third party.

## Why no cookies

Cookies travel with every request to a domain, including requests to embedded third-party content. Vesper embeds no third-party content, so cookies would add risk without benefit. Authentication uses bearer tokens sent explicitly by the app instead.

## Local storage we use

vesper.refresh — an encrypted-at-rest refresh token that keeps you signed in between visits. It rotates on every use; a stolen copy is single-use.

vesper.deviceId — a random identifier for this browser so sessions can be listed and revoked individually in Settings.

## What happens when you clear it

Clearing site data signs you out. Nothing else is lost: your account, conversations and settings live server-side and reappear on the next sign-in.

## Third-party storage

None. No advertising, no analytics cookies by default, no social widgets, no fonts or scripts from other origins. If a deployment opts into aggregate analytics, it uses a first-party configuration with IP anonymisation and is disclosed on the Privacy page.

---

© 2026 Mridul Sharma. All rights reserved.
