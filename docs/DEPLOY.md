# Deploying Facet on facet.dtsoftware.io

This puts the website, APK downloads and the zero-knowledge sync server on one hostname:

| Path | Served by |
|---|---|
| `https://facet.dtsoftware.io/` | Static site from `web/` |
| `https://facet.dtsoftware.io/app/` | The web app, built from `client/` |
| `https://facet.dtsoftware.io/download/<file>` | Files in `deploy/downloads/` (APKs, the Windows installer) |
| `https://facet.dtsoftware.io/v1/*` | Facet Sync server (Node.js, SQLite) |

Caddy terminates TLS and renews Let's Encrypt certificates automatically. The server stores
only ciphertext (see [SECURITY.md](SECURITY.md)); model traffic never touches it.

## Requirements

- An Ubuntu 22.04/24.04 VPS (1 vCPU / 1 GB RAM is plenty to start) with a public IPv4.
- Ports 80 and 443 open (TCP, plus UDP 443 for HTTP/3).
- Access to the DNS for `dtsoftware.io`.

## 1. DNS

Create an `A` record `facet.dtsoftware.io → <server IPv4>` (and an `AAAA` record if the server
has IPv6). Wait until `dig +short facet.dtsoftware.io` returns the address; Caddy needs it to
obtain a certificate.

## 2. Install Docker

```sh
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # log out and back in afterwards
docker compose version            # should print v2.x
```

Optional firewall:

```sh
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable
```

## 3. Get the code

```sh
sudo mkdir -p /opt/facet && sudo chown "$USER" /opt/facet
git clone <your repo URL> /opt/facet
cd /opt/facet/deploy
```

## 4. Configure

```sh
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^SERVER_SECRET=.*|SERVER_SECRET=$(openssl rand -base64 48)|" .env
nano .env    # check FACET_DOMAIN, REGISTRATION_OPEN, USER_QUOTA_BYTES, optional SMTP
chmod 600 .env
```

Keep a copy of `.env` somewhere safe. Losing `JWT_SECRET` only signs everyone out; no data
depends on either secret.

## 5. Start

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f facet     # Ctrl+C to stop following
```

## 6. Verify

```sh
curl https://facet.dtsoftware.io/v1/health      # {"ok":true}
curl https://facet.dtsoftware.io/v1/meta        # name, version, registrationOpen, limits
curl -I https://facet.dtsoftware.io/            # 200 from the static site
```

In the app, the default server is `https://facet.dtsoftware.io`; create an account and check
that a chat appears on a second device.

## 7. Publish the APK

Build the release APK (see `android/README.md`), then:

```sh
scp app-release.apk you@server:/opt/facet/deploy/downloads/facet-1.0.0.apk
ssh you@server 'cd /opt/facet/deploy/downloads && cp facet-1.0.0.apk facet-latest.apk'
```

It's now at `https://facet.dtsoftware.io/download/facet-latest.apk`, served with the Android
package MIME type. Point the website's download button at that URL. No restart is needed.

## 8. Backups

`deploy/backup.sh` writes a consistent SQLite snapshot (`VACUUM INTO`) and a tar of the
encrypted blobs to `deploy/backups/`, keeping 14 days.

```sh
chmod +x /opt/facet/deploy/backup.sh
/opt/facet/deploy/backup.sh                      # test it once
crontab -e
# add:
15 3 * * * /opt/facet/deploy/backup.sh >> /var/log/facet-backup.log 2>&1
```

