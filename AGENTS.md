# AGENTS.md

Guia para agentes de código (Claude Code, Codex e outros) neste repositório.

## Especificações

@docs/INDEX.md

As especificações em `docs/nnn-titulo.md` são a fonte da verdade do produto. Antes de implementar ou alterar algo, leia as que tratam do assunto, a partir do índice acima. Quando uma decisão mudar, atualize a especificação correspondente e o `docs/INDEX.md` na mesma mudança. Uma especificação nova segue a numeração `nnn` com zeros à esquerda.

## Banco de dados

Tudo o que é banco (PostgreSQL 18 + pgvector) fica em `database/` e é responsabilidade exclusiva do subagente **dba** (`.claude/agents/dba.md`, regras em [database/AGENTS.md](database/AGENTS.md)). Não edite `database/`: descreva a necessidade e delegue ao dba. Detalhes em [docs/016-banco-de-dados.md](docs/016-banco-de-dados.md).

## Estado do projeto

O banco está em construção em `database/` (comandos em `database/AGENTS.md`); a aplicação ainda não tem código. A implementação segue as fases de [docs/015-fases.md](docs/015-fases.md). Quando o monorepo existir, registre aqui os comandos reais de build, lint e teste, inclusive como rodar um teste isolado.

## Arquitetura prevista

- Monorepo pnpm: `apps/web` (console React 19 + Vite), `apps/server` (Fastify, um único artefato rodando como `api` ou `worker`), `packages/shared` (schemas Zod, tipos, definições das tools dos agentes) e `packages/db` (schema Drizzle gerado do banco por `drizzle-kit pull`, nunca editado à mão).
- Imagem única `tmsoftbrasil/moneyflow`; a API serve o SPA compilado. O compose da aplicação inclui `database/docker-compose.yml` e sobe api e worker. O GitHub Actions publica imagens multi-arch nas tags `v*`.
- A UI parte da skill `web-interface-admin-with-canva` do MCP `purple-skills-public` (use `get_skill` e `get_skill_file`). Siga as regras de design dela: só tokens, nenhum hex em componente, um único acento roxo, sem sombra em superfície fixa.
- As tools dos agentes são definidas uma vez em `packages/shared`, rodam com as permissões do usuário que acionou o agente e também são expostas pelo endpoint `/mcp` do próprio app. Tools de escrita exigem confirmação do usuário.
- Dinheiro em BRL, em centavos inteiros. Textos da UI em pt-BR e centralizados; identificadores de código e banco em inglês.
- Senhas ficam em texto puro de propósito. Nunca devolva senha pela API nem a inclua em logs, exports ou tools de agente; só a ação "revelar" do admin pode exibi-la.

## Configuração

- `.mcp.json` define um servidor MCP do projeto, `purple-skills-public`: um catálogo remoto de skills em `skills-mcp.langwizard.net` (`search_skills`, `get_skill`, `get_skill_file`, `download_skill`).
