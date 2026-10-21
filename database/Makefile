# Banco de dados do MoneyFlow (PostgreSQL 18 + pgvector). Rode a partir de database/.
SHELL := /bin/bash
COMPOSE := docker compose
DBMATE := $(COMPOSE) run --rm dbmate
include $(wildcard .env)
POSTGRES_USER ?= moneyflow
POSTGRES_DB ?= moneyflow
PSQL := $(COMPOSE) exec -T postgres psql -v ON_ERROR_STOP=1 -U $(POSTGRES_USER)
T ?= /tests

.PHONY: env up down logs psql migrate rollback status new test test-migration dump seed reset

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

migrate: up     ## aplica as migrations pendentes no banco de desenvolvimento
	$(DBMATE) up

rollback: up    ## desfaz a última migration no banco de desenvolvimento
	$(DBMATE) rollback

status: up
	$(DBMATE) status

new:            ## make new NAME=create_users
	@./scripts/new-migration.sh $(NAME)

test: up        ## recria o banco de testes, migra e roda pgTAP (make test T=/tests/0003_entities.sql)
	$(DBMATE) -e TEST_DATABASE_URL drop
	$(DBMATE) -e TEST_DATABASE_URL up
	$(DBMATE) -e TEST_DATABASE_URL rollback
	$(DBMATE) -e TEST_DATABASE_URL up
	$(COMPOSE) exec -T postgres bash -c 'pg_prove -U $(POSTGRES_USER) -d $(POSTGRES_DB)_test --ext .sql -r $(T)'

test-migration: up  ## testa uma migration com dados: subida, descida e subida (make test-migration M=0052)
	./scripts/test-migration.sh $(M)

dump: migrate   ## regrava schema.sql (estrutura atual, commitado como referência)
	$(COMPOSE) exec -T postgres pg_dump -U $(POSTGRES_USER) -d $(POSTGRES_DB) --schema-only --no-owner --no-privileges \
	  | sed '/^\\restrict/d;/^\\unrestrict/d' > schema.sql

seed: migrate   ## carrega dados de desenvolvimento
	$(PSQL) -d $(POSTGRES_DB) < seeds/dev.sql

reset: up       ## APAGA o banco de desenvolvimento e recria do zero
	$(DBMATE) drop
	$(DBMATE) up
