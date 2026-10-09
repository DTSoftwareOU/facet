# Facet Sync API (v1)

Base URL: `https://facet.dtsoftware.io` (self-hosters: any origin). All bodies are JSON
(`Content-Type: application/json`) except blob upload/download. All binary fields are
standard base64 with padding (`b64`). Timestamps are Unix epoch **milliseconds** (integers).

Authenticated endpoints require `Authorization: Bearer <accessToken>`.

## Errors

Every non-2xx response has this body:

```json
{ "error": { "code": "invalid_credentials", "message": "Email or password is incorrect." } }
```

| HTTP | code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Validation failed (`message` says which field) |
| 401 | `unauthorized` | Missing/expired/invalid access token — client should refresh |
| 401 | `invalid_credentials` | Wrong email/password/recovery code |
| 401 | `invalid_refresh_token` | Refresh token unknown, expired, or reused (session revoked) |
| 403 | `registration_closed` | Server does not accept new accounts |
| 404 | `not_found` | Resource missing |
| 409 | `email_taken` | Register with an existing email |
| 413 | `too_large` | Record/blob/batch over limit |
| 413 | `quota_exceeded` | Blob storage quota exceeded |
| 429 | `rate_limited` | Slow down; `Retry-After` header in seconds |
| 501 | `email_disabled` | SMTP isn't configured on this server |
| 500 | `internal` | Server error |

Leniency: a JSON request with an empty body is treated as `{}`; `device` may be omitted
(defaults to `{ "name": "Unknown device", "platform": "other" }`, and unknown platforms become
`other`); base64 input may omit padding.

## Common shapes

```ts
type Kdf = { algorithm: "pbkdf2-sha256"; iterations: number; salt: b64 /* 16 bytes */ };

type User = {
  id: string;            // uuid
  email: string;
  displayName: string | null;
  createdAt: number;
  storage: { usedBytes: number; quotaBytes: number };   // encrypted blob bytes vs. blob quota
};

type Tokens = {
  accessToken: string;
  accessExpiresAt: number;   // ms
  refreshToken: string;
  sessionId: string;
};

type Device = { name: string /* ≤ 80 chars, e.g. "Pixel 9 Pro" */; platform: "android" | "web" | "other" };
```

Validation: `email` ≤ 254 chars, contains `@`, lowercased and trimmed by the server.
`authHash` = 32 bytes. `wrappedVaultKey` = 61 bytes. `kdf.iterations` between 100000 and
5000000. `kdf.salt` = 16 bytes. `displayName` ≤ 80 chars.

## Meta

### `GET /v1/health`
`200 {"ok": true}`

### `GET /v1/meta`
```json
{ "name": "Facet Sync", "version": "1.0.0", "registrationOpen": true, "emailEnabled": false,
  "limits": { "maxRecordBytes": 2097152, "maxBatchRecords": 500, "maxBlobBytes": 33554432 } }
```

## Auth

### `POST /v1/auth/prelogin`
Request `{ "email": "a@b.co" }` → `200 { "kdf": Kdf }`.
Unknown emails get a deterministic fake salt and default iterations (see SECURITY.md).

### `POST /v1/auth/register`
```json
{
  "email": "a@b.co",
  "displayName": "Ada",
  "kdf": { "algorithm": "pbkdf2-sha256", "iterations": 600000, "salt": "…" },
  "authHash": "…",
  "wrappedVaultKey": "…",
  "recovery": { "authHash": "…", "wrappedVaultKey": "…" },
  "device": { "name": "Pixel 9", "platform": "android" }
}
```
→ `201 { "user": User, "tokens": Tokens }`. Errors: `email_taken`, `registration_closed`.

### `POST /v1/auth/login`
`{ "email", "authHash", "device" }` →
`200 { "user": User, "tokens": Tokens, "kdf": Kdf, "wrappedVaultKey": b64 }`.
Errors: `invalid_credentials`.

