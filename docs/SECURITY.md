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

Not protected: a compromised unlocked device, or a malicious build of the app. LLM requests
go straight to the chosen provider under that provider's own privacy terms.

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
large renders are re-encoded as WebP and raw WAV as AAC. When the quota is full, files stay on
the device ("this device only") and only their records sync.

## Local storage on Android

- A non-exportable AES-256-GCM key `facet_local_v1` lives in the Android Keystore.
- The vault key and every API key are stored encrypted with it (`v1:` + b64(nonce||ct)).
- Session tokens are stored the same way.
- MCP server headers and OAuth tokens are sealed the same way locally and travel only inside
  encrypted records.
- Conversations live in the app's private Room database (protected by Android file-based
  encryption). Optional biometric app lock and `FLAG_SECURE` app-switcher hiding.

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
