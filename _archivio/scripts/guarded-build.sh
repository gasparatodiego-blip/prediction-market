#!/usr/bin/env bash
# scripts/guarded-build.sh — the guarded build/deploy path (rules 67, 68, 69).
#
#   67. never two builds in parallel → a flock serializes builds; a second build WAITS
#       (up to 900s) for the first to finish, preventing the .next race.
#   68. a FAILED build does NOT restart the dashboard — the last working .next keeps
#       serving; the failure is recorded so the guardian health report surfaces it.
#   69. after a successful build, an INCOHERENT working tree (unexpected uncommitted
#       tracked changes) is detected + flagged, not silently deployed.
#
# Read-only on source. Only ever runs `next build` + `pm2 restart dashboard` on success.
set -uo pipefail
cd "$(dirname "$0")/.."

LOCK=/tmp/edgeradar-build.lock
exec 9>"$LOCK" || { echo "[guarded-build] cannot open lock file $LOCK"; exit 2; }

echo "[guarded-build] acquiring build lock (waits if another build is running)…"
if ! flock -w 900 9; then
  echo "[guarded-build] could not acquire the build lock within 900s — another build is still running. Aborting (rule 67)."
  exit 3
fi

node -e "require('./lib/build-lock').recordStart()" 2>/dev/null || true
echo "[guarded-build] lock held — starting build…"

if npm run build; then
  # rule 69 — working-tree coherence (ignore untracked data/ and the .next artifact).
  TREE_COHERENT=true
  if ! git diff --quiet -- . ':(exclude)data' ':(exclude).next' 2>/dev/null; then
    TREE_COHERENT=false
    echo "[guarded-build] WARNING (rule 69): working tree has uncommitted tracked changes after build — review before trusting this deploy."
  fi
  node -e "require('./lib/build-lock').recordResult('ok', { treeCoherent: ${TREE_COHERENT} })" 2>/dev/null || true
  echo "[guarded-build] build OK — restarting dashboard"
  pm2 restart dashboard
  pm2 save || true
  echo "[guarded-build] done."
  exit 0
else
  code=$?
  node -e "require('./lib/build-lock').recordResult('fail', { reason: 'next build exited non-zero' })" 2>/dev/null || true
  echo "[guarded-build] BUILD FAILED (exit ${code}) — NOT restarting the dashboard (rule 68). The last working build keeps serving. Fix the error and re-run."
  exit "${code}"
fi
