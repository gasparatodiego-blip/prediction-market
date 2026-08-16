#!/bin/bash
# Nightly backup — runs at 2am via cron
# Backs up /tmp JSON state + SQLite DB to /root/backups/

set -euo pipefail

BACKUP_DIR="/root/backups"
DATE=$(date +%Y-%m-%d)
DEST="$BACKUP_DIR/$DATE"

mkdir -p "$DEST"

# Backup /tmp JSON agent files
for f in \
  arbitrage-opportunities.json \
  master-log.json \
  master-opportunities.json \
  prediction-tracker.json \
  exchange-prices.json \
  kalshi-raw.json \
  polymarket-raw.json \
  manifold-raw.json \
  predictit-raw.json \
  monitor-status.json \
  agent-heartbeats.json; do
  if [ -f "/tmp/$f" ]; then
    cp "/tmp/$f" "$DEST/$f"
  fi
done

# Backup SQLite database (if exists)
DB_FILE="/root/prediction-market/data/opportunities.db"
if [ -f "$DB_FILE" ]; then
  cp "$DB_FILE" "$DEST/opportunities.db"
fi

# Compress everything
tar -czf "$BACKUP_DIR/${DATE}.tar.gz" -C "$BACKUP_DIR" "$DATE"
rm -rf "$DEST"

# Keep only last 30 days of backups
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +30 -delete

echo "[backup] $DATE complete → $BACKUP_DIR/${DATE}.tar.gz"
