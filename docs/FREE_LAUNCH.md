# Launching Vesper for real testing — $0 paths

You do **not** need Play Store or App Store approval to put Vesper in real
people's hands. Ranked by reach per rupee spent (all of these are free):

## 1. The web app + PWA (instant, everyone, zero installs)
Vesper ships a service worker and an installable manifest. Host the server
(anywhere below) and testers:
- Android: open the URL in Chrome → menu → **Add to Home screen / Install app**.
  It runs fullscreen, offline-shell included, updates itself on reload.
- Windows/macOS: Chrome/Edge → install icon in the address bar.
No store, no review, no fee, no APK signing. This is your fastest real-test
channel and it is already built.

## 2. Free hosting for the server (same-origin API + web)
- **Oracle Cloud Always Free** (best): 4 ARM cores / 24 GB RAM VM, free
  forever. Run `npm ci && npm start` behind nginx or Caddy (free TLS).
- **Cloudflare Tunnel** (free): exposes a home server / Raspberry Pi with a
  hostname and TLS, no port forwarding, no static IP.
- **Render / Koyeb free tiers**: zero-card Node services; they sleep when
  idle, fine for a test cohort, wrong for production.
Point your domain (or the tunnel hostname) at it, set `NODE_ENV=production`
(HSTS then switches on), and the PWA URL is your launch URL.

## 3. Android APK without Play ($0)
- **Firebase App Distribution** (free): upload the APK/AAB, invite testers by
  email or link, they install the companion app and get updates pushed.
  Crashlytics included. This is the industry-standard private beta channel.
- **GitHub Releases** (free): attach `app-release.apk`; testers tap to
  install. Pair with the repo you already have.
- **F-Droid** (free, open-source only): a real store with zero fees and zero
  gatekeeping beyond reproducible-build hygiene. Vesper's public repo
  qualifies.
- **Direct sideload**: `adb install app-release.apk` for in-person testing.

## 4. iOS without the $99 program ($0)
- **Xcode device install** with a free Apple ID: your own devices, 7-day
  provisioning, re-sign on expiry. Perfect for you + a co-tester with a Mac.
- **AltStore / Sideloadly** (free): install the IPA on any iPhone from any
  computer, 7-day re-sign cycle. Standard for private beta circles.
- (TestFlight itself needs the paid program; the two above do not.)

## 5. Windows ($0)
- GitHub Releases with the NSIS installer from `npm run windows`.
- Or hand testers the PWA (edge/chrome install) — same build, no file.

## 6. The feedback loop you already have
Testers report abuse/bugs through the in-app report form and the public
`/report` page; everything lands in the admin panel's moderated queue with
audit trail. No third-party feedback tool required.

## What actually costs money (only when you want the badges)
| Gate | Cost | Needed for |
|---|---|---|
| Google Play Console | $25 once | Play Store listing (internal/closed testing tracks included) |
| Apple Developer Program | $99/yr | TestFlight, App Store |
| Microsoft Partner Center | $19 once | Microsoft Store listing |

Everything before those three lines is free forever. Recommended order:
PWA URL → Firebase App Distribution (Android) → Xcode/AltStore (iOS) →
GitHub Releases (Windows) → paid stores once the cohort is happy.
