#!/bin/bash
set -e

DOMAIN="issues.gomotx.com"
EMAIL="${1:-}"

if [ -z "$EMAIL" ]; then
  echo "Usage: $0 your@email.com"
  exit 1
fi

cd /opt/issues

echo "=== Step 1: Start with HTTP-only config ==="
cp nginx/nginx.conf nginx/nginx.conf.bak
cp nginx/nginx-init.conf nginx/nginx.conf.tmp

# Temporarily swap to init config
docker compose stop nginx
# Mount init config instead
docker run --rm -d --name mot-ssl-init \
  --network issues_internal \
  -p 80:80 \
  -v "$(pwd)/nginx/nginx-init.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$(pwd)/nginx/certbot/www:/var/www/certbot:ro" \
  nginx:alpine

echo "=== Step 2: Obtain certificate ==="
docker run --rm \
  -v "$(pwd)/nginx/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/nginx/certbot/www:/var/www/certbot" \
  certbot/certbot certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    -d "$DOMAIN"

echo "=== Step 3: Stop bootstrap nginx ==="
docker stop mot-ssl-init

echo "=== Step 4: Start full stack with HTTPS ==="
docker compose up -d

echo ""
echo "Done. https://$DOMAIN should be live."
echo "Cert auto-renews via the certbot container every 12h."
