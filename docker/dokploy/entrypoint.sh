#!/usr/bin/env bash
set -Eeuo pipefail

export HOME="${HOME:-/data}"
CONFIG_DIR="$HOME/.claude-server-commander"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR" /workspace

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" <<'JSON'
{
  "allowedDirectories": ["/workspace"],
  "telemetryEnabled": false,
  "fileReadLineLimit": 1000,
  "fileWriteLineLimit": 200
}
JSON
  chmod 600 "$CONFIG_FILE"
fi

# Apply a restrictive runtime directory allowlist even when /data is a
# persistent volume containing configuration from an earlier deployment.
# Additional mounts are never implicitly trusted.
node - "$CONFIG_FILE" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const directories = (process.env.DESKTOP_COMMANDER_ALLOWED_DIRECTORIES || '/workspace')
  .split(',').map((value) => value.trim()).filter(Boolean);
if (!directories.length || directories.some((dir) => !dir.startsWith('/'))) {
  throw new Error('DESKTOP_COMMANDER_ALLOWED_DIRECTORIES must contain absolute paths');
}
config.allowedDirectories = directories;
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 });
NODE
cleanup() {
  local code=$?
  if [[ -n "${SUPERGATEWAY_PID:-}" ]] && kill -0 "$SUPERGATEWAY_PID" 2>/dev/null; then
    kill "$SUPERGATEWAY_PID" 2>/dev/null || true
    wait "$SUPERGATEWAY_PID" 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

supergateway \
  --stdio "node /app/dist/index.js" \
  --outputTransport streamableHttp \
  --stateful \
  --sessionTimeout "${MCP_SESSION_TIMEOUT_MS:-86400000}" \
  --port 8765 \
  --streamableHttpPath /mcp \
  --logLevel "${SUPERGATEWAY_LOG_LEVEL:-info}" &
SUPERGATEWAY_PID=$!

for _ in $(seq 1 60); do
  if ! kill -0 "$SUPERGATEWAY_PID" 2>/dev/null; then
    wait "$SUPERGATEWAY_PID"
    exit 1
  fi
  if node -e "fetch('http://127.0.0.1:8765/mcp',{method:'GET',headers:{accept:'application/json, text/event-stream'},signal:AbortSignal.timeout(500)}).then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 0.5
done

exec node /opt/desktop-commander/auth-proxy.mjs
