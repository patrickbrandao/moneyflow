# 001 — Stack e entrega

| Tema | Decisão |
|---|---|
| Frontend | Template da skill `purple-skills-public:web-interface-admin-with-canva`: React 19, Vite, TypeScript, Tailwind 4, React Flow, cmdk, lucide. Seguir as regras de design da skill (tokens, sem hex em componentes, um único acento, sem sombra em superfície fixa). O acento é azul nos dois temas (o roxo do template foi trocado em 2026-10-11, tarefa 007); nenhuma cor da interface, do logo ou da paleta de categorias `--port-1`…`--port-12` fica na faixa roxa (matiz 250°–320°). |
| Backend | Node + TypeScript, Fastify, Drizzle ORM (só consultas; schema gerado do banco), Zod. |
| Banco | PostgreSQL 18 + pgvector, em `database/`, gerido pelo agente DBA ([016](016-banco-de-dados.md)). Migrations SQL com dbmate, testes pgTAP. Anexos também no Postgres (`bytea`, tabela própria, limite por arquivo). |
| Repositório | Monorepo pnpm em `github.com/patrickbrandao/moneyflow`: `apps/web`, `apps/server` (modos `api` e `worker`), `packages/shared` (schemas Zod, tipos, definições das tools dos agentes), `packages/db` (schema Drizzle gerado do banco). O banco fica em `database/`, fora dos workspaces. |
| Qualidade | Biome (lint/format), pgTAP no banco, Vitest + Testcontainers (Postgres 18 real) para regras financeiras, Playwright nos fluxos principais. |
| Imagem | Imagem única `tmsoftbrasil/moneyflow`: a API serve o SPA compilado; o mesmo artefato roda como `api` ou `worker`. |
| Ambiente local | Docker Compose: o compose da raiz inclui `database/docker-compose.yml` (Postgres 18 + pgvector), aplica as migrations num one-shot (dbmate) e sobe `api` e `worker`. O Postgres dessa pilha tem volume próprio e sai na porta 5433, para conviver com o banco de desenvolvimento de `database/` (5432), usado por `pnpm dev`. |
| CI/CD | GitHub Actions: lint, typecheck, testes e build em PRs/main. Em tag `v*`: build multi-arch (amd64+arm64) e push `:X.Y.Z` e `:latest` (secrets `DOCKERHUB_USERNAME` e `DOCKERHUB_TOKEN`). `make release` para push local (conta `tmsoftbrasil` autorizada na máquina). |
| Locale | Interface pt-BR com strings centralizadas (i18n-ready), fuso `America/Sao_Paulo`, `dd/mm/aaaa`, `R$ 1.234,56`. Código e banco em inglês. |
| Moeda | Só BRL, valores em centavos (`bigint`). |