### `POST /v1/auth/refresh`
`{ "refreshToken" }` → `200 { "tokens": Tokens }`. The old refresh token stops working.
Re-use of a rotated token → `401 invalid_refresh_token` and the session is revoked.

Grace window: if the token presented is the *immediately previous* one and it was rotated less
than 30 s ago, the server assumes the client never received the response and issues a fresh
token instead of revoking (the token from the lost response becomes invalid). Clients must
serialize refresh calls (one in flight at a time) and persist the new refresh token before
using the new access token.

### `POST /v1/auth/logout` (auth)
Revokes the current session. `204`.

### `POST /v1/auth/recover/start`
`{ "email", "recoveryAuthHash" }` →
`200 { "resetToken": string, "recoveryWrappedVaultKey": b64, "kdf": Kdf }`.
`resetToken` is valid for 15 minutes, single use. Errors: `invalid_credentials`.

### `POST /v1/auth/recover/finish`
```json
{ "resetToken": "…", "kdf": Kdf, "authHash": "…", "wrappedVaultKey": "…",
  "recovery": { "authHash": "…", "wrappedVaultKey": "…" }, "device": Device }
```
→ `200 { "user": User, "tokens": Tokens }`. Revokes all previous sessions. Records are kept.

### `POST /v1/auth/reset/request`
`{ "email" }` → always `202 {}` (doesn't reveal existence). Sends a 8-digit code valid for
30 minutes when the account exists. `501 email_disabled` if SMTP isn't configured.

### `POST /v1/auth/reset/confirm`
```json
{ "email": "…", "code": "12345678", "kdf": Kdf, "authHash": "…", "wrappedVaultKey": "…",
  "recovery": { "authHash": "…", "wrappedVaultKey": "…" }, "device": Device }
```
→ `200 { "user": User, "tokens": Tokens }`. **Deletes all records and blobs**, revokes all
sessions, resets the change cursor to 0. Max 5 wrong codes then the code is invalidated.

## Account (auth)

### `GET /v1/account` → `200 { "user": User }`

### `PATCH /v1/account`
`{ "displayName": string | null }` → `200 { "user": User }`

### `POST /v1/account/password`
```json
{ "currentAuthHash": "…", "kdf": Kdf, "authHash": "…", "wrappedVaultKey": "…" }
```
→ `200 { "tokens": Tokens }` (a new session for the caller); all other sessions are revoked.

### `POST /v1/account/recovery`
`{ "currentAuthHash": "…", "recovery": { "authHash": "…", "wrappedVaultKey": "…" } }` → `204`.

### `DELETE /v1/account`
`{ "currentAuthHash": "…" }` → `204`. Deletes the user, sessions, records, blobs.

### `GET /v1/sessions`
```json
{ "sessions": [ { "id": "…", "deviceName": "Pixel 9", "platform": "android",
  "createdAt": 0, "lastSeenAt": 0, "ip": "203.0.113.4", "current": true } ] }
```

### `DELETE /v1/sessions/:id` → `204` (can't be the current session — use logout).

### `DELETE /v1/sessions` → `204` revokes every session except the current one.

## Sync (auth)

A **record** is an encrypted entity. The server assigns each accepted write a per-user,
strictly increasing `seq`.

```ts
type RecordIn = {
  id: string;          // client-generated, 1..64 chars [A-Za-z0-9_-]
  type: string;        // 1..24 chars [a-z_]: conv, msg, asst, folder, prompt, provider, settings, att
  updatedAt: number;   // client clock, ms — last-writer-wins key
  deleted: boolean;    // tombstone (ct may be null when deleted)
  ct: b64 | null;      // envelope, see SECURITY.md
};
type RecordOut = RecordIn & { seq: number };
```

### `POST /v1/sync/push`
`{ "records": RecordIn[] }` (max 500 records, 8 MiB body) →

```json
{ "accepted": [ { "id": "…", "type": "conv", "seq": 42 } ],
  "rejected": [ { "id": "…", "type": "msg", "reason": "stale", "current": RecordOut } ],
  "cursor": 42 }
```

Rules per record, keyed by `(type, id)`:
- Not present → insert.
- Present and `incoming.updatedAt >= stored.updatedAt` → overwrite (new `seq`).
- Present and older → `rejected` with `reason: "stale"` and the current server copy.
- A tombstone stays a tombstone unless a strictly newer non-deleted write arrives.
- `cursor` is the user's current max `seq` after the batch.

### `GET /v1/sync/pull?since=<seq>&limit=<n>`
`limit` default 500, max 1000. Returns records with `seq > since` ordered by `seq`:

```json
{ "records": RecordOut[], "cursor": 57, "hasMore": false }
```

`cursor` = seq of the last returned record (or `since` if none). Tombstones older than 180
days may be purged; if `since` is older than the purge horizon the server responds with
`"reset": true` and the client should perform a full pull from 0.

`reset` details: the response is `{ "records": [], "cursor": 0, "hasMore": false, "reset": true }`
(the `reset` key is absent otherwise). It is also returned when `since` is greater than the
user's current cursor (e.g. after an email reset wiped the account). After a reset the client
pulls from 0 and treats any local, non-dirty synced entity that the full pull didn't return
as deleted. `since=0` never triggers a reset.

Push notes: an identical retry (same `updatedAt`, `deleted` and `ct` bytes) is accepted with
the record's existing `seq` and doesn't advance the cursor. `ct` must be a version-1 envelope
(first byte `0x01`, ≥ 30 bytes); `ct` may be `null` only when `deleted` is true. A `deleted`
write at the same `updatedAt` as a live record wins the tie.

### `GET /v1/sync/stream` (Server-Sent Events)
Auth via header. Events:

```
event: ready
data: {"cursor": 57}

event: changed
data: {"cursor": 58}
```

plus `: ping` comments every 25 s. Fired after any push for that user (from any session).

Only `event:` and `data:` fields and `:` comments are sent (no `id:`/`retry:`). An invalid
token gets a normal `401` JSON error before any stream starts. The server ends the stream
when the session is revoked (logout, password change, revoke) or the server shuts down;
clients reconnect with backoff, refreshing the access token first on `401`, and pull from
their cursor after each `ready`.

## Blobs (auth)

### `PUT /v1/blobs/:id`
Raw body (`application/octet-stream`), encrypted blob (SECURITY.md). `id` 1..64 chars
`[A-Za-z0-9_-]`. → `201 { "id", "size" }`. Re-uploading the same id replaces it.
Errors: `too_large`, `quota_exceeded`.

### `GET /v1/blobs/:id` → raw bytes, `200`, `Content-Type: application/octet-stream`.

### `DELETE /v1/blobs/:id` → `204` (also when the blob doesn't exist).

## Server configuration (environment)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | SQLite file + blobs directory |
| `JWT_SECRET` | — (required, ≥ 32 chars) | Access token signing |
| `SERVER_SECRET` | — (required, ≥ 32 chars) | Fake prelogin salts, misc HMACs |
| `PUBLIC_URL` | `http://localhost:8787` | Used in emails |
| `REGISTRATION_OPEN` | `true` | Allow sign-ups |
| `BLOB_QUOTA_BYTES` | `2147483648` | Per-user blob quota |
| `TRUST_PROXY` | `true` | Read client IP from `X-Forwarded-For` (`true` = trust one proxy hop, `false` = ignore, or a hop count) |
| `SMTP_URL` | — | e.g. `smtps://user:pass@smtp.example.com:465`; enables email reset |
| `SMTP_FROM` | `Facet <no-reply@dtsoftware.io>` | Sender |
| `LOG_LEVEL` | `info` | pino level |
| `AUTH_RATE_LIMIT_PER_IP` | `10` | Sign-in/sign-up/recovery attempts per IP per 15 min (raise for shared NATs or local testing) |
