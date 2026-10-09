# Facet for Android

Native Kotlin + Jetpack Compose. Minimum Android 8.0 (API 26), targets Android 16 (API 36),
compiles against API 37.

## Requirements

- JDK 17 or newer (21 recommended)
- Android SDK with platform `android-37.0` and build tools 37 (Android Studio installs these)
- `local.properties` with `sdk.dir=...` (Android Studio writes it for you)

## Build

```sh
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk (id io.dtsoftware.facet.debug)
./gradlew assembleRelease      # app/build/outputs/apk/release/app-release.apk (R8-minified, ~3.3 MB)
```

The debug build installs next to the release build (`.debug` application id suffix).

### Release signing

Release builds are signed with the key described in `android/keystore.properties`
(never commit it). Without that file they fall back to the debug key, which is fine for local
testing but **can't be used for distribution**: Android only installs updates signed with the
same key, so create your release key once and back it up.

```sh
keytool -genkeypair -v -keystore facet-release.jks -alias facet -keyalg RSA -keysize 4096 -validity 10000
```

`android/keystore.properties`:

```properties
storeFile=../facet-release.jks
storePassword=…
keyAlias=facet
keyPassword=…
```

Then `./gradlew assembleRelease` and upload `app-release.apk` to the server's
`deploy/downloads/facet-latest.apk` (see [docs/DEPLOY.md](../docs/DEPLOY.md)).

## Test

```sh
./gradlew testDebugUnitTest              # all JVM tests (LLM adapters, Markdown, crypto vectors, sync)
./gradlew recordRoborazziDebug           # re-render screenshots into app/build/outputs/roborazzi/
```

- `CryptoVectorsTest` checks the client crypto against `docs/test-vectors.json`.
- `SyncEndToEndTest` runs two simulated devices against a real Facet server. It's skipped unless
  one answers at `http://127.0.0.1:8788` (or `-Dfacet.e2eServer=…`):
  `cd server && npm run build && PORT=8788 JWT_SECRET=… SERVER_SECRET=… node dist/index.js`.
- `AppScreenshotTest` renders the main screens with sample data for design review.

## Structure

```
app/src/main/java/io/dtsoftware/facet/
  AppContainer.kt        manual dependency graph
  core/crypto            client-side encryption (docs/SECURITY.md), Keystore-backed SecretBox
  core/net               SSE parser and HTTP helpers
  data/db                Room entities, DAOs, FTS search
  data/repo              conversations (with branches), providers/keys, assistants, prompts, folders, attachments
  data/prefs             device settings and synced settings
  llm/                   provider-agnostic contract + Anthropic, OpenAI Responses, OpenAI-compatible adapters,
                         model capability inference, pricing, self-healing parameter quirks
  sync/                  sync API client, account/auth manager, record codec, sync engine, background worker
  domain/                chat engine (streaming, branching, titles, costs), background generation service
  ui/                    theme, components, markdown renderer, chat, drawer, settings, auth, onboarding, app lock
tools/make-icons.mjs     regenerates the Lucide icon drawables
```

## Notes

- Model calls go directly from the device to the provider. Facet's server never sees them.
- Cleartext HTTP is allowed so local servers (Ollama, LM Studio) on your network work; every cloud
  provider and the sync server use HTTPS.
- Icons: [Lucide](https://lucide.dev) (ISC). Fonts: Instrument Sans/Serif and JetBrains Mono (OFL).
