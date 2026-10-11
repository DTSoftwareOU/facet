# Facet Security Model

Facet's sync server is **zero-knowledge**: it stores account metadata and ciphertext. It can
never read conversations, attachments, assistants, prompts, settings or API keys, and it never
receives the user's password.

## Threat model

| Protected against | How |
|---|---|
| Server database leak | Content is AES-256-GCM ciphertext under a key the server never has. Login verifiers are scrypt hashes of a key derived from the password with 600k PBKDF2 rounds. |
| Malicious or compromised server operator (including us) | Same as above; the password and vault key never leave the client. The operator can see only: the account email, how many records exist with their padded sizes and change times, signed-in device names, and IP addresses. Record types and ids are opaque, content lengths are padded, and display names live inside the encrypted settings. |
| Network attacker | TLS (Caddy, automatic HTTPS). Ciphertext is authenticated (GCM) and bound to its record id and type via AAD, so records can't be swapped. |
| Stolen phone (locked) | Android full-disk encryption; API keys and the vault key are additionally wrapped with a non-exportable Android Keystore key; optional biometric app lock. |
| Stolen Windows PC (signed out of Windows) | API keys, tokens and the vault key are sealed with Windows DPAPI (Electron `safeStorage`), tied to the Windows account. |

Not protected: a compromised unlocked device, or a malicious build of the app. LLM requests
go straight to the chosen provider under that provider's own privacy terms.

**The web app** (`/app/`) runs the same client code and the same cryptography, so the server
still only ever receives ciphertext. One difference is inherent to websites: the code is
delivered by the server on every visit, so a malicious or compromised operator could serve
modified code to a specific user. The installed apps (Android, Windows) don't have this
exposure: their code is on the device and only changes when you install an update. The web
app is served with a strict Content-Security-Policy (no inline or third-party scripts), but
for the strongest guarantee use an installed app.

## Primitives

- Text encoding: UTF-8. Passwords are normalized with Unicode NFKC before use.
- Base64: standard alphabet with padding for all binary fields in JSON (`b64`).
- KDF: PBKDF2-HMAC-SHA256, 32-byte output, iterations stored per user (default **600000**),
  16-byte random salt.
- HKDF: HKDF-SHA256 (RFC 5869) with an empty salt (32 zero bytes), 32-byte output.
- AEAD: AES-256-GCM, 12-byte random nonce, 16-byte tag.
- Random: `SecureRandom` (Android) / `crypto.randomBytes` (server).

## Keys

```
password ──PBKDF2(salt, iters)──► masterKey (32B, never stored, never sent)
masterKey ──HKDF(info="facet:auth:v1")──► authKey  (sent to server as authHash)
masterKey ──HKDF(info="facet:wrap:v1")──► wrapKey  (wraps the vault key)

vaultKey  = 32 random bytes generated once at sign-up (encrypts all user data)

recoveryCode = 20 random bytes, shown as Crockford base32 (32 chars, 8 groups of 4)
recoveryCode ──HKDF(info="facet:recovery-auth:v1")──► recoveryAuthKey (sent as recovery authHash)
recoveryCode ──HKDF(info="facet:recovery-wrap:v1")──► recoveryWrapKey
```

### Wrapped vault key format (`wrappedVaultKey`, b64)

```
version (1 byte = 0x01) || nonce (12) || AES-GCM(key, vaultKey, aad) (32 + 16 tag)
total = 61 bytes  →  b64 length 84
```

- Password wrap: key = `wrapKey`, aad = ASCII `facet:vault-key:v1`.
- Recovery wrap: key = `recoveryWrapKey`, aad = ASCII `facet:vault-key-recovery:v1`.

### Recovery code text format

Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 20 bytes → 32 characters,
grouped `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`. On input, uppercase, strip spaces/dashes,
map `O→0`, `I→1`, `L→1`, `U` is invalid.

## Server-side verifier

The server treats `authHash` (32 bytes) as an opaque high-entropy secret:

```
verifier = scrypt(authHash, salt=16 random bytes, N=16384, r=8, p=1, keylen=32)
```

stored with its salt; compared with `timingSafeEqual`. The recovery `authHash` is stored the
same way in separate columns.

`POST /v1/auth/prelogin` returns the KDF parameters for an email. For unknown emails it returns
a deterministic fake salt `HMAC-SHA256(SERVER_SECRET, "prelogin:" + lowercase(email))[0..16]`
and the default iteration count, so account existence isn't revealed.

## Record encryption

Every synced entity is a JSON document encrypted with `vaultKey`:

