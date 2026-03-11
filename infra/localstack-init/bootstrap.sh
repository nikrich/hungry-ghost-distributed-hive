#!/bin/bash
# Bootstrap LocalStack with required AWS resources for distributed-hive local development

set -euo pipefail

ENDPOINT="http://localhost:4566"
REGION="af-south-1"
AWS="aws --endpoint-url=$ENDPOINT --region=$REGION"

echo "[localstack-init] Creating DynamoDB table: distributed-hive-state..."
$AWS dynamodb create-table \
  --table-name distributed-hive-state \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
    AttributeName=GSI2PK,AttributeType=S \
    AttributeName=GSI2SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes \
    '[{"IndexName":"userId-index","KeySchema":[{"AttributeName":"GSI1PK","KeyType":"HASH"},{"AttributeName":"GSI1SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},{"IndexName":"status-index","KeySchema":[{"AttributeName":"GSI2PK","KeyType":"HASH"},{"AttributeName":"GSI2SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
  --billing-mode PAY_PER_REQUEST 2>/dev/null || echo "Table already exists"

echo "[localstack-init] Creating DynamoDB table: distributed-hive-settings..."
$AWS dynamodb create-table \
  --table-name distributed-hive-settings \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST 2>/dev/null || echo "Table already exists"

echo "[localstack-init] Creating SQS queue: distributed-hive-runs-dlq..."
$AWS sqs create-queue --queue-name distributed-hive-runs-dlq 2>/dev/null || true

DLQ_ARN=$($AWS sqs get-queue-attributes \
  --queue-url "$ENDPOINT/000000000000/distributed-hive-runs-dlq" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

echo "[localstack-init] Creating SQS queue: distributed-hive-runs..."
$AWS sqs create-queue \
  --queue-name distributed-hive-runs \
  --attributes "VisibilityTimeout=900,MessageRetentionPeriod=1209600,RedrivePolicy={\"maxReceiveCount\":\"3\",\"deadLetterTargetArn\":\"$DLQ_ARN\"}" \
  2>/dev/null || true

echo "[localstack-init] Creating EventBridge bus: distributed-hive-events..."
$AWS events create-event-bus --name distributed-hive-events 2>/dev/null || true

echo "[localstack-init] Creating S3 bucket: distributed-hive-frontend..."
$AWS s3 mb s3://distributed-hive-frontend 2>/dev/null || true

echo "[localstack-init] Creating Secrets Manager secrets..."
$AWS secretsmanager create-secret \
  --name hive/anthropic-api-key \
  --secret-string "sk-ant-test-key" 2>/dev/null || true
$AWS secretsmanager create-secret \
  --name hive/github-token \
  --secret-string "ghp_test_token" 2>/dev/null || true

echo "[localstack-init] Bootstrap complete!"
