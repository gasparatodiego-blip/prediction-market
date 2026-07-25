#!/usr/bin/env bash
# scripts/kill-maker.sh — trip the maker kill switch. One command, no arguments, no thinking.
#
#     ./scripts/kill-maker.sh
#
# WHAT IT DOES, in order: reads ADMIN_ACCESS_SECRET from .env.local itself, logs in to obtain an admin
# session cookie, POSTs /api/maker/kill (the SAME endpoint the dashboard control calls — one code path,
# not a second implementation), and then RE-READS the durable state file to confirm the switch actually
# flipped. It prints exactly one line and exits 0 only when that re-read says killed.
#
# WHY THE RE-READ IS THE POINT: an HTTP 200 says the request was handled, not that the switch is set. The
# thing that stops the engine is data/safety-kill-switch.json — agent35 re-reads it every tick — so that
# file, and nothing else, is what this script trusts. A 200 that did not flip it is reported as a FAILURE.
#
# SECRET HYGIENE: the secret and the session cookie are passed to curl through a --config file on STDIN,
# never as command-line arguments. Anything in argv is visible to every user on the box via `ps`, and this
# script is the one an operator runs while panicking. Nothing secret is ever printed, and the script emits
# no log file of its own. `set -o pipefail` plus explicit checks mean any failure exits non-zero — this
# must never appear to succeed quietly.

set -uo pipefail

BASE_URL="${KILL_BASE_URL:-http://localhost:3000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"
STATE_FILE="$REPO_ROOT/data/safety-kill-switch.json"

# EXACTLY ONE LINE OUT, on every path. curl's own diagnostics are captured to a scratch file and folded
# into that line rather than printed alongside it — under stress, two lines is one line too many to read.
CURL_ERR="$(mktemp)"
trap 'rm -f "$CURL_ERR"' EXIT
curlwhy() { tr '\n' ' ' < "$CURL_ERR" | sed 's/  */ /g; s/ *$//'; }
fail() { printf 'KILL FAILED — %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is not installed"
command -v node >/dev/null 2>&1 || fail "node is not installed (needed to read the durable state file)"
[ -r "$ENV_FILE" ] || fail "cannot read $ENV_FILE (the admin secret lives there)"

# ── the secret, read in-process. No subshell that could surface it in a process listing. ──
SECRET=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ADMIN_ACCESS_SECRET=*|export\ ADMIN_ACCESS_SECRET=*)
      SECRET="${line#*ADMIN_ACCESS_SECRET=}"
      SECRET="${SECRET%$'\r'}"
      # strip one layer of surrounding quotes if present
      case "$SECRET" in
        \"*\") SECRET="${SECRET#\"}"; SECRET="${SECRET%\"}" ;;
        \'*\') SECRET="${SECRET#\'}"; SECRET="${SECRET%\'}" ;;
      esac
      ;;
  esac
done < "$ENV_FILE"
[ -n "$SECRET" ] || fail "ADMIN_ACCESS_SECRET is not set in .env.local — nothing to authenticate with"

# JSON-escape the secret (backslash first, then quote) so an exotic character cannot break the body.
esc="${SECRET//\\/\\\\}"
esc="${esc//\"/\\\"}"

# ── 1 · log in. The secret travels in a --config file on stdin, never in argv. ──
LOGIN_HEADERS="$(curl -sS -D - -o /dev/null --max-time 15 --config - 2>"$CURL_ERR" <<CURLCFG
url = "$BASE_URL/api/settings/login"
request = "POST"
header = "Content-Type: application/json"
data = "{\"secret\":\"$esc\"}"
CURLCFG
)" || fail "cannot reach the dashboard at $BASE_URL — is the 'dashboard' pm2 process running? [$(curlwhy)]"

LOGIN_CODE="$(printf '%s' "$LOGIN_HEADERS" | awk '/^HTTP\//{c=$2} END{print c}')"
[ "$LOGIN_CODE" = "200" ] || fail "admin login rejected (HTTP ${LOGIN_CODE:-none}) — check ADMIN_ACCESS_SECRET in .env.local"

COOKIE="$(printf '%s' "$LOGIN_HEADERS" | sed -n 's/.*edgeradar_admin=\([^;]*\).*/\1/p' | head -n1)"
[ -n "$COOKIE" ] || fail "login returned no session cookie — refusing to continue"

# ── 2 · the kill. Same endpoint the dashboard control calls. Cookie via stdin, not argv. ──
KILL_BODY="$(curl -sS -o - -w '\n%{http_code}' --max-time 30 --config - 2>"$CURL_ERR" <<CURLCFG
url = "$BASE_URL/api/maker/kill"
request = "POST"
header = "Content-Type: application/json"
header = "cookie: edgeradar_admin=$COOKIE"
CURLCFG
)" || fail "the kill request could not be completed — the durable switch may NOT be set, verify by hand [$(curlwhy)]"

KILL_CODE="$(printf '%s' "$KILL_BODY" | tail -n1)"

# ── 3 · THE VERDICT COMES FROM THE FILE, NOT FROM THE RESPONSE. ──
# node exits 0 only when the durable state genuinely says global.killed === true.
CONFIRM="$(STATE_FILE="$STATE_FILE" node -e '
const fs = require("fs");
try {
  const s = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
  if (s && s.global && s.global.killed === true) {
    process.stdout.write(new Date(s.global.at || Date.now()).toISOString());
    process.exit(0);
  }
  process.stdout.write("state file present but global.killed is not true");
  process.exit(3);
} catch (e) {
  process.stdout.write("durable state unreadable: " + (e.code === "ENOENT" ? "no state file was written" : e.message));
  process.exit(3);
}
')" || fail "HTTP $KILL_CODE came back but the durable switch did NOT flip — $CONFIRM"

printf 'MAKER KILLED — durable switch confirmed set at %s by re-reading %s (HTTP %s). agent35 stands down on its next tick.\n' \
  "$CONFIRM" "${STATE_FILE#"$REPO_ROOT/"}" "$KILL_CODE"
exit 0