```
envelope = version (0x01) || flags (1 byte) || nonce (12) || AES-GCM(vaultKey, body, aad)
flags bit0 = body is raw DEFLATE (RFC 1951, no zlib header) compressed JSON
           (clients compress when JSON is larger than 1 KiB)
flags bit1 = body is length-framed and padded: u32 big-endian length || data || zero padding,
           total = max(256, length + 4) rounded up with Padmé (PETS 2019): ≤ 12% overhead,
           at most O(log log n) bits of length revealed
           (clients compress JSON larger than 200 bytes when that saves space)
aad      = ASCII "facet:rec:v1:" + wireType + ":" + wireId
```

Transported as `ct` (b64). The server validates only: b64 decodes, length ≥ 30 bytes,
first byte = 0x01, size ≤ 2 MiB decoded.

### Opaque record addressing (metadata protection)

The server must not learn what kind of thing a record is, when it was created, or how long it
is. Clients therefore never send logical types or local ids:

```
recordIdKey = HKDF(vaultKey, info="facet:record-id:v1")
wireType    = "e"                                              (every record)
wireId      = base64url-nopad( HMAC-SHA256(recordIdKey, "rec:" + type + ":" + localId)[0..24] )
body        = JSON { "t": type, "i": localId, "d": payload }   (payload omitted for deletions)
```

- Local ids are time-sortable; the HMAC hides that from the server, and differs per account.
- On open, clients recompute `wireId` from the decrypted `t`/`i` and reject a mismatch, so a
  server can't move a record to another id.
- Deletions carry an encrypted body too (with `d` omitted), so other devices know what to delete.
- All records are padded (flags bit1, Padmé), so sizes reveal only a coarse bucket.
- The display name is stored in the encrypted settings record; registration sends
  `displayName: null`.
- `SyncEndToEndTest` scans the server's database and blob files after a sync and fails if any
  message text, title, key, token, skill or name appears in readable form.

## Blob (attachment) encryption

```
blob v1 = 0x01 || nonce (12) || AES-GCM(vaultKey, fileBytes, "facet:blob:v1:" + blobId)
blob v2 = 0x02 || flags (1) || nonce (12) || AES-GCM(vaultKey, body, "facet:blob:v2:" + flags + ":" + blobId)
          flags bit0 = body is raw DEFLATE of the file (used for text, PDF, WAV… when it saves space)
blobId  = base64url-nopad( HMAC-SHA256(recordIdKey, "blob:" + attachmentId)[0..24] )
```

The v2 flags are bound into the AAD, so a server can't flip them. Uploaded as raw
`application/octet-stream`. Max 32 MiB per blob. One per-user quota covers records and blobs
(default 100 MiB, `USER_QUOTA_BYTES`). Before upload, clients also shrink generated media:
large renders are re-encoded as WebP and raw WAV as AAC. When the quota is full, clients delete
the server copies of the oldest files they hold locally (unless the user turns this off); those
files stay on every device that has a copy, and their records sync with `uploaded: false`. A file
that still doesn't fit waits on its device and uploads once there's room.

## Local storage on Android

- A non-exportable AES-256-GCM key `facet_local_v1` lives in the Android Keystore.
- The vault key and every API key are stored encrypted with it (`v1:` + b64(nonce||ct)).
- Session tokens are stored the same way.
- MCP server headers and OAuth tokens are sealed the same way locally and travel only inside
  encrypted records.
- Conversations live in the app's private Room database (protected by Android file-based
  encryption). Optional biometric app lock and `FLAG_SECURE` app-switcher hiding.

## Local storage on Windows and the web

The Windows app and the web app share one TypeScript client (`client/`); the Windows app wraps
it in Electron (`desktop/`).

- Data lives in the browser engine's IndexedDB: chats, messages, files (as blobs), providers,
  MCP servers, skills and settings, the same tables as the Android Room database.
- Secrets (vault key, refresh and access tokens, API keys, MCP headers and OAuth state) are sealed
  before they're stored. **Windows:** DPAPI through Electron `safeStorage` (`d1:` prefix; if DPAPI
  is unavailable, AES-256-GCM with a random key in the app's data folder, `d0:`). **Web:** AES-256-GCM
  with a non-extractable Web Crypto key kept in IndexedDB (`v1:`), so page scripts can use it but
  can't read it out.
- Open tabs and windows share one session. Token refreshes are serialized with a Web Lock and
  re-read storage, so two tabs never present the same rotated refresh token. One tab keeps the
  change stream open; every tab sees changes through the shared database.
- Model, MCP and search requests go straight from the browser or the Windows app to the provider.
  On the website the browser enforces CORS, so providers that don't allow web pages (marked
  "Windows and Android only" in the app) can't be used there. When the page reader can't load a
  page directly in the browser, it reads it through Jina Reader (`r.jina.ai`), which sees the page
  address (not the chat); the tool result says so.

