#!/usr/bin/env bash
# Cloud Agent install: idempotent repository bootstrap for the 网课资料 platform.
# - Installs pinned dependencies (postinstall runs `prisma generate`).
# - Creates a local .env for development if one is not already present.
# - Syncs the SQLite schema and seeds demo data (login accounts + YYDS20 coupon).
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci

if [ ! -f .env ]; then
  cat > .env <<'EOF'
AUTH_SECRET="dev-secret-please-change-in-production-0123456789"
DATABASE_URL="file:./dev.db"
NEXT_PUBLIC_SITE_URL="http://localhost:3000"
PAYMENT_MODE="mock"
EOF
  echo "Created development .env"
fi

# Sync Prisma schema to SQLite and (re)seed demo data. Both steps are idempotent:
# `db push` converges the schema and the seed script clears + recreates demo rows.
npm run db:push
npm run db:seed