Copy `deploy/backups/` off the machine (rclone, restic, or your provider's snapshots).
Backups contain only ciphertext plus account metadata (emails, device names).

Restore (replace `<ts>` with the backup timestamp):

```sh
cd /opt/facet/deploy
docker compose stop facet
docker compose run --rm --user root -v "$PWD/backups:/backups:ro" --entrypoint sh facet -c '
  gunzip -c /backups/facet-db-<ts>.db.gz > /data/facet.db &&
  rm -f /data/facet.db-wal /data/facet.db-shm &&
  rm -rf /data/blobs && tar -C /data -xf /backups/facet-blobs-<ts>.tar &&
  chown -R node:node /data'
docker compose start facet
```

## 9. Updates

```sh
cd /opt/facet && git pull
cd deploy && docker compose up -d --build
docker image prune -f
```

Database migrations run automatically at startup. Website changes in `web/` are live as soon
as the files change (Caddy serves the folder directly).

## 10. Optional: email reset

Without SMTP, users who forget their password reset it with their recovery code (keeps
data). With SMTP configured they can also reset by email, which **wipes** their encrypted
data (it can't be decrypted without the old password or recovery code).

```env
SMTP_URL=smtps://user:password@smtp.example.com:465
SMTP_FROM=Facet <no-reply@dtsoftware.io>
```

Then `docker compose up -d`. `/v1/meta` reports `"emailEnabled": true`. Use a provider that
signs mail for `dtsoftware.io` (SPF/DKIM), e.g. Postmark, Resend, Amazon SES or Fastmail.

## Operations

| Task | Command |
|---|---|
| Close sign-ups | set `REGISTRATION_OPEN=false` in `.env`, `docker compose up -d` |
| Change storage quota | set `USER_QUOTA_BYTES` (default 100 MiB per user), `docker compose up -d` |
| Logs | `docker compose logs --since 1h facet` |
| Disk usage | `docker system df -v`, `docker compose exec facet du -sh /data` |
| Shell in the container | `docker compose exec facet sh` |

The server is a single process with SQLite in WAL mode; it comfortably handles thousands of
users on a small VPS. Rate limits are kept in memory, so run one replica.

## Behind an existing nginx

If the server already runs nginx on ports 80/443 (as the dtsoftware.io VPS does), skip Caddy and
use `deploy/nginx/`: the container listens on `127.0.0.1:8788` and nginx serves the site,
downloads and API.

```sh
# Code in /opt/facet (server/ and deploy/), site in /var/www/facet, APKs in /var/www/facet-downloads
cd /opt/facet/deploy/nginx
cp ../.env.example .env            # fill in JWT_SECRET and SERVER_SECRET (openssl rand -base64 48)
docker compose up -d --build
cp facet.conf /etc/nginx/sites-available/facet
ln -s /etc/nginx/sites-available/facet /etc/nginx/sites-enabled/facet
nginx -t && systemctl reload nginx
certbot --nginx -d facet.dtsoftware.io --redirect
```

The DNS records must be **DNS only** (grey cloud in Cloudflare) so certbot can validate and the
server sees real client addresses for its rate limits. Publish a new APK by replacing
`/var/www/facet-downloads/facet-latest.apk` (and its `.sha256`). Update the server with
`docker compose up -d --build` after copying the new `server/` code.

## Web app and Windows app

The web app is a static build of `client/`. It's served at `/app/` and talks to the sync API on
the same origin, so it needs no configuration. With the nginx setup above (`deploy/nginx/facet.conf`
has the `/app/` locations and the security headers):

```sh
cd client && npm ci && npm run build
rsync -a --delete dist/ root@server:/var/www/facet-web/app/
```

No restart is needed. `index.html` is served with `Cache-Control: no-cache` and the hashed
assets as immutable, so browsers pick up a new release on their next visit.

The Windows installer is built from `desktop/` (`npm run dist`, which builds `client/` for the
desktop first). Upload the installer, its `.blockmap` and `latest.yml` to
`/var/www/facet-downloads/windows/`, and point the stable download name at the new version:

```sh
cd desktop/release
scp Facet-Setup-1.0.0.exe Facet-Setup-1.0.0.exe.blockmap latest.yml root@server:/var/www/facet-downloads/windows/
ssh root@server 'cd /var/www/facet-downloads/windows && ln -sf Facet-Setup-1.0.0.exe Facet-Setup.exe'
```

Installed copies check `latest.yml` at start-up and every six hours, download the update in the
background, and install it when the app restarts. Bump `version` in `desktop/package.json` for each
release. The installer isn't code-signed, so Windows SmartScreen shows a notice on first run.

## Self-hosting elsewhere

Anyone can run their own server: same steps with their own `FACET_DOMAIN`. In the app, open
Settings → Account → Sync server and enter the URL before signing in. To run without Docker:

```sh
cd server && npm ci && npm run build
JWT_SECRET=... SERVER_SECRET=... DATA_DIR=/var/lib/facet PORT=8787 npm start
```

Put any TLS reverse proxy in front; it must not buffer `text/event-stream` responses on
`/v1/sync/stream` (Caddy's `flush_interval -1`, or `proxy_buffering off` in nginx) and should
pass `X-Forwarded-For`.
