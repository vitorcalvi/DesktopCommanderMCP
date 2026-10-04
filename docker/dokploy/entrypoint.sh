#!/usr/bin/env bash
set -Eeuo pipefail

export HOME="${HOME:-/data}"
CONFIG_DIR="$HOME/.claude-server-commander"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR" /workspace

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" <<'JSON'
{
  "allowedDirectories": ["/workspace", "/host-home", "/dokploy"],
  "telemetryEnabled": false,
  "fileReadLineLimit": 1000,
  "fileWriteLineLimit": 200
}
JSON
  chmod 600 "$CONFIG_FILE"
fi

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