## Computer access (Windows app)

Models can use the computer through local tools: `run_command` (PowerShell), `read_file`,
`write_file`, `edit_file`, `list_directory`, `glob`, `grep`, `open_path` and background-process
helpers. They run in the app's main process, in each chat's working folder, and never pass
through the sync server.

- By default, reading and searching files runs without asking; commands and file changes show an
  approval card with the exact command or edit ("Allow", "Allow for this chat", "Deny"). The user
  can require approval for everything, or nothing; YOLO mode skips approvals.
- The renderer reaches these tools only through the preload's narrow `window.facetDesktop` API.
  The window runs with context isolation, a sandboxed preload, no Node integration, a strict CSP,
  no navigation away from the app, and every IPC message is checked against the app's origin.
- Local MCP servers (stdio) are started the same way and stay on that computer: their rows are
  never synced.

## Using a PC from other devices

The account's other devices can use a PC running the Windows app (docs/REMOTE.md). Requests and
results travel through the sync server's relay as envelopes sealed with
`HKDF(vaultKey, "facet:relay:v1")` (AES-256-GCM, fresh random nonce). The AAD binds the sender's
and recipient's session ids, so the server can't relabel or redirect a message; messages carry an
id and a timestamp, and receivers drop replays (same id within 20 minutes) and stale messages
(more than 10 minutes off).

- **What the server learns:** which of the account's sessions are online, which session sends to
  which, when, and how large each envelope is. It never sees commands, file contents, folder
  names or results, and it keeps nothing: envelopes are forwarded to open streams and dropped.
- **Who can use a PC:** only sessions of the same account (the server routes nothing across
  accounts), and only after the PC's owner switches on "Let your other devices use this PC" (off
  by default, stored in the PC's own settings, never synced). A stolen password alone therefore
  can't run commands on a PC whose owner hasn't allowed it; someone who has the password *and*
  finds remote use on can, like the owner could. The PC answers `hello` while remote use is off
  so controllers can explain how to turn it on, and notifies its owner when a device is refused.
- **Approvals** happen on the device that drives the chat, with its own "Ask before" setting;
  YOLO mode skips them, as for local tools. The PC shows the last remote use in its tray tooltip.
- Folder browsing returns folder names only, and Claude Code / Codex imports read only the
  session files of the requested folder (ids are validated; no arbitrary paths).

## Flows

### Sign up
1. Client generates `salt`, `vaultKey`, `recoveryCode`.
2. Derives `masterKey → authKey, wrapKey`; wraps vault key both ways.
3. `POST /v1/auth/register` with `authHash`, `kdf`, `wrappedVaultKey`, `recovery{authHash, wrappedVaultKey}`.
4. Shows the recovery code; the user confirms they saved it.

### Sign in
1. `POST /v1/auth/prelogin {email}` → `kdf`.
2. Derive keys, `POST /v1/auth/login {email, authHash}` → tokens + `wrappedVaultKey`.
3. Unwrap the vault key with `wrapKey` (GCM failure = wrong password; the server would
   already have rejected it).

### Change password
Client re-derives with a new salt, re-wraps the same `vaultKey`, sends
`currentAuthHash, kdf, authHash, wrappedVaultKey`. Data is untouched. Other sessions are
revoked.

### Forgot password — recovery code (keeps data)
1. `POST /v1/auth/recover/start {email, recoveryAuthHash}` → `resetToken`,
   `recoveryWrappedVaultKey`.
2. Client unwraps with `recoveryWrapKey`, picks a new password, re-wraps, generates a new
   recovery code, `POST /v1/auth/recover/finish`.

### Forgot password — email (wipes data)
Only when SMTP is configured. `POST /v1/auth/reset/request {email}` emails a one-time link
code; `POST /v1/auth/reset/confirm` with a fresh `vaultKey` wrapping deletes every record and
blob for that account, then sets the new credentials.

## Tokens

- Access token: HS256 JWT signed with `JWT_SECRET`, 15 minutes, claims `sub` (user id),
  `sid` (session id), `iat`, `exp`.
- Refresh token: 32 random bytes (base64url), stored as SHA-256. Rotated on every refresh.
  Presenting a previously rotated refresh token revokes the whole session (theft detection),
  except within 30 s of the rotation, where it is treated as a retry after a lost response and
  a fresh token is issued instead. Sessions expire after 90 days of inactivity.

## Rate limits

Per IP and per email on auth endpoints (sliding window, in memory): prelogin 30/min,
login/register/recover 10 per 15 min per IP and 5 per 15 min per email.
