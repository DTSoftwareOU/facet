# Facet — Product Plan

**Facet** is an open-source, end-to-end encrypted AI chat app for Android, published by
DT Software (dtsoftware.io). You bring your own API keys — OpenAI, Anthropic, Google,
OpenRouter, or any OpenAI-compatible endpoint — and Facet gives every model one fast,
beautiful home that syncs across all your devices.

> One gem, many faces: every model you use is a facet of the same app.

## Positioning

| | ChatGPT / Claude apps | Facet |
|---|---|---|
| Models | One vendor | Every major vendor + any OpenAI-compatible endpoint, switchable mid-chat |
| Billing | Subscription | Pay providers directly with your own keys; live per-message cost |
| Privacy | Vendor reads your history | Chats, keys and files are end-to-end encrypted before they leave the phone |
| Source | Closed | Apache-2.0, self-hostable sync server |
| Controls | Simplified | Full reasoning effort, thinking visibility, verbosity, pro mode, web search, temperature… exposed per model, only when the model supports them |

## Pillars

1. **Any key, any model.** Model lists are fetched live from each provider. Capabilities
   (vision, reasoning levels, web search, context size) are discovered from provider metadata
   where available and inferred otherwise; the UI only shows controls a model supports.
2. **Private by construction.** Zero-knowledge sync: the server stores ciphertext only.
   See [SECURITY.md](SECURITY.md).
3. **Fast and light.** Native Kotlin + Jetpack Compose, no web views, no heavy DI or image
   frameworks, R8-shrunk release build. Streaming text is smoothed to a steady cadence and
   rendered block-by-block so long answers never stutter.
4. **Crafted.** A single visual signature (the animated Facet gem), restrained chrome, motion
   that answers what you do. See [DESIGN.md](DESIGN.md).

## Feature list (v1.0)

### Chat
- Streaming responses with cadence smoothing and a live cursor.
- Rich Markdown: headings, lists, task lists, tables (horizontal scroll), block quotes, links,
  inline code, fenced code with syntax highlighting, language label, copy and wrap toggle,
  and LaTeX math (inline and block).
- Reasoning panel: live "Thinking" state with the gem animation, streamed reasoning summaries,
  "Thought for 14s" collapsible after completion.
- Web search toggle (OpenAI `web_search`, Anthropic `web_search` server tool, OpenRouter
  web plugin) with numbered citation chips that open sources.
- Attachments: camera, photo picker, files (images, PDF, text/code). Images are downscaled
  and re-encoded on device before upload. Share-to-Facet from any app.
- Message actions: copy, select text, share, read aloud (system TTS), regenerate,
  regenerate with a different model, edit and resend, delete.
- Branching: editing or regenerating creates a branch; `‹ 2/3 ›` switches between them.
- Stop generation; "Continue" when a response hits the output limit.
- Per-chat model switching and a parameters sheet (effort, thinking visibility, verbosity,
  pro mode, fast mode, temperature, max output, web search, system prompt).
- Automatic chat titles (configurable model).
- Token usage and estimated cost per message and per chat (tap for the breakdown,
  including cached and reasoning tokens).
- Voice input via the system speech recognizer.
- Prompt library: type `/` in the composer to insert a saved prompt.
- Responses keep generating when you leave the screen or background the app
  (foreground service with a progress notification; "Response ready" notification).
- Self-healing requests: if a provider rejects a parameter for a given model, Facet drops
  that parameter, remembers the quirk for that model, and retries once.

### Organization
- Drawer with chats grouped by Today / Yesterday / Previous 7 days / Previous 30 days / month.
- Full-text search across all messages (SQLite FTS4) with highlighted snippets.
- Pin, rename, move to folder, archive, delete (with undo), multi-select.
- Folders with colors.
- Export a chat as Markdown or JSON; export everything as JSON.

### Assistants
- Built-in assistants: Facet (general), Code, Writer, Tutor, Translator, Analyst.
- Custom assistants: name, emoji, color, instructions, default model and parameters,
  conversation starters.
- Custom instructions ("About you" + "How to respond") applied to every chat.

### Providers and keys
- Presets: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI,
  Together, Perplexity, Fireworks, Cerebras, Ollama, LM Studio, Custom (OpenAI-compatible:
  base URL, key, extra headers).
- Multiple keys per provider with labels ("Personal", "Work").
- Test connection, refresh models, add model IDs manually, favorite models,
  per-model capability overrides.
- Keys are encrypted at rest with an Android Keystore key and synced end-to-end encrypted.
- Live pricing table (public OpenRouter model feed, cached daily, can be turned off) plus
  built-in prices for first-party models.

### Account and sync
- Optional account: use Facet fully offline as a guest; create an account any time and
  local data is uploaded encrypted.
- Email + password with client-side key derivation (server never sees the password).
- Recovery code shown at sign-up (copy, save to file, share); regenerate any time.
- Forgot password: reset with the recovery code (keeps data) or by email (wipes encrypted
  data, keeps the account).
- Change password, manage signed-in devices, sign out everywhere, delete account.
- Sync: offline-first, incremental pull/push with server change cursor, live updates over
  Server-Sent Events while open, periodic background sync, encrypted attachment blobs.
- Custom sync server URL for self-hosters.

### Personalization and system
- Theme: System / Light / Dark / Black (AMOLED); optional Material You colors.
- Chat text size, line density, send-on-Enter, haptics, reduced motion.
- App lock with biometrics / device credential; hide content in the app switcher.
- Edge-to-edge, predictive back, keyboard-synchronized composer, tablet/foldable two-pane
  layout, launcher shortcuts (New chat, Voice chat), themed (monochrome) icon.
- Animated splash, guided onboarding (account choice → first key → first chat).

## Architecture summary

See [ARCHITECTURE.md](ARCHITECTURE.md) for detail.

```
android/   Kotlin, Jetpack Compose, Room (FTS), OkHttp, kotlinx.serialization
server/    Node.js 22 + TypeScript, Fastify, SQLite (node:sqlite), zero-knowledge sync
web/       Static landing site for facet.dtsoftware.io (privacy policy, terms, download)
brand/     Logo, icon, palette sources
docs/      This plan, API contract, security model, design system, deployment
```

- LLM calls go **directly from the phone to the provider**. The Facet server never proxies
  model traffic and never sees keys or messages in plaintext.
- Default sync server: `https://facet.dtsoftware.io` (configurable in the app).

## Roadmap after v1.0
- Side-by-side model comparison (send one prompt to two models).
- Image generation outputs (OpenAI image tool, Gemini image models).
- MCP / custom tool calling.
- Home-screen widget and Quick Settings tile.
- Web client sharing the same encrypted sync protocol.
