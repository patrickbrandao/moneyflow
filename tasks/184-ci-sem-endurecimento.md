---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 83af4a3
---

# CI sem `permissions`, sem `timeout-minutes`, actions e imagens por tag flutuante e o CI do `main` cancelável

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** cadeia de suprimentos e robustez do CI
- **Arquivos afetados:** `.github/workflows/ci.yml:1-87`, `.github/workflows/release.yml:11-42`, `Dockerfile:6-8`, `Dockerfile:22`, `Dockerfile:31-40`, `docker-compose.yml:48`, `database/docker/Dockerfile:2`, `apps/server/test/global-setup.ts:33-35`
- **Depende de / relacionado a:** tarefa 078
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A automação que testa e publica o sistema confia em versões "móveis" de ferramentas de terceiros e dá ao robô do GitHub as permissões padrão do repositório. Se uma dessas ferramentas for trocada por uma versão maliciosa, ela roda com acesso ao segredo do Docker Hub. Além disso, um teste travado pode consumir até 6 horas de máquina, e dois pushes seguidos no `main` cancelam a verificação do primeiro.

### Evidência e análise técnica
1. **Actions por tag, não por SHA.** `actions/checkout@v4`, `pnpm/action-setup@v4` (terceiro), `actions/setup-node@v4`, `docker/setup-buildx-action@v3`, `docker/build-push-action@v6`, `actions/upload-artifact@v4` (`ci.yml:17-19`, `:36`, `:52-55`, `:70-72`, `:80`); `docker/setup-qemu-action@v3`, `docker/metadata-action@v5`, `docker/login-action@v3` (`release.yml:17-34`). No `release.yml`, esses passos rodam no mesmo job que recebe `DOCKERHUB_TOKEN` (`release.yml:27-31`).
2. **Sem `permissions:`** em nenhum dos dois workflows: o `GITHUB_TOKEN` fica com o padrão do repositório (em repositórios antigos, leitura e escrita em tudo). O CI só precisa de `contents: read`.
3. **Sem `timeout-minutes`** em nenhum job: o padrão do GitHub é 360 minutos. O job `image` sobe a pilha, os falsos em portas fixas e o Playwright (`ci.yml:62-78`); um travamento (por exemplo, a porta ocupada que derruba o worker do Playwright, ver tarefa 125) segura o runner por 6 h.
4. **`cancel-in-progress: true` também no `main`** (`ci.yml:8-10`, grupo `ci-${{ github.ref }}`): dois pushes seguidos no `main` cancelam o CI do primeiro commit, que fica sem resultado — e pode ser o commit que recebe a tag de release.
5. **Imagens flutuantes.** `ARG NODE_VERSION=22` → `node:22-bookworm-slim` (`Dockerfile:6-8`, `:22`) muda a cada patch do Node; `postgresql-client-18` sem versão e a chave do PGDG baixada por `curl` sem conferir a impressão digital (`Dockerfile:31-40`); `ghcr.io/amacneil/dbmate:2` (`docker-compose.yml:48`); `pgvector/pgvector:pg18` (`database/docker/Dockerfile:2`). Duas builds da mesma tag em dias diferentes geram imagens diferentes, e nada registra qual base entrou.
6. **A imagem do banco é construída três vezes por execução**, sem cache entre jobs: pelo Testcontainers no job `check` (`global-setup.ts:33-35`, `withCache(true)` só vale na máquina), pelo `make -C database test` no job `database` e pelo `docker compose up` no job `image`. Cada uma roda `apt-get install postgresql-18-pgtap`.
7. **Sem checagem de artefatos gerados**: nada confere que `packages/db/src/generated` (`pnpm db:pull`) e `database/schema.sql` (`make dump`) batem com `database/migrations`; um esquecimento só aparece em runtime.

### Verificação (tentativa de refutação)
- O item de dependências vulneráveis e a falta de `pnpm audit`/Dependabot já foram registrados pelo coordenador; este achado não trata disso.
- Hoje o `generated` e o `schema.sql` estão em dia com a última migration (mesma data de commit da 0056), então o item 7 é preventivo.
- `docker/build-push-action@v6` gera atestado de proveniência mínimo por padrão ao fazer push; SBOM não é gerado. Não é defeito, mas é barato ligar (`sbom: true`).

### Impacto
Superfície de ataque na cadeia de suprimentos no job que tem o segredo de publicação; minutos de runner desperdiçados num travamento; commits do `main` sem resultado de CI; builds não reproduzíveis.

## Como reproduzir
1. Ler os dois workflows: nenhum `permissions:`, nenhum `timeout-minutes:`, nenhuma action com `@<sha>`.
2. Fazer dois pushes no `main` com segundos de intervalo: o primeiro aparece como "cancelled".

