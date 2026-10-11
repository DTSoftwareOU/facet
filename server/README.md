# Facet Sync server

Zero-knowledge sync for Facet: accounts, sessions, encrypted records and encrypted
attachment blobs. The server never sees passwords, keys or plaintext. Contract:
[`docs/API.md`](../docs/API.md); crypto: [`docs/SECURITY.md`](../docs/SECURITY.md);
production setup: [`docs/DEPLOY.md`](../docs/DEPLOY.md).

Stack: Node.js 22, TypeScript, Fastify 5, SQLite via the built-in `node:sqlite`, zod,
nodemailer (optional SMTP). No native modules.

## Develop

```sh
npm install
cp .env.example .env      # set JWT_SECRET and SERVER_SECRET (≥ 32 chars each)
npm run dev               # http://127.0.0.1:8787, reloads on change
```

`curl http://127.0.0.1:8787/v1/health` → `{"ok":true}`.

| Script | What it does |
|---|---|
| `npm run dev` | Run from source with reload (tsx) |
| `npm test` | End-to-end tests (`node:test` + `fastify.inject`, plus a live SSE test) |
| `npm run typecheck` | Type-check sources, tests and scripts |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run vectors` | Regenerate `docs/test-vectors.json` for client crypto tests |

Configuration is environment variables (see the table in `docs/API.md`). `.env` in the
working directory is loaded automatically.

## Layout

```
src/
  index.ts          boot, signals, graceful shutdown
  app.ts            buildApp(config): Fastify instance, parsers, error envelope, hooks
  config.ts         env → Config
  db.ts             node:sqlite, WAL, migrations, transaction helper
  store.ts          users, sessions, reset tokens, housekeeping (tombstone purge)
  records.ts        last-writer-wins records and the per-user change cursor
  blobs.ts          encrypted blobs on disk with quota accounting
  crypto.ts         scrypt verifiers, HS256 JWT, tokens
  events.ts         in-process change bus for Server-Sent Events
  ratelimit.ts      sliding-window limiter
  mail.ts           optional SMTP + reset email
  auth/tokens.ts    access/refresh tokens, request authentication
  routes/           meta, auth, account (+ sessions), sync (+ stream), blobs
  backup.ts         `node dist/backup.js <file>`: consistent snapshot via VACUUM INTO
test/
  client-crypto.ts  reference client implementation of SECURITY.md
  vectors.ts        deterministic vectors shared with the Android app
  *.test.ts         end-to-end suites
```

## Data

`DATA_DIR/facet.db` (SQLite, WAL) and `DATA_DIR/blobs/<userId>/<blobId>`. Back up with
`deploy/backup.sh` or `node dist/backup.js /path/snapshot.db` plus a copy of `blobs/`.
