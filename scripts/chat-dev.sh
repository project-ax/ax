#!/usr/bin/env bash
set -euo pipefail

# chat-dev.sh — Start/stop Vite dev server + AX server for chat UI development.
# Usage: scripts/chat-dev.sh <command> [args]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$PROJECT_ROOT/.chat-dev"

AX_PORT=8080
VITE_PORT=5173
MOCK_PORT=9100

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[chat-dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[chat-dev]${NC} $*"; }
err()  { echo -e "${RED}[chat-dev]${NC} $*" >&2; }

# ─── Helpers ───────────────────────────────────────────────────
ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

write_pid() {
  local name="$1" pid="$2"
  echo "$pid" > "$STATE_DIR/${name}.pid"
}

read_pid() {
  local name="$1"
  local pidfile="$STATE_DIR/${name}.pid"
  if [[ -f "$pidfile" ]]; then
    cat "$pidfile"
  fi
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

kill_by_name() {
  local name="$1"
  local pid
  pid=$(read_pid "$name")
  if [[ -n "$pid" ]] && is_running "$pid"; then
    log "Stopping $name (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    # Wait briefly for graceful shutdown
    local i=0
    while is_running "$pid" && [[ $i -lt 10 ]]; do
      sleep 0.2
      i=$((i + 1))
    done
    # Force kill if still alive
    if is_running "$pid"; then
      warn "$name did not exit gracefully, sending SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$STATE_DIR/${name}.pid"
}

cleanup() {
  log "Shutting down..."
  kill_by_name vite
  kill_by_name ax-server
  kill_by_name mock-server
  log "All processes stopped."
}

wait_for_health() {
  local url="$1" label="$2" max_wait="${3:-30}"
  local elapsed=0
  log "Waiting for $label to be ready..."
  while [[ $elapsed -lt $max_wait ]]; do
    if curl -sf "$url" >/dev/null 2>&1; then
      log "$label is ready."
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  err "$label failed to start within ${max_wait}s."
  return 1
}

# ─── Start ─────────────────────────────────────────────────────
cmd_start() {
  local use_mock=false
  local ax_port="$AX_PORT"
  local config_flag=""
  local custom_config=false

  # Parse args
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mock)
        use_mock=true
        shift
        ;;
      --port)
        ax_port="$2"
        shift 2
        ;;
      --config)
        config_flag="--config $2"
        custom_config=true
        shift 2
        ;;
      *)
        err "Unknown option: $1"
        exit 1
        ;;
    esac
  done

  # Check if already running
  local ax_pid
  ax_pid=$(read_pid ax-server)
  if [[ -n "$ax_pid" ]] && is_running "$ax_pid"; then
    err "AX server is already running (PID $ax_pid). Run 'stop' first."
    exit 1
  fi

  ensure_state_dir
  trap cleanup EXIT INT TERM

  # ── Mock server (optional) ──
  if [[ "$use_mock" == true ]]; then
    log "Starting mock LLM server on port $MOCK_PORT..."
    cd "$PROJECT_ROOT"
    NODE_NO_WARNINGS=1 npx tsx -e \
      "import { startMockServer } from './tests/e2e/mock-server/index.js'; startMockServer($MOCK_PORT).then(info => console.log('Mock server on', info.url));" \
      &
    write_pid mock-server $!

    if ! wait_for_health "http://127.0.0.1:${MOCK_PORT}/health" "mock server" 15; then
      err "Mock server failed to start."
      exit 1
    fi

    # Default to ax-dev.yaml when --mock and no explicit --config
    if [[ "$custom_config" == false ]]; then
      config_flag="--config ui/chat/ax-dev.yaml"
    fi
  fi

  # ── AX server ──
  log "Starting AX server on port $ax_port..."
  cd "$PROJECT_ROOT"
  # shellcheck disable=SC2086
  NODE_NO_WARNINGS=1 npx tsx src/cli/index.ts serve --port "$ax_port" $config_flag &
  write_pid ax-server $!

  if ! wait_for_health "http://127.0.0.1:${ax_port}/health" "AX server" 30; then
    err "AX server failed to start."
    exit 1
  fi

  # ── Vite dev server ──
  log "Starting Vite dev server..."
  cd "$PROJECT_ROOT/ui/chat"
  VITE_AX_PORT="$ax_port" npx vite --host &
  write_pid vite $!
  cd "$PROJECT_ROOT"

  echo ""
  log "========================================="
  log "  Chat UI dev environment is running"
  log "========================================="
  echo ""
  log "  Vite:       ${CYAN}http://localhost:${VITE_PORT}${NC}"
  log "  AX server:  ${CYAN}http://localhost:${ax_port}${NC}"
  if [[ "$use_mock" == true ]]; then
    log "  Mock LLM:   ${CYAN}http://localhost:${MOCK_PORT}${NC}"
  fi
  echo ""
  log "Press Ctrl+C to stop all servers."
  echo ""

  # Wait for any child to exit
  wait
}

# ─── Stop ──────────────────────────────────────────────────────
cmd_stop() {
  local found=false

  for name in vite ax-server mock-server; do
    local pid
    pid=$(read_pid "$name")
    if [[ -n "$pid" ]] && is_running "$pid"; then
      found=true
      kill_by_name "$name"
    else
      rm -f "$STATE_DIR/${name}.pid"
    fi
  done

  if [[ "$found" == false ]]; then
    log "No running dev servers found."
  else
    log "All dev servers stopped."
  fi
}

# ─── Status ────────────────────────────────────────────────────
cmd_status() {
  echo -e "${CYAN}=== Chat Dev Status ===${NC}"

  local any_running=false
  for name in ax-server vite mock-server; do
    local pid
    pid=$(read_pid "$name")
    if [[ -n "$pid" ]] && is_running "$pid"; then
      echo -e "  ${GREEN}●${NC} $name (PID $pid)"
      any_running=true
    elif [[ -n "$pid" ]]; then
      echo -e "  ${RED}●${NC} $name (PID $pid — dead)"
      rm -f "$STATE_DIR/${name}.pid"
    else
      echo -e "  ${YELLOW}○${NC} $name (not started)"
    fi
  done

  if [[ "$any_running" == false ]]; then
    echo ""
    log "No dev servers running. Start with: scripts/chat-dev.sh start"
  fi
}

# ─── Main ──────────────────────────────────────────────────────
cmd="${1:-help}"
shift || true

case "$cmd" in
  start)   cmd_start "$@" ;;
  stop)    cmd_stop "$@" ;;
  status)  cmd_status "$@" ;;
  help|--help|-h)
    echo "Usage: scripts/chat-dev.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  start [--mock] [--port N]  Start Vite + AX server (and mock LLM if --mock)"
    echo "  stop                       Stop all running dev servers"
    echo "  status                     Show running dev server status"
    echo ""
    echo "Options for start:"
    echo "  --mock         Start a mock LLM server (uses ui/chat/ax-dev.yaml by default)"
    echo "  --port N       AX server port (default: $AX_PORT)"
    echo "  --config PATH  Custom config file for AX server"
    ;;
  *)
    err "Unknown command: $cmd"
    err "Run 'scripts/chat-dev.sh help' for usage."
    exit 1
    ;;
esac
