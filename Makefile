# MoneyFlow — atalhos da raiz. O banco tem o próprio Makefile em database/.
SHELL := /bin/bash
IMAGE ?= tmsoftbrasil/moneyflow
VERSION ?= $(shell node -p "require('./package.json').version")
PLATFORMS ?= linux/amd64,linux/arm64

.PHONY: up down logs ps image release e2e

up:        ## pilha completa (banco, migrations, api, worker) em http://localhost:3000
	docker compose up --build -d

down:      ## para a pilha (mantém o volume do banco dela)
	docker compose down

logs:
	docker compose logs -f api worker

ps:
	docker compose ps

image:     ## build local da imagem (arquitetura da máquina)
	docker build -t $(IMAGE):dev .

release:   ## build multi-arch e push de $(IMAGE):$(VERSION) e :latest (conta tmsoftbrasil logada no docker)
	docker buildx build --platform $(PLATFORMS) -t $(IMAGE):$(VERSION) -t $(IMAGE):latest --push .

e2e:       ## Playwright contra a pilha no ar (make up antes)
	pnpm e2e
