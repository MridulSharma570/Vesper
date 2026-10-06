# Building the native shells (Android · iOS · Windows)

One codebase, four targets. The web client is the source of truth; the
native shells wrap `client/dist`.

## 0. The one rule for native builds

A packaged WebView has no server inside it, so native builds must know where
the API lives **at build time**:

```bash
VITE_VESPER_API=https://api.your-domain.example npm run build --workspace client
```

The web build leaves `VITE_VESPER_API` empty and stays perfectly same-origin.

## Android (Capacitor)

```bash
npm run android          # builds web, runs: cap sync android
cd client && npx cap open android   # Android Studio
```

- Debug APK: Android Studio → Run, or `./gradlew assembleDebug`.
- Release: create a keystore (`keytool -genkeypair -v -keystore vesper.keystore -alias vesper`),
  wire `signingConfigs` in `client/android/app/build.gradle`, `./gradlew bundleRelease`
  produces the `.aab` for Play.
- Play Store needs a one-time **$25** developer account. Free distribution
  alternatives are in FREE_LAUNCH.md.

## iOS (Capacitor, requires macOS + Xcode)

```bash
cd client && npm i @capacitor/ios && npx cap add ios
npm run ios              # from repo root: build web + cap sync ios
cd client && npx cap open ios
```

- Signing: Xcode → Signing & Capabilities. A **free Apple ID** can install to
  your own devices (7-day provisioning, 3 devices) — enough for real testing.
- TestFlight / App Store need the **$99/year** Apple Developer Program.

## Windows / desktop (Electron)

```bash
npm run windows          # builds web, then electron-builder in desktop/
```

- `desktop/electron/main.ts` loads `VESPER_WEB_URL` when set (recommended for
  testers: same-origin API, zero config), otherwise the packaged `client/dist`.
- Outputs NSIS installer + APPX in `desktop/release/`.
- Microsoft Store submission is a one-time **$19**; direct installer
  distribution is free (see FREE_LAUNCH.md).

## Versioning for stores

Bump `version` in `package.json` (root) and mirror it into
`client/android/app/build.gradle` (`versionName`) and the Electron builder
config before each store upload. Build numbers must increase per upload.
