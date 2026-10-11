# Using your PC from your other devices

When the Facet app for Windows is running and signed in, the account's other devices (the
Android app, the web app) can use that PC: run commands and read and edit files in a folder on
it, browse its folders, and continue Claude Code and Codex sessions from those folders. The PC is
the **host**; the phone or browser is the **controller**. When no host is online, controllers
work as a normal chatbot.

Messages between devices go through the sync server's relay, **end-to-end encrypted** with a key
derived from the vault key. The server routes ciphertext between sessions of the same account; it
can't read or forge messages. A PC only accepts requests after its owner switches on **Let your
other devices use this PC** (off by default), so a stolen password alone can't run commands on it.

## Server API

`GET /v1/sync/stream` (existing) carries two more events:

| Event | Data | Meaning |
|---|---|---|
| `presence` | `{"sessionId":"…","online":true}` | Another session of this account opened its first stream (`true`) or closed its last (`false`). |
| `relay` | `{"from":"<sessionId>","msg":"<base64>"}` | An encrypted message for this session. |

`GET /v1/relay/peers` → `{"peers":[{"sessionId":"…","deviceName":"…","platform":"android|web|windows|other"}]}` —
the account's other sessions that have an open stream right now.

`POST /v1/relay` with `{"to":"<sessionId>","msg":"<base64 envelope>"}` → `{"delivered":n}` (n ≥ 1).
Errors: `404 peer_offline` (no open stream for that session in this account), `413` (envelope over
4 MiB), `400` (not a v1 envelope), `429` (more than 1,200 messages a minute from one session).

Sessions may now report the platform `windows` (older servers store it as `other`). A client knows
its own session id from `tokens.sessionId` in the sign-in and refresh responses.

## Envelope

```
relayKey = HKDF-SHA256(ikm = vault key, salt = 32 zero bytes, info = "facet:relay:v1", L = 32)
envelope = 0x01 || flags (1 byte) || nonce (12 random bytes) || AES-256-GCM(relayKey, nonce, body, aad)
aad      = ASCII "facet:relay:v1:{flags}:{from}:{to}"      flags in decimal, from/to = session ids
body     = the message as UTF-8 JSON; when longer than 1,024 bytes it is raw-DEFLATEd (flags bit 0)
           if that makes it smaller
```

The sender's and recipient's session ids are bound into the AAD, so the server can't relabel a
message. Receivers drop envelopes that don't decrypt, whose `ts` is more than 10 minutes from their
clock, or whose `id` they saw in the last 20 minutes.

**Test vectors** (client/src/sync/relay.test.ts; the Android tests use the same): vault key = bytes
`0x00 … 0x1f`, nonce = twelve `0x07` bytes, from = `sessA`, to = `sessB`.

- Body `{"v":1,"id":"msg-0001-abcdefgh","ts":1760000000000,"type":"hello"}` (not compressed) →
  `AQAHBwcHBwcHBwcHBwco5etj3MZ1O0AcAYo6sg/2ELJhqlNKT/V8JWweomY3ddGCWQ6K2Dn7CCxx06k3ySjLkqvv6vzL1T0QUn+wsi0+XeSV3sIe45wvWXrITrhvlBJQ`
- Compressed (DEFLATE output differs between libraries, so only decrypt this one):
  `AQEHBwcHBwcHBwcHBwe+DKxPJMdVX8jD38My+nCxRGVHtsMSZdNX0eosh1v6l/Xqqv3fEbh6WRlEZK2GCXAwQjryknSB/iMFRy+93cSCruZ5ZiATT4coRQlPofP7bYINaThOj42w3awQsPui/0pbvUQwLLjrxVPTOAGOzvH9bLFpGwAm9KkZfEr5BhC5pdGilLSDVTQkbM4=`
  decrypts to a `result` message whose `value.content` is `"line\n"` repeated 400 times.

## Messages

Every message is a JSON object with `v` (1), `id` (random, at least 16 characters), `ts` (sender
clock, ms since the epoch) and `type`.

**Controller → host**

