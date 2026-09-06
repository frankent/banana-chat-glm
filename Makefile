# Banana Chat — dev tasks (spec §13.6 TASK-INF-001)
# Note: system `composer` on PATH is 1.10; the working one is homebrew's 2.8.

COMPOSER       := /opt/homebrew/bin/composer
COMPOSE        := docker compose -f infra/docker-compose.yml
API_DIR        := apps/api
PHP            := cd $(API_DIR) && php

.DEFAULT_GOAL := help

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ---- infrastructure ----

up: ## Start dev services (postgres redis minio mailpit reverb)
	$(COMPOSE) up -d --build

up-core: ## Start only stateful services (no reverb container; run dev-reverb on host)
	$(COMPOSE) up -d postgres redis minio minio-init mailpit

up-full: ## Start everything containerized (api worker scheduler web + services)
	$(COMPOSE) --profile full up -d --build

down: ## Stop dev services
	$(COMPOSE) down

down-full: ## Stop everything incl. full profile
	$(COMPOSE) --profile full down

ps: ## Service status
	$(COMPOSE) ps

logs: ## Tail service logs
	$(COMPOSE) logs -f --tail=50

restart-reverb: ## Restart reverb container (after channel/policy changes)
	$(COMPOSE) restart reverb

db-test: ## Create orgchat_test database if missing
	@$(COMPOSE) exec -T postgres psql -U orgchat -tc "SELECT 1 FROM pg_database WHERE datname='orgchat_test'" | grep -q 1 \
		|| $(COMPOSE) exec -T postgres createdb -U orgchat orgchat_test
	@echo "orgchat_test ready"

# ---- api ----

migrate: ## Run pending migrations
	$(PHP) artisan migrate

fresh: ## Rebuild database from scratch (migrate:fresh)
	$(PHP) artisan migrate:fresh

seed: ## Seed demo data (admin + acme/globex workspaces)
	$(PHP) artisan db:seed

tinker: ## Open tinker
	$(PHP) artisan tinker

dev-api: ## Run API dev server on :8000 (host)
	$(PHP) artisan serve --host=127.0.0.1 --port=8000

dev-reverb: ## Run Reverb on host :8088 (alternative to the container)
	$(PHP) artisan reverb:start --host=127.0.0.1 --port=8088

dev-worker: ## Run queue worker on host (broadcasts are queued; realtime needs this)
	$(PHP) artisan queue:work --queue=default --sleep=0.1 --tries=3

test: db-test ## Run API test suite (Pest, Postgres)
	cd $(API_DIR) && ./vendor/bin/pest

test-filter: db-test ## Run filtered Pest tests: make test-filter f=Auth
	cd $(API_DIR) && ./vendor/bin/pest --filter $(f)

pint: ## Run code style fixer
	cd $(API_DIR) && ./vendor/bin/pint

stan: ## Run static analysis
	cd $(API_DIR) && ./vendor/bin/phpstan analyse

# ---- web / packages ----

install: ## Install all JS deps (pnpm workspace)
	pnpm install

dev-web: ## Run web dev server on :5173
	pnpm --filter @banana-chat/web dev

build-web: ## Build web app for production
	pnpm --filter @banana-chat/web build

e2e: ## Headless two-browser E2E (needs dev stack + worker + reverb running)
	pnpm --filter @banana-chat/web e2e

test-web: ## Run vitest across packages
	pnpm -r --if-present test

typecheck: ## TypeScript check across packages
	pnpm -r --if-present typecheck

# ---- combined ----

ci-local: test test-web typecheck build-web ## Local CI approximation

.PHONY: help up up-core up-full down down-full ps logs restart-reverb db-test migrate fresh seed tinker \
        dev-api dev-reverb dev-worker test test-filter pint stan install dev-web build-web e2e test-web typecheck ci-local
