# MoneyFlow — atalhos da raiz. O banco tem o próprio Makefile em database/.
SHELL := /bin/bash
IMAGE ?= tmsoftbrasil/moneyflow
VERSION ?= $(shell node -p "require('./package.json').version")
PLATFORMS ?= linux/amd64,linux/arm64

.PHONY: up down logs ps image release-check release e2e

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

# Portão da release (tarefa 078, docs/018): árvore limpa, o HEAD na tag v$(VERSION) e a verificação completa.
# VERIFY_ARGS vai para o verify:full (ex.: make release VERIFY_ARGS="--e2e" com a pilha no ar).
VERIFY_ARGS ?=
release-check:  ## confere a árvore e a tag e roda pnpm verify:full $(VERIFY_ARGS)
	@test -z "$$(git status --porcelain)" || { echo "release: há alterações não commitadas (git status); commite ou descarte antes." >&2; exit 1; }
	@test "$$(git tag --points-at HEAD --list 'v$(VERSION)')" = "v$(VERSION)" || { echo "release: o HEAD não é a tag v$(VERSION) (git tag v$(VERSION) no commit da versão)." >&2; exit 1; }
	pnpm verify:full $(VERIFY_ARGS)

# O contexto do build é o commit (git archive), nunca a árvore de trabalho; o :latest só vai junto se v$(VERSION)
# for a maior tag (uma correção de versão antiga não o move).
release: release-check  ## build multi-arch do commit e push de $(IMAGE):$(VERSION) (e :latest) com a conta tmsoftbrasil
	@newest="$$(git tag -l 'v[0-9]*' --sort=-v:refname | head -1)"; tags="-t $(IMAGE):$(VERSION)"; \
	if [ "$$newest" = "v$(VERSION)" ]; then tags="$$tags -t $(IMAGE):latest"; \
	else echo "release: v$(VERSION) não é a maior tag ($$newest); o :latest fica onde está."; fi; \
	set -o pipefail; git archive --format=tar HEAD | docker buildx build --platform $(PLATFORMS) $$tags --push -

e2e:       ## Playwright contra a pilha no ar (make up antes)
	pnpm e2e