## Solução proposta
1. `permissions: { contents: read }` no topo dos dois workflows (o `release.yml` não precisa de mais nada para o Docker Hub; acrescentar `id-token: write`/`attestations: write` só se usar atestado do GitHub).
2. Fixar todas as actions por SHA com o comentário da versão (`actions/checkout@<sha> # v4.2.2`) e deixar o Dependabot (`github-actions`) atualizá-las.
3. `timeout-minutes`: 20 no `check`, 15 no `database`, 30 no `image`, 30 no `release`.
4. `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.
5. Fixar as bases por digest: `node:22.x.y-bookworm-slim@sha256:…`, `dbmate:2.x.y`, `pgvector/pgvector:0.x.y-pg18` (este pelo dba), e conferir a impressão digital da chave do PGDG.
6. Construir a imagem do banco uma vez (job próprio com `docker/build-push-action` e cache `type=gha`, ou `cache-from` no compose) e reaproveitar.
7. Um passo no CI: subir o banco, `pnpm db:pull` e `make -C database dump`, depois `git diff --exit-code packages/db/src/generated database/schema.sql`.

### Diff/patch proposto — NÃO APLICADO
```yaml
# .github/workflows/ci.yml
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  check:
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<sha>  # v4
```

## Critérios de aceite
- [ ] Os dois workflows com `permissions` mínimas e `timeout-minutes` em todo job.
- [ ] Nenhuma action referenciada por tag móvel.
- [ ] Push no `main` não cancela o CI anterior.
- [ ] Bases da imagem fixadas por versão completa (e digest).
- [ ] O CI falha se o schema gerado ou o `schema.sql` estiverem defasados.

## Testes recomendados
Rodar o CI num PR de teste e conferir no log o `GITHUB_TOKEN Permissions: Contents: read`, e um PR que adiciona uma migration sem `db:pull` falhando no passo novo.

## Limitações e suposições
Não vi as configurações do repositório no GitHub (permissões padrão do token, proteção de branch, secrets). Nada foi executado.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado no código atual: nenhum `permissions` nem `timeout-minutes` nos dois workflows; todas as actions por tag (`@v3`–`@v6`); `cancel-in-progress: true` também no `main`; `node:22-bookworm-slim` sem digest; a chave do PGDG baixada sem conferência; `dbmate:2` no compose da raiz; a imagem do banco construída do zero no `check` (Testcontainers), no `database` (`make test`) e no `image` (compose). A parte do banco (pgvector e pgTAP fixos, dbmate do `database/docker-compose.yml`) já tinha sido feita pelo dba na tarefa 163.

## Resolução (executor)

1. **`permissions: contents: read`** no topo do `ci.yml` e do `release.yml` (o push ao Docker Hub usa o secret, não o token).
2. **Actions pelo SHA do commit**, com a versão no comentário (`actions/checkout@11d5960… # v4.4.0`). Decisão: a última versão da major que já estava em uso (checkout/setup-node/pnpm v4, upload-artifact v4, buildx v3, build-push v6, qemu v3, metadata v5, login v3), para não mudar comportamento sem rodar o CI; as majors novas chegam pelo Dependabot de `github-actions` (tarefa 071), cada uma num PR com o CI. SHAs tirados com `git ls-remote` das tags.
3. **`timeout-minutes`**: `check` 30, `database` 20, `image` 45 (o e2e ficou serial na tarefa 125) e a imagem da release 60 (multi-arch com QEMU). O job que chama o CI reutilizável não aceita a chave; os jobs dele já têm.
4. **`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`**: o `main` e a tag nunca cancelam a execução anterior.
5. **Bases fixas**: `FROM node:26.13.1-bookworm-slim@sha256:5df7998…` (o índice multi-arch, conferido com `docker buildx imagetools inspect`), num estágio `node-base` usado pelo build e pelo runtime; a chave do PGDG conferida por `sha256sum -c` (`ARG PGDG_KEY_SHA256`, o mesmo hash do arquivo baixado hoje; a impressão digital no comentário); `dbmate:2.38.2` no compose da raiz (a mesma do `database/docker-compose.yml`). Decisão: o `postgresql-client-18` fica sem versão do apt, porque o PGDG só mantém a mais nova no repositório e um pin quebraria o build a cada versão menor; a major é a do servidor.
6. **Imagem do banco uma vez**: os três jobs constroem `database/docker` com o `docker/build-push-action` e o cache do GitHub (`type=gha,scope=postgres`), então o `apt-get` do pgTAP roda uma vez e os jobs usam a mesma imagem. O Testcontainers aceita a imagem pronta por `MONEYFLOW_TEST_PG_IMAGE` (`apps/server/test/global-setup.ts`), e o compose do job `image` sobe sem `--build`. O `make -C database test` do job `database` ainda chama `compose up --build` (`database/Makefile`, do dba), que reaproveita as camadas do builder já aquecido.
7. **Artefatos gerados conferidos** (com a tarefa 163): `make -C database dump` + `git diff --exit-code database/schema.sql database/privileges.sql` no job `database`, e o schema Drizzle por `test/generated-schema.test.ts` na integração do `check`.
- Release: `sbom: true` e `provenance: mode=max` no `build-push-action`.
- `scripts/check-versions.mjs` (job `check`) impede a volta: action sem SHA ou sem o comentário da versão, workflow sem `permissions`, job sem `timeout-minutes`, `FROM` sem digest nos dois Dockerfiles, dbmate sem versão completa ou diferente entre os compose.
- Dependabot: a base do banco (`/database/docker`) entrou junto da imagem da aplicação.

Testes: `scripts/check-versions.test.mjs` (`pnpm test:scripts`): action por tag, SHA sem versão, falta de `permissions` e de `timeout-minutes`, `FROM` sem digest e dbmate solto ou divergente são acusados, e o repositório passa. O CI em si não roda daqui: o primeiro PR mostra o token só de leitura no log e o tempo dos jobs.

Verificação: rápida, `pnpm verify:quick --base 290403d` (só o que esta frente mudou; o portão do lint, o typecheck de todos os pacotes e os testes de integração tocados no Postgres local), `pnpm test:scripts` e o build do servidor com o target `node26`.
