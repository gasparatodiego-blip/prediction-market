#!/usr/bin/env bash
# Compile + run the pure lib/rewards-estimate.ts unit tests with the repo's own
# TypeScript compiler (no test framework / no extra deps). Exit non-zero on failure.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
./node_modules/.bin/tsc lib/rewards-estimate.ts lib/rewards-estimate.test.ts \
  --outDir "$OUT" --rootDir . --module commonjs --target es2019 --strict --skipLibCheck --esModuleInterop
node "$OUT/lib/rewards-estimate.test.js"
