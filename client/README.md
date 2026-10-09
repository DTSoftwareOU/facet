# Facet client (web and Windows)

The web app at `facet.dtsoftware.io/app/` and the interface of the Windows app (`../desktop`).
It speaks the same end-to-end encrypted sync protocol as the Android app, so chats, keys,
assistants, prompts, MCP servers, skills and settings follow you between all three.

TypeScript, React 19, Vite, Dexie (IndexedDB). No server-side code: model requests go straight
from the browser or the Windows app to each provider.

## Run

```sh
npm install
FACET_SYNC_URL=http://127.0.0.1:8787 npm run dev   # http://localhost:5173/app/, /v1 proxied to a sync server
npm test                                           # unit tests; the sync E2E test needs a server on :8790
npm run typecheck
npm run build                                      # dist/ for the website (base /app/)
npm run build:desktop                              # ../desktop/renderer for the Windows app (relative paths)
```

`test/sync.e2e.test.ts` registers accounts on a local server and syncs between two simulated
devices; start one with `PORT=8790 JWT_SECRET=… SERVER_SECRET=… node ../server/dist/index.js`
(set `FACET_E2E_DATA_DIR` to its data folder to also check that nothing readable is stored).
`test/android-fixture.test.ts` writes `android/app/src/test/resources/web-records.json`, which
the Android `WebRecordsCompatTest` decodes, so both apps keep one record format.

## Layout

| Path | What it is |
|---|---|
| `src/core/` | Crypto (docs/SECURITY.md on Web Crypto), bytes, ids, SSE parsing, formatting |
| `src/sync/` | Sync API client, account and keys (`auth.ts`), record codec, sync engine |
| `src/data/` | IndexedDB schema, entities, preferences, repositories (conversations, providers, library, attachments) |
| `src/llm/` | Provider adapters (Anthropic, OpenAI Responses, Chat Completions), model catalog, pricing, media generation |
| `src/mcp/`, `src/tools/` | MCP client (HTTP, legacy SSE, stdio), OAuth, MCP directory, skills, web search, tool registry |
| `src/domain/` | Chat engine (requests, tool loop, approvals, streaming, titles) and media service |
| `src/platform/` | What differs between the website and the Windows app (`window.facetDesktop`) |
| `src/ui/` | Interface: sidebar, chat, composer, Markdown, settings, account flows |

## Website limits

Browsers only let a page call APIs that allow it (CORS). OpenAI, Anthropic, Google, OpenRouter,
xAI, DeepSeek, Mistral, Groq and most others do; Fireworks, NVIDIA, SambaNova, Black Forest Labs,
Brave Search and Exa don't, and the app marks them "Windows and Android only". The Windows app
has no such limit, and adds computer tools and local MCP servers.
