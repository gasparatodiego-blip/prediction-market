#!/bin/bash

BACKUP_DIR="/root/backups"
DATE=20260612_185424
BACKUP_NAME="arbscanner_backup_"
BACKUP_PATH="/"

# Crea directory se non esiste
mkdir -p 
mkdir -p 

echo "🔄 Avvio backup - Fri Jun 12 06:54:24 PM UTC 2026"

# 1. Backup del codice (escluso node_modules)
echo "📁 Backup del codice..."
rsync -a --exclude "node_modules" --exclude ".git" --exclude "logs"   /root/prediction-market/ /code/

# 2. Backup dei dati (JSON, DB, config)
echo "💾 Backup dei dati..."
cp /root/prediction-market/public/latest-opportunities.json / 2>/dev/null
cp /tmp/arb-alerts-sent.json / 2>/dev/null

# 3. Backup della configurazione PM2
echo "⚙️ Backup PM2..."
pm2 save --force
pm2 dump > /pm2-dump.json 2>/dev/null

# 4. Backup del database PostgreSQL (se esiste)
echo "🗄️ Backup database..."
if command -v pg_dump &> /dev/null; then
    sudo -u postgres pg_dump prediction_market > /database.sql 2>/dev/null || echo "⚠️ DB not found"
fi

# 5. Backup crontab
echo "📅 Backup crontab..."
crontab -l > /crontab.txt 2>/dev/null

# 6. Backup environment variables
echo "🔐 Backup .env..."
cp /root/prediction-market/.env / 2>/dev/null || echo "No .env file"

# 7. Crea archive compresso
echo "📦 Creazione archive..."
cd 
tar -czf .tar.gz /
rm -rf 

# 8. Mantieni solo ultimi 7 backup
echo "🧹 Pulizia backup vecchi..."
ls -t /*.tar.gz 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null

# 9. Calcola dimensione
SIZE=

echo "✅ Backup completato: .tar.gz ()"
echo "📂 Location: /.tar.gz"
echo "🕐 Fine: Fri Jun 12 06:54:24 PM UTC 2026"
