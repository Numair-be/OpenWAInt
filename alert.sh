#!/usr/bin/env bash
# Send an alert through the OpenWA relay.
#
#   alert.sh -a myapp "Something broke"
#   alert.sh -a myapp -l critical -d "$(tail -n 20 app.log)" "Service down"
#   alert.sh -a nightly-backup --wrap ./backup.sh      # alerts only if it fails
#
# Config: RELAY_URL (default http://localhost:3000) and RELAY_TOKEN must be set,
# e.g. in /etc/environment or the crontab.

set -u
RELAY_URL="${RELAY_URL:-http://localhost:3000}"
APP="$(hostname)"; LEVEL="error"; DETAILS=""; CHANNEL=""; WRAP=0

while [ $# -gt 0 ]; do
  case "$1" in
    -a) APP="$2"; shift 2 ;;
    -l) LEVEL="$2"; shift 2 ;;
    -d) DETAILS="$2"; shift 2 ;;
    -c) CHANNEL="$2"; shift 2 ;;
    --wrap) WRAP=1; shift ;;
    *) break ;;
  esac
done

if [ -z "${RELAY_TOKEN:-}" ]; then echo "RELAY_TOKEN is not set" >&2; exit 2; fi

send() {  # send <message> <details>
  # Build JSON safely (handles quotes/newlines) using python3 or node
  local payload
  if command -v python3 >/dev/null; then
    payload=$(python3 -c 'import json,sys; a=dict(app=sys.argv[1],level=sys.argv[2],message=sys.argv[3],details=sys.argv[4]); 
c=sys.argv[5]
if c: a["channel"]=c
print(json.dumps(a))' "$APP" "$LEVEL" "$1" "$2" "$CHANNEL")
  else
    payload=$(node -e 'const [app,level,message,details,channel]=process.argv.slice(1);
const a={app,level,message,details}; if(channel)a.channel=channel; console.log(JSON.stringify(a))' "$APP" "$LEVEL" "$1" "$2" "$CHANNEL")
  fi
  curl -sS --max-time 10 -X POST "$RELAY_URL/alert" \
    -H "X-Relay-Token: $RELAY_TOKEN" -H "Content-Type: application/json" \
    -d "$payload" >/dev/null || echo "alert.sh: could not reach relay" >&2
}

if [ "$WRAP" -eq 1 ]; then
  out=$("$@" 2>&1); code=$?
  if [ $code -ne 0 ]; then
    send "Command failed (exit $code): $*" "$(printf '%s' "$out" | tail -n 15)"
  fi
  printf '%s\n' "$out"
  exit $code
else
  send "$*" "$DETAILS"
fi
