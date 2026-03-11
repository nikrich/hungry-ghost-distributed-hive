.PHONY: local-up local-down local-test local-logs help

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

local-up: ## Start LocalStack and hive containers
	docker compose -f docker-compose.localstack.yml up -d
	@echo "Waiting for LocalStack to be healthy..."
	@docker compose -f docker-compose.localstack.yml exec localstack bash -c 'until curl -sf http://localhost:4566/_localstack/health; do sleep 2; done' >/dev/null 2>&1
	@echo "LocalStack ready. Dashboard at http://localhost:4566"

local-down: ## Stop all local containers and remove volumes
	docker compose -f docker-compose.localstack.yml down -v

local-test: local-up ## Run full local stack test (start containers, verify, stop)
	@echo "=== Verifying LocalStack resources ==="
	@docker compose -f docker-compose.localstack.yml exec localstack aws --endpoint-url=http://localhost:4566 --region=af-south-1 dynamodb list-tables
	@docker compose -f docker-compose.localstack.yml exec localstack aws --endpoint-url=http://localhost:4566 --region=af-south-1 sqs list-queues
	@docker compose -f docker-compose.localstack.yml exec localstack aws --endpoint-url=http://localhost:4566 --region=af-south-1 events list-event-buses
	@echo "=== Local stack verified ==="

local-logs: ## Tail logs from all local containers
	docker compose -f docker-compose.localstack.yml logs -f

test: ## Run all tests
	npm test

test-cdk: ## Run CDK infrastructure tests
	cd infra/cdk && npm test
