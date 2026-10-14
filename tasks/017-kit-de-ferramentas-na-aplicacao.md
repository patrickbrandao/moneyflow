---
status: aberta
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: alta
criada: 2026-10-14
commit:
---

# Kit de ferramentas na aplicação (F7)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [021](../docs/021-kit-de-ferramentas.md), seção "Aplicação (app)". O que fazer: `category` e modo sugerido no registro `AGENT_TOOLS`; `tools-runtime`/`needsConfirmation` pelo kit (sem kit = tudo `allow`; tools de admin fora para não admin); CRUD e duplicar kit; guia "Kit de Ferramentas" com categorias tri-estado e seletor allow/ask; campo "Kit" no agente; backup; testes de integração e e2e da spec.

Ordem: Depois da 016. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [021](../docs/021-kit-de-ferramentas.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **`packages/shared/src/agents/tools.ts`**:
  - sai `confirm`/`AgentToolConfirm` e `needsConfirmation(tool, agentRequires)` (l. 509);
  - entram `category`, o modo sugerido e `adminOnly?`, com as categorias fixas e a ordem delas.
  - Os 49 nomes da tabela da 021 batem com o registro atual (conferido).
- **Ainda em `packages/shared`**:
  - `agents/types.ts`;
  - `agents/schemas.ts`: `enabledTools`/`requireWriteConfirmation` viram `toolKitId`;
  - `i18n/errors.ts` e `i18n/areas/agents.ts`.
- **`apps/server/src/agents/tools-runtime.ts`**:
  - `RunTools.forAgent` (l. 86–129) filtra por `enabledTools`;
  - `requiresConfirmation(tool, agentRequires)` está na l. 135.
- **`apps/server/src/agents/runner.ts`**:
  - `AgentRow` (l. 62–63) e `loadContext` (l. 267) leem as colunas que saem;
  - `RunTools.forAgent` roda uma vez antes do laço (l. 135), mas a spec pede que o kit valha "na próxima chamada ao modelo";
  - é preciso recarregar a lista e os modos a cada iteração, sem reabrir as sessões MCP, e usar o modo do kit em `resolvePending` (l. 357).
- **`apps/server/src/services/ai-admin.ts`**:
  - `listToolCatalog` (l. 198) devolve `confirm`;
  - o CRUD do agente muda;
  - entram o CRUD e a duplicação do kit, e o 23503 traduzido com a lista dos agentes.
- **Rotas**: `/api/admin/ai/tool-kits` em `apps/server/src/routes/agents.ts`.
- **Backup**:
  - `apps/server/src/services/backup/catalog.ts`: `NATURAL_KEYS` com `ai_tool_kits: [['lower:name']]`, `COMPOSITE_KEYS` com `ai_tool_kit_tools: ['kit_id','tool_name']` e `OWNED_BY` com `ai_tool_kit_tools: ['kit_id']`;
  - conferir que o `import.ts` resolve `ai_agents.tool_kit_id` pela chave natural.
- **Web**:
  - `components/admin-ai/AgentsTab.tsx`: o campo Kit substitui as tools e a flag;
  - `ToolKitsTab.tsx`, nova;
  - `pages/AdminAiPage.tsx`: a guia entra em `TABS`, entre `agents` e `mcp`.
- **Testes**:
  - `apps/server/test/agents.test.ts` e `packages/shared/test/agents.test.ts` usam `enabled_tools`/`require_write_confirmation`;
  - teste que compara o retrato da migração (016) com `AGENT_TOOLS`;
  - e2e novo com `e2e/fakes/fake-llm.ts`.
- **Banco**: `pnpm db:pull` depois da 016.

**Riscos e observações**
- O `/mcp` (`routes/mcp.ts`) não usa o kit, e assim continua.
- Os fluxos seguem sem tools (`purpose ? []` no runner).
- Recarregar o kit a cada chamada pode mudar a lista de tools no meio de uma execução, o que invalida o cache de prompt da Anthropic. É aceitável.
- Uma confirmação já pendente fica como está, mesmo que o kit passe a `allow`.

**Dependências**
- Depende da 016.
- As 028, 029 e 033 dependem desta: categorias, `adminOnly` e o kit nos fluxos.

**Como verificar**
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Os testes da 021: fora do kit, `allow`, `ask` numa leitura, sem kit, kit em uso e a ida e volta no backup.
- O e2e do cartão de aprovação.

**Pontos para a revisão da spec**
1. (021, Testes) O teste "a tool de admin num kit, acionada por um usuário comum, não é oferecida" não tem com que ser feito na F7, porque não há tool `adminOnly` até a F13. E a F13a já precisa do filtro: `create_category`, `archive_caixa` e os membros de caixa usam `assertAdmin`. Recomendação: o campo `adminOnly` e o filtro entram na F7, e o teste usa uma tool de registro de teste.
2. (021 × 029) "Agente sem kit = poder completo, sem aprovação" vale só para as tools internas: as do MCP externo continuam pedindo confirmação, salvo `readOnlyHint`. Recomendação: dizer isso explicitamente na 021 e na 029.

## Resolução (executor)
