# Facet

**Every model. One home.** Facet is an open-source, end-to-end encrypted AI chat app for
Android. Bring your own API keys for OpenAI, Anthropic, Google Gemini, OpenRouter, xAI,
DeepSeek, Mistral, Groq, or any OpenAI-compatible endpoint, and use every model they offer
from one fast, native app that syncs across your devices.

Made by DT Software · [facet.dtsoftware.io](https://facet.dtsoftware.io) · Apache License 2.0

<p>
  <img src="docs/screenshots/chat_dark.png" width="240" alt="A conversation with reasoning, a table, math and citations">
  <img src="docs/screenshots/new_chat_dark.png" width="240" alt="New chat with starters and assistants">
  <img src="docs/screenshots/drawer_dark.png" width="240" alt="Chat list grouped by date">
</p>

## Why Facet

- **Any key, any model.** Model lists are fetched live from each provider. Capabilities such as
  vision, reasoning levels, web search and context size come from provider metadata where it
  exists, so the app only shows controls a model supports.
- **Full control.** Reasoning effort (none → max), streamed reasoning summaries, verbosity,
  OpenAI pro mode, Anthropic fast mode, web search with citations, temperature, output limits,
  and per-chat instructions.
- **Private by construction.** Chats, attachments, assistants, prompts, settings and API keys are
  encrypted on the device before they sync. The sync server stores ciphertext it can't read,
  and never sees your password. Model requests go straight from your phone to the provider.
- **Fast and light.** Native Kotlin and Jetpack Compose. The release APK is about 3.3 MB.
- **Crafted.** One visual signature: the animated Facet gem. Everything else stays quiet.

Full feature list: [docs/PLAN.md](docs/PLAN.md).

## Repository

| Path | What it is |
|---|---|
| [`android/`](android/README.md) | The Android app (Kotlin, Compose, Room, OkHttp) |
| [`server/`](server/README.md) | Zero-knowledge sync server (Node.js 22, Fastify, SQLite) |
| [`web/`](web/README.md) | The public website for facet.dtsoftware.io |
| [`deploy/`](docs/DEPLOY.md) | Docker Compose + Caddy for hosting site, downloads and sync on one host |
| [`brand/`](brand/README.md) | Logo, wordmark and icon sources |
| [`docs/`](docs/) | Plan, API contract, security model, design system, deployment guide |

## Quick start

**Run the sync server locally**

```sh
cd server
npm install
cp .env.example .env
npm run dev          # http://localhost:8787/v1/health
npm test
```

**Build the Android app** (JDK 17+ and the Android SDK; see [android/README.md](android/README.md))

```sh
cd android
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # unit, crypto-vector and screenshot tests
```

To point a debug build at your local server, open **Settings → Account → Sync server** before
signing in and enter `http://10.0.2.2:8787` (emulator) or your computer's LAN address.

**Deploy to facet.dtsoftware.io:** follow [docs/DEPLOY.md](docs/DEPLOY.md).

## Security

The design is documented in [docs/SECURITY.md](docs/SECURITY.md): PBKDF2-SHA256 (600k) and
HKDF key derivation on the device, a random vault key wrapped by your password and by a
one-time recovery code, AES-256-GCM for every record and file with the record id bound as
associated data, and rotating refresh tokens with theft detection. Test vectors in
[docs/test-vectors.json](docs/test-vectors.json) keep the Kotlin client and the TypeScript
reference implementation byte-for-byte compatible.

## License

Apache License 2.0. See [LICENSE](LICENSE). Third-party notices are listed in the app under
**Settings → About → Open-source licenses**.
