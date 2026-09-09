# Banana Chat — dev tasks (spec §13.6 TASK-INF-001)
# Note: system `composer` on PATH is 1.10; the working one is homebrew's 2.8.

COMPOSER       := /opt/homebrew/bin/composer
COMPOSE        := docker compose -f infra/docker-compose.yml
API_DIR        := apps/api
PHP            := cd $(API_DIR) && php

# deploy stacks — infra/.env optional (see infra/.env.example; DEC-045)
ENV_FILE       := $(shell test -f infra/.env && echo --env-file infra/.env)
COMPOSE_PROD   := docker compose $(ENV_FILE) -f infra/docker-compose.prod.yml
COMPOSE_STAGING := docker compose $(ENV_FILE) -f infra/docker-compose.prod.yml -f infra/docker-compose.staging.yml

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

up-scale: ## Core services + TWO Reverb nodes (INF-013 Redis scaling demo)
	$(COMPOSE) up -d --build
	$(COMPOSE) --profile scale up -d --build reverb-2

down: ## Stop dev services
	$(COMPOSE) down

down-full: ## Stop everything incl. full/scale profiles
	$(COMPOSE) --profile full --profile scale down

ps: ## Service status
	$(COMPOSE) ps

logs: ## Tail service logs
	$(COMPOSE) logs -f --tail=50

# ---- deploy stacks (prod / staging — DEC-045) ----

up-prod: ## Build+start prod stack (first run: touch apps/api/.env, open http://<host>/setup)
	$(COMPOSE_PROD) up -d --build

down-prod: ## Stop the prod stack
	$(COMPOSE_PROD) down

logs-prod: ## Tail prod service logs
	$(COMPOSE_PROD) logs -f --tail=50

up-staging: ## Build+start staging overlay (first run: touch apps/api/.env.staging, open http://<host>:8081/setup)
	$(COMPOSE_STAGING) up -d --build

down-staging: ## Stop the staging stack
	$(COMPOSE_STAGING) down

logs-staging: ## Tail staging service logs
	$(COMPOSE_STAGING) logs -f --tail=50

restart-reverb: ## Restart reverb container (after channel/policy changes)
	$(COMPOSE) restart reverb

db-test: ## Create orgchat_test database if missing
	@$(COMPOSE) exec -T postgres psql -U orgchat -tc "SELECT 1 FROM pg_database WHERE datname='orgchat_test'" | grep -q 1 \
		|| $(COMPOSE) exec -T postgres createdb -U orgchat orgchat_test
	@echo "orgchat_test ready"

# ---- env switching (local docker vs cloud) ----

use-cloud: ## Point apps/api/.env at Neon + DO Spaces + remote Redis (backs up local)
	@test -f $(API_DIR)/.env.cloud.local || { echo "missing $(API_DIR)/.env.cloud.local"; exit 1; }
	@test -f $(API_DIR)/.env.docker.local || cp $(API_DIR)/.env $(API_DIR)/.env.docker.local
	@if cmp -s $(API_DIR)/.env $(API_DIR)/.env.cloud.local; then echo "already on cloud"; else cp $(API_DIR)/.env.cloud.local $(API_DIR)/.env; echo "→ cloud env active (Neon + Spaces + remote Redis)"; fi

use-local: ## Restore the local docker env backup
	@test -f $(API_DIR)/.env.docker.local || { echo "no local backup found"; exit 1; }
	@if cmp -s $(API_DIR)/.env $(API_DIR)/.env.docker.local; then echo "already on local"; else cp $(API_DIR)/.env.docker.local $(API_DIR)/.env; echo "→ local docker env active"; fi

which-env: ## Show which infra the .env currently points at
	@grep -E '^DB_HOST=' $(API_DIR)/.env | sed 's/DB_HOST=/DB → /'
	@grep -E '^REDIS_HOST=' $(API_DIR)/.env | sed 's/REDIS_HOST=/Redis → /'
	@grep -E '^FILESYSTEM_DISK=' $(API_DIR)/.env | sed 's/FILESYSTEM_DISK=/Storage → /'

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

dev-worker: ## Run Horizon on host (supervisors: default/media/push/retention/ai — TASK-INF-014)
	$(PHP) artisan horizon

dev-worker-plain: ## Plain queue worker (no Horizon) — default queues only
	$(PHP) artisan queue:work --queue=default,media,push,retention --sleep=0.1 --tries=3

dev-mock-ai: ## Run mock OpenAI-compatible provider on :8787 (no docker; needs node)
	cd infra/mock-ai && node server.js

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

flush-limiters: ## Clear login rate-limit keys on whichever redis .env points at
	@RHOST=$$(grep -E '^REDIS_HOST=' $(API_DIR)/.env | cut -d= -f2); \
	RPORT=$$(grep -E '^REDIS_PORT=' $(API_DIR)/.env | cut -d= -f2); \
	RCLI="docker exec banana-chat-redis-1 redis-cli"; \
	if [ "$$RHOST" = "127.0.0.1" ]; then $$RCLI -n 1 --scan --pattern '*banana*' | while read -r k; do [ -n "$$k" ] && $$RCLI -n 1 del "$$k" >/dev/null; done; \
	else for i in 1 2 3; do $$RCLI -h $$RHOST -p $$RPORT -n 1 --scan --pattern '*banana_chat*' >/tmp/limiters.txt 2>/dev/null && break; sleep 3; done; \
	while read -r k; do [ -n "$$k" ] && $$RCLI -h $$RHOST -p $$RPORT -n 1 del "$$k" >/dev/null 2>&1; done </tmp/limiters.txt; fi; \
	echo "login limiters cleared ($$RHOST)"

e2e: flush-limiters ## Headless two-browser E2E (needs dev stack + worker + reverb running)
	pnpm --filter @banana-chat/web e2e

test-web: ## Run vitest across packages
	pnpm -r --if-present test

typecheck: ## TypeScript check across packages
	pnpm -r --if-present typecheck

# ---- load testing (TASK-INF-012, NFR-PERF-001/002) ----

load-test: ## k6 load suite (needs api on :8000 + seed data): make load-test [DURATION=2m] [VUS=8]
	docker run --rm -i \
		-e TARGET=$${TARGET:-http://host.docker.internal:8000} \
		-e DURATION=$(DURATION) -e VUS=$(VUS) -e RACE_VUS=$(RACE_VUS) \
		grafana/k6:1.4.0 run - < infra/k6/chat-load.js

# ---- combined ----

ci-local: test test-web typecheck build-web ## Local CI approximation

.PHONY: help up up-core up-full up-scale down down-full ps logs restart-reverb db-test use-cloud use-local which-env migrate fresh seed tinker \
        dev-api dev-reverb dev-worker dev-worker-plain dev-mock-ai test test-filter pint stan install dev-web build-web e2e test-web typecheck load-test ci-local \
        up-prod down-prod logs-prod up-staging down-staging logs-staging
