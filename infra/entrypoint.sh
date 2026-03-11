#!/bin/bash
set -euo pipefail

# ── Graceful Shutdown Handler (Fargate Spot interruption) ──
# Fargate sends SIGTERM with 120s window before SIGKILL.
SHUTDOWN_IN_PROGRESS=false
STATE_SYNC_PID=""
MANAGER_PID=""

cleanup() {
  if [ "$SHUTDOWN_IN_PROGRESS" = true ]; then
    return
  fi
  SHUTDOWN_IN_PROGRESS=true
  echo "[entrypoint] SIGTERM received — beginning graceful shutdown (120s window)..."

  # Save run state to EFS checkpoint
  if [ -d /workspace/.hive ]; then
    CHECKPOINT_DIR="/workspace/.hive/checkpoint-$(date +%s)"
    mkdir -p "$CHECKPOINT_DIR"
    cp -r /workspace/.hive/hive.db "$CHECKPOINT_DIR/" 2>/dev/null || true
    cp -r /workspace/.hive/hive.config.yaml "$CHECKPOINT_DIR/" 2>/dev/null || true
    echo "{\"run_id\":\"${RUN_ID:-unknown}\",\"shutdown_reason\":\"spot-interruption\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$CHECKPOINT_DIR/shutdown-meta.json"
    echo "[entrypoint] State saved to $CHECKPOINT_DIR"
  fi

  # Stop state sync adapter gracefully
  if [ -n "$STATE_SYNC_PID" ] && kill -0 "$STATE_SYNC_PID" 2>/dev/null; then
    echo "[entrypoint] Stopping state sync adapter..."
    kill -TERM "$STATE_SYNC_PID" 2>/dev/null || true
    wait "$STATE_SYNC_PID" 2>/dev/null || true
  fi

  # Stop manager gracefully
  if [ -n "$MANAGER_PID" ] && kill -0 "$MANAGER_PID" 2>/dev/null; then
    echo "[entrypoint] Stopping manager..."
    kill -TERM "$MANAGER_PID" 2>/dev/null || true
    wait "$MANAGER_PID" 2>/dev/null || true
  fi

  echo "[entrypoint] Graceful shutdown complete."
  exit 0
}

trap cleanup SIGTERM SIGINT

# ── Run Timeout Enforcement ──
RUN_TIMEOUT_SECONDS="${RUN_TIMEOUT_SECONDS:-86400}" # Default: 24 hours
(
  sleep "$RUN_TIMEOUT_SECONDS"
  echo "[entrypoint] Run timeout reached (${RUN_TIMEOUT_SECONDS}s). Initiating shutdown..."
  kill -TERM $$ 2>/dev/null || true
) &
TIMEOUT_PID=$!

# ── Secrets Fetch ──
# In LOCAL_MODE, secrets come from environment variables directly
if [ "${LOCAL_MODE:-false}" = "true" ]; then
  echo "[entrypoint] LOCAL_MODE enabled — skipping Secrets Manager fetch"
  export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
else
  export ANTHROPIC_API_KEY=$(aws secretsmanager get-secret-value \
    --secret-id "$ANTHROPIC_KEY_ARN" --query SecretString --output text)
  export GITHUB_TOKEN=$(aws secretsmanager get-secret-value \
    --secret-id "$GITHUB_TOKEN_ARN" --query SecretString --output text)
fi

# 2. Configure git
git config --global user.name "Distributed Hive"
git config --global user.email "hive@distributed-hive.com"
echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
git config --global credential.helper store

# 3. Initialize hive workspace
mkdir -p /workspace && cd /workspace
hive init

# 4. Clone repos from the run config
for repo in $(echo "$REPO_URLS" | jq -r '.[]'); do
  hive add-repo "$repo"
done

# 5. Apply user config overrides
if [ -n "${HIVE_CONFIG_OVERRIDE:-}" ]; then
  echo "$HIVE_CONFIG_OVERRIDE" > .hive/hive.config.yaml
fi

# 6. Start state sync adapter (background)
node /opt/hive/dist/adapters/state-sync.js \
  --run-id "$RUN_ID" \
  --table "$DYNAMODB_TABLE" \
  --event-bus "$EVENTBRIDGE_BUS" &
STATE_SYNC_PID=$!

# 7. Submit requirement and run
hive req "$REQUIREMENT_TITLE" --description "$REQUIREMENT_DESCRIPTION"
hive assign

# 8. Start manager daemon (foreground — keeps container alive)
hive manager start --no-daemon --verbose &
MANAGER_PID=$!

# Wait for manager to complete (or SIGTERM to interrupt)
wait "$MANAGER_PID" 2>/dev/null || true

# Kill timeout watcher if still running
kill "$TIMEOUT_PID" 2>/dev/null || true

echo "Run complete. Shutting down."
