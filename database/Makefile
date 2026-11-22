# Banco de dados do MoneyFlow (PostgreSQL 18 + pgvector). Rode a partir de database/.
SHELL := /bin/bash
COMPOSE := docker compose
DBMATE := $(COMPOSE) run --rm dbmate
include $(wildcard .env)
POSTGRES_USER ?= moneyflow
POSTGRES_DB ?= moneyflow
PSQL := $(COMPOSE) exec -T postgres psql -v ON_ERROR_STOP=1 -U $(POSTGRES_USER)
T ?= /tests

.PHONY: env up down logs psql owner migrate rollback status new test test-migration dump seed sizes reset

env:            ## cria .env a partir do exemplo, se faltar
	@test -f .env || cp .env.example .env

up: env         ## sobe o Postgres e espera ficar saudável
	$(COMPOSE) up -d --build --wait postgres

down:           ## para o container (mantém o volume)
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f postgres

psql:           ## console interativo no banco de desenvolvimento
	$(COMPOSE) exec postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

# Papéis (docs/016): idempotente; num volume antigo garante o moneyflow_app com o prazo de transação ociosa (tarefa 102),
# cria o moneyflow_owner e lhe passa a posse.
owner: up       ## garante os papéis moneyflow_app e moneyflow_owner (dono de <db> e <db>_test)
	$(COMPOSE) exec -T postgres bash /docker-entrypoint-initdb.d/02-app-role.sh
	$(COMPOSE) exec -T postgres bash /docker-entrypoint-initdb.d/03-owner-role.sh

# As migrations rodam como moneyflow_owner (DATABASE_URL do serviço dbmate); criar e apagar bancos fica com o
# superusuário, porque o dono não tem CREATEDB.
migrate: owner  ## aplica as migrations pendentes no banco de desenvolvimento
	$(DBMATE) up

rollback: owner ## desfaz a última migration no banco de desenvolvimento
	$(DBMATE) rollback

status: owner
	$(DBMATE) status

new:            ## make new NAME=create_users
	@./scripts/new-migration.sh $(NAME)

test: owner     ## recria o banco de testes, migra e roda pgTAP (make test T=/tests/0003_entities.sql)
	$(PSQL) -d postgres -c 'DROP DATABASE IF EXISTS "$(POSTGRES_DB)_test" WITH (FORCE)' \
	  -c 'CREATE DATABASE "$(POSTGRES_DB)_test" OWNER moneyflow_owner'
	$(COMPOSE) exec -T -e OWNER_DBS=$(POSTGRES_DB)_test postgres bash /docker-entrypoint-initdb.d/03-owner-role.sh
	$(DBMATE) -e TEST_DATABASE_URL up
	$(DBMATE) -e TEST_DATABASE_URL rollback
	$(DBMATE) -e TEST_DATABASE_URL up
	$(COMPOSE) exec -T postgres bash -c 'pg_prove -U $(POSTGRES_USER) -d $(POSTGRES_DB)_test --ext .sql -r $(T)'

test-migration: owner  ## testa uma migration com dados, com as migrations como o dono (make test-migration M=0052)
	./scripts/test-migration.sh $(M)

dump: migrate   ## regrava schema.sql (estrutura atual, commitado como referência)
	$(COMPOSE) exec -T postgres pg_dump -U $(POSTGRES_USER) -d $(POSTGRES_DB) --schema-only --no-owner --no-privileges \
	  | sed '/^\\restrict/d;/^\\unrestrict/d' > schema.sql

seed: migrate   ## carrega dados de desenvolvimento
	$(PSQL) -d $(POSTGRES_DB) < seeds/dev.sql

# Diagnóstico do volume (tarefa 103): as maiores tabelas com índices e TOAST, e as linhas estimadas. DB=<banco> mede outro.
sizes: up       ## tamanho das 30 maiores tabelas (make sizes DB=moneyflow)
	$(PSQL) -d $(or $(DB),$(POSTGRES_DB)) -c "SELECT c.relname AS tabela, pg_size_pretty(pg_total_relation_size(c.oid)) AS total, \
	  pg_size_pretty(pg_relation_size(c.oid)) AS heap, pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS indices_e_toast, \
	  greatest(c.reltuples, 0)::bigint AS linhas_estimadas FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
	  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 30"

reset: owner    ## APAGA o banco de desenvolvimento e recria do zero
	$(PSQL) -d postgres -c 'DROP DATABASE IF EXISTS "$(POSTGRES_DB)" WITH (FORCE)' \
	  -c 'CREATE DATABASE "$(POSTGRES_DB)" OWNER moneyflow_owner'
	$(COMPOSE) exec -T -e OWNER_DBS=$(POSTGRES_DB) postgres bash /docker-entrypoint-initdb.d/03-owner-role.sh
	$(DBMATE) up
