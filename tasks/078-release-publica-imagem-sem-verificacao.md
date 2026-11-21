---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: alta
criada: 2026-11-21
commit:
---

# Release publica `:X.Y.Z` e `:latest` sem verificação e a partir da árvore de trabalho

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** publicação da imagem sem portão de qualidade
- **Arquivos afetados:** `Makefile:24-25`, `.github/workflows/release.yml:7-42`, `docs/018-versoes-e-publicacao.md:11-12`, `AGENTS.md:22`, `AGENTS.md:41`
- **Depende de / relacionado a:** tarefa 184 (mesma área, assunto diferente)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A imagem que vai para a produção pode sair sem que os testes tenham rodado, e pode até levar arquivos que nunca foram commitados. O `:latest`, que a produção consome, é movido sempre, inclusive por uma tag de correção de uma versão antiga.

### Evidência e análise técnica
Há dois caminhos de publicação, e nenhum deles verifica nada:

1. **`make release`** (o "padrão hoje", `docs/018-versoes-e-publicacao.md:11`):
   ```make
   release:
   	docker buildx build --platform $(PLATFORMS) -t $(IMAGE):$(VERSION) -t $(IMAGE):latest --push .
   ```
   (`Makefile:24-25`). O contexto do build é `.`, a árvore de trabalho: uma alteração não commitada em `apps/` ou `packages/` entra na imagem (`Dockerfile:18-19` copia `packages` e `apps` inteiros; `.dockerignore` só tira `node_modules`, `dist`, `.env*`, `.git`, `.local`, `docs`, `database`). Não confere se o `HEAD` é a tag `v$(VERSION)`, nem se a árvore está limpa, nem roda `pnpm verify:full`. A `VERSION` vem do `package.json` (`Makefile:4`), não da tag.
2. **`release.yml`**: dispara em `push` de tag `v*` (`release.yml:7-9`) e faz só QEMU, buildx, login e `build-push-action` (`release.yml:17-42`). Não tem `needs`, não depende do `ci.yml` (nem por `workflow_run`), não roda lint, typecheck, testes nem e2e. As tags vêm de `type=semver,pattern={{version}}` e `type=raw,value=latest` (`release.yml:24-26`): o `latest` é movido em toda tag, até numa `v0.1.21.1` criada depois da `v0.1.22`.

`AGENTS.md:22` e `AGENTS.md:41` dizem que `pnpm verify:full` roda "antes de release", mas o passo a passo de `docs/018-versoes-e-publicacao.md:11` não o inclui, e nada o exige.

### Verificação (tentativa de refutação)
- Procurei um portão no `ci.yml`: ele roda em `pull_request` e `push` para `main` (`ci.yml:3-6`), nunca em tag; o `concurrency` com `cancel-in-progress: true` (`ci.yml:8-10`) pode inclusive cancelar o CI do commit que depois recebe a tag.
- Procurei um hook ou script que rode antes do `make release`: não há (`.git/hooks` só com os `.sample`, nenhum husky/lefthook no repositório).
- O `.dockerignore` não exclui código-fonte modificado (nem poderia), então a árvore suja vai para a imagem.

### Impacto
Uma release com teste quebrado, ou com um arquivo de depuração esquecido, chega ao Docker Hub e ao `:latest`, que é o que o projeto externo de produção consome (`docs/018-versoes-e-publicacao.md:17`). Acontece em toda release feita às pressas; o custo é um deploy ruim e uma imagem `X.Y.Z` que não corresponde à tag git.

## Como reproduzir
1. Altere qualquer arquivo de `apps/server/src` sem commitar.
2. `make release` (com a conta logada): a imagem `tmsoftbrasil/moneyflow:<versão>` sai com a alteração e o `:latest` é movido.
3. Ou: `git tag v0.1.99 <commit com teste falhando> && git push --tags` com os secrets configurados: o `release.yml` publica sem rodar teste.

## Solução proposta
1. No `Makefile`, um alvo `release-check` chamado por `release`: falha se `git status --porcelain` não for vazio, se `git describe --exact-match --tags HEAD` não for `v$(VERSION)`, e roda `pnpm verify:full`.
2. Construir a partir do commit, não da árvore: `docker buildx build ... "$$(git rev-parse --show-toplevel)"` só depois do `release-check`, ou `git archive HEAD | docker buildx build ... -`.
3. No `release.yml`: um job `verify` (lint, typecheck, unitários, integração, build) e `image` com `needs: verify`; ou `on: workflow_run` do CI concluído com sucesso para a tag.
4. Mover `latest` só quando a tag é a maior semver: `type=raw,value=latest,enable=${{ ... }}` ou `flavor: latest=auto` do `metadata-action` (que já ignora pré-release).
5. Atualizar `docs/018-versoes-e-publicacao.md:11` com o passo da verificação.

### Diff/patch proposto — NÃO APLICADO
```make
release-check:
	@test -z "$$(git status --porcelain)" || { echo "árvore suja: commite antes"; exit 1; }
	@test "$$(git describe --exact-match --tags HEAD 2>/dev/null)" = "v$(VERSION)" || { echo "HEAD não é a tag v$(VERSION)"; exit 1; }
	pnpm verify:full

release: release-check
	docker buildx build --platform $(PLATFORMS) -t $(IMAGE):$(VERSION) -t $(IMAGE):latest --push .
```

## Critérios de aceite
- [ ] `make release` com a árvore suja ou fora da tag falha antes do build.
- [ ] `make release` roda a verificação completa antes do push.
- [ ] O `release.yml` só publica depois de lint, typecheck e testes passarem no mesmo commit.
- [ ] Uma tag de correção de versão antiga não move o `latest`.
- [ ] `docs/018` descreve o novo fluxo.

## Testes recomendados
Não há teste automatizado; conferir à mão: `make release` com um arquivo alterado (deve recusar) e uma tag de teste num fork com um teste quebrado (o workflow deve parar no job de verificação).

## Limitações e suposições
Nada foi executado. Não sei se o repositório tem os secrets do Docker Hub configurados (sem eles o `release.yml` só constrói). Não vi o projeto externo de produção, que pode fixar a versão em vez de usar `:latest`.

## Análise (triagem)

## Resolução (executor)
