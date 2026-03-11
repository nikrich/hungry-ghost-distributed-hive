#!/bin/bash
set -euo pipefail

# 1. Fetch secrets from AWS Secrets Manager
export ANTHROPIC_API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id "$ANTHROPIC_KEY_ARN" --query SecretString --output text)
export GITHUB_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id "$GITHUB_TOKEN_ARN" --query SecretString --output text)

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

# 7. Submit requirement and run
hive req "$REQUIREMENT_TITLE" --description "$REQUIREMENT_DESCRIPTION"
hive assign

# 8. Start manager daemon (foreground — keeps container alive)
hive manager start --no-daemon --verbose

# Manager exits when all stories are merged or max runtime exceeded
echo "Run complete. Shutting down."
