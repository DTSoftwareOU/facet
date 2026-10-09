#!/usr/bin/env sh
# Facet backup: consistent SQLite snapshot + encrypted blob archive, 14-day retention.
# Run from cron on the host, e.g.:  15 3 * * * /opt/facet/deploy/backup.sh >> /var/log/facet-backup.log 2>&1
set -eu

cd "$(dirname "$0")"
BACKUP_DIR="${BACKUP_DIR:-$(pwd)/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT="/data/backup-$TS.db"

mkdir -p "$BACKUP_DIR"

# 1) Consistent database snapshot (VACUUM INTO) inside the container, then copy it out.
docker compose exec -T facet node --disable-warning=ExperimentalWarning dist/backup.js "$SNAPSHOT"
docker compose cp "facet:$SNAPSHOT" "$BACKUP_DIR/facet-db-$TS.db"
docker compose exec -T facet rm -f "$SNAPSHOT"
gzip -9 "$BACKUP_DIR/facet-db-$TS.db"

# 2) Encrypted attachment blobs (already ciphertext; compression won't help much).
docker compose exec -T facet tar -C /data -cf - blobs > "$BACKUP_DIR/facet-blobs-$TS.tar"

# 3) Retention.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'facet-*' -mtime "+$KEEP_DAYS" -delete

echo "$(date -u +%FT%TZ) backup complete: $BACKUP_DIR/facet-db-$TS.db.gz, facet-blobs-$TS.tar"