- `{"type":"hello"}` — the host answers with `host`.
- `{"type":"call","method":"…","params":{…}}` — the host answers with `result` (`re` = the call's id).
- `{"type":"cancel","re":"<call id>"}` — best effort: stops a running `computer.call`.

**Host → controller**

- `host` — answers `hello` (with `re`), and is also sent unsolicited to every online peer when the
  app starts or remote access is switched on or off:

  ```json
  {"type":"host","re":"…","hostId":"…","name":"OFFICE-PC","os":"Windows 11","version":"1.1.0",
   "remote":true,"home":"C:\\Users\\alex","defaultFolder":"C:\\Users\\alex\\Documents",
   "recentFolders":["C:\\Users\\alex\\Desktop\\Projects\\app"],"features":["computer","files","claude","codex"]}
  ```

  `hostId` is a random id that identifies this Windows install across sign-ins. `remote` is false
  until the owner allows remote use; controllers then show how to switch it on.
- `{"type":"result","re":"<call id>","ok":true,"value":…}` or
  `{"type":"result","re":"…","ok":false,"error":{"code":"…","message":"…"}}`. Codes: `remote_disabled`,
  `bad_request`, `not_found`, `unknown_method`, `too_large`, `failed`.

**Methods**

| Method | Params | Value |
|---|---|---|
| `computer.info` | — | `{"os","shell","home","user","hostname"}` |
| `computer.tools` | — | `[{"name","description","inputSchemaJson","readOnly"}]` (`inputSchemaJson` is a JSON string) |
| `computer.call` | `{"name","argumentsJson","cwd","callId"}` | `{"content","isError","label"?}` — the tool result as the model sees it |
| `computer.cancel` | `{"callId"}` | `{}` |
| `files.list` | `{"path":null\|"…"}` | `{"path","parent","folders":[{"name","path"}],"places":[{"name","path"}]}` |
| `agents.list` | `{"agent":"claude"\|"codex","cwd":"…"}` | `{"sessions":[{"id","title","updatedAt","messageCount"}]}` newest first, at most 50 |
| `agents.read` | `{"agent","cwd","id"}` | `{"id","title","cwd","updatedAt","messages":[{"role":"user"\|"assistant","text","at"?}],"truncated"}` |

`files.list` returns only folders (sorted case-insensitively, hidden and system folders skipped).
With `path: null` it returns `places` (home, Desktop, Documents, Downloads, drives and recent chat
folders) and no `folders`; `path`/`parent` are null there. A call on a missing folder fails with
`not_found`.

Controllers wait up to 20 seconds for `computer.info`, `computer.tools`, `files.list` and
`agents.list`, 60 seconds for `agents.read`, and 15 minutes for `computer.call` (commands have
their own timeouts on the host). A `404 peer_offline` from `POST /v1/relay` means the host went
away: fail the call at once and treat the host as offline.

## Discovery

Controllers keep the online hosts in memory:

1. When the stream sends `ready`, call `GET /v1/relay/peers` and send `hello` to every peer.
2. On `presence` with `online: true`, send `hello` to that session; with `online: false`, forget
   the hosts on that session.
3. A `host` message (answer or unsolicited) adds or updates the host, keyed by `hostId` (the newest
   session wins). Only Windows apps answer `hello`.

Hosts answer `hello` even when remote use is off (with `remote: false`) so the controller can say
how to turn it on. The PC also shows a notification the first time in a session that a device
reaches it while remote use is off.

Controllers keep their stream open while they wait for a result, even in the background.

## Chats that work in a PC folder

Conversation records gain two optional, synced fields:

- `computerHost` — the `hostId` of the PC the chat works on, or absent.
- `computerFolder` — the folder on that PC (an absolute path).

On that PC the chat's working folder is `computerFolder`. On other devices the chat offers the
PC's computer tools while that host is online with remote use on, and works without them
otherwise. In the Windows app, picking a folder for a chat sets both fields to the PC's own
`hostId` and the folder. A chat without these fields uses the Windows app's default folder there
and no PC elsewhere until the user picks one.

Controllers run the tool loop themselves: the model is called from the phone or browser with the
user's keys; only the tools run on the PC. Approvals are shown on the controller, by its own
setting **Your PC → Ask before** (`ALWAYS` = every action, `WRITES` = anything that changes the
PC, the default; `NEVER`), which YOLO mode overrides like other tools. The host runs what an
authenticated device of the account asks once remote use is on.

The system prompt addendum is the same as in the Windows app (registry.ts `computerAddendum`),
naming the PC: "You can use the user's computer (Windows 11, OFFICE-PC) through the computer
tools…".

## Slash commands

Typing `/` at the start of an empty message box opens a command list that filters as you type
(arrow keys and Enter, or tap). Built-in commands:

| Command | What it does | Shown when |
|---|---|---|
| `/new` | Start a new chat | always |
| `/model` | Choose the model | always |
| `/folder` | Choose the chat's working folder (on the PC, from a controller) | the chat can use a computer |
| `/pc` | Choose which PC the chat uses, or none | controllers, a host is online |
| `/resume-from-claude` | Continue a Claude Code session from the chat's folder | the chat can use a computer |
| `/resume-from-codex` | Continue a Codex session from the chat's folder | the chat can use a computer |

Saved prompts follow as `/<prompt title in kebab-case>`; picking one inserts the prompt's text.

## Continuing a Claude Code or Codex session

`/resume-from-claude` (or `-codex`) lists the sessions whose working directory is the chat's
folder. Picking one creates a new chat:

- title: the session's title; working folder: the same PC and folder;
- per-chat instructions: "This chat continues a Claude Code session from {folder}. The messages
  so far were imported from it; tool calls appear as lines starting with ›. Pick up where it left
  off.";
- messages: the imported ones as one branch, `status` DONE, assistant messages with `modelName`
  "Claude Code" (or "Codex") and no provider or model id;
- model: the one selected in the composer.

The host finds sessions here:

- **Claude Code**: `%USERPROFILE%\.claude\projects\<folder with every character other than A–Z,
  a–z and 0–9 replaced by "-">\<session id>.jsonl` (or under `CLAUDE_CONFIG_DIR`). Files whose
  lines carry a different `cwd` are skipped.
- **Codex**: `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` (or under `CODEX_HOME`),
  matched on `session_meta.payload.cwd`.

Paths are compared case-insensitively with normalized separators. Conversion keeps the user's
prompts and the assistant's replies, summarizes each tool call as one line in the reply ("› Ran
`npm test`", "› Edited src/app.ts"), and drops tool output, reasoning, system and injected context
messages. A compacted Claude Code session starts from its latest summary. At most the newest
300,000 characters are kept (`truncated` says whether older messages were dropped).

## The Windows app in the background

Settings → Computer access → **Background**:

- **Start with Windows** (on by default): starts hidden in the notification area when you sign in.
- **Keep running when closed** (on by default): closing the window keeps Facet in the notification
  area, so your other devices can reach it.

The tray icon opens Facet on click; its menu has Open Facet, Let other devices use this PC, Start
with Windows and Quit Facet.
