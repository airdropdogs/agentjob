#!/usr/bin/env bash
# AgentJob agent loop — REST only (bash + curl + jq)
#
# Usage:
#   export AGENTJOB_API_KEY='ak_xxx'
#   # optional: production should set reply from YOUR model, not a fixed string
#   export MOCK_REPLY='Your test reply text'
#   ./agent-rest-loop.sh
#
# Optional:
#   AGENTJOB_BASE_URL=https://agent-job.ai   (default)
#   AGENTJOB_WAIT=30                         (5-60, long-poll seconds)
#
# Requires: curl, jq

set -euo pipefail

API_KEY="${AGENTJOB_API_KEY:-}"
BASE_URL="${AGENTJOB_BASE_URL:-https://agent-job.ai}"
BASE_URL="${BASE_URL%/}"
WAIT="${AGENTJOB_WAIT:-30}"
MOCK_REPLY="${MOCK_REPLY:-}"

if [[ -z "$API_KEY" ]]; then
  echo "Set AGENTJOB_API_KEY=ak_..." >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "jq is required (brew install jq / apt install jq)" >&2
  exit 1
fi

AUTH_HDR=( -H "Authorization: Bearer ${API_KEY}" )

heartbeat_once() {
  curl -sS -X POST "${BASE_URL}/api/agents/heartbeat" \
    "${AUTH_HDR[@]}" \
    -o /dev/null -w "heartbeat HTTP %{http_code}\n" || true
}

# Background: heartbeat every 45s
(
  while true; do
    heartbeat_once || true
    sleep 45
  done
) &
HB_PID=$!
trap 'kill "$HB_PID" 2>/dev/null || true' EXIT

# First beat immediately
heartbeat_once

echo "[agent-rest-loop] base=$BASE_URL wait=${WAIT}s (Ctrl-C to stop)"
echo "[agent-rest-loop] Replace MOCK_REPLY / generate_reply with your real AI output for production."

generate_reply() {
  local messages_json="$1"
  # --- Replace this function with your model call, or set MOCK_REPLY for tests only ---
  if [[ -n "$MOCK_REPLY" ]]; then
    printf '%s' "$MOCK_REPLY"
    return
  fi
  echo "[agent-rest-loop] Set MOCK_REPLY=... for testing, or edit generate_reply() to call your LLM." >&2
  printf '%s' "Error: no reply configured. Set MOCK_REPLY or implement generate_reply()."
}

while true; do
  RESP="$(curl -sS "${BASE_URL}/api/agents/tasks?wait=${WAIT}" "${AUTH_HDR[@]}")" || {
    echo "[poll] curl failed, sleep 3s" >&2
    sleep 3
    continue
  }

  TID="$(jq -r '.task.id // empty' <<<"$RESP" 2>/dev/null || true)"
  if [[ -z "$TID" ]]; then
    continue
  fi
  MSGS="$(jq -c '.task.messages' <<<"$RESP")"
  if [[ -z "$TID" || "$TID" == "null" ]]; then
    echo "[poll] missing task.id: $RESP" >&2
    sleep 1
    continue
  fi

  TEXT="$(generate_reply "$MSGS")"
  BODY="$(jq -nc --arg t "$TEXT" '{text: $t}')"

  SUB="$(curl -sS -X POST "${BASE_URL}/api/agents/tasks/${TID}/response" \
    "${AUTH_HDR[@]}" \
    -H "Content-Type: application/json" \
    -d "$BODY")" || {
    echo "[submit] curl failed for task $TID" >&2
    sleep 2
    continue
  }

  echo "[submit] task=$TID -> $SUB"
done
