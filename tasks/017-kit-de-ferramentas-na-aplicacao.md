---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: alta
criada: 2026-10-14
commit: (sem commit; a sessão principal commita na branch spec/f7-agentes-ia)
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
Feito pelo app em 2026-10-14, na branch `spec/f7-agentes-ia`, sem commit (a sessão principal commita). `pnpm db:pull` rodado (schema gerado com `ai_tool_kits`, `ai_tool_kit_tools` e `ai_agents.tool_kit_id`).

**Registro (`packages/shared/src/agents/tools.ts`)**
- Saíram `confirm`/`AgentToolConfirm` e `needsConfirmation(tool, agentRequires)`.
- Entraram `category` (8 categorias fixas em `AGENT_TOOL_CATEGORIES`, nomes em `t.agents.toolCategories`), `suggestedMode` (leituras e `notify_user` em `allow`, demais escritas em `ask`), `adminOnly?` e `secrets?`, além de `AGENT_TOOL_MODES`, `effectiveToolMode()` e `kitTools(registry, kit, isAdmin)`: sem kit, todas em `allow`; com kit, só as dele no modo dele; segredo sempre `ask`; `adminOnly` fora para quem não é admin.
- Entradas: `toolKitCreateInput`/`toolKitUpdateInput`/`toolKitDuplicateInput` (modo obrigatório, sem tool repetida); no agente, `toolKitId` no lugar de `enabledTools`/`requireWriteConfirmation`. DTOs `AiToolKitDto`, `AgentToolInfo` (com `category`, `destructive`, `suggestedMode`, `adminOnly`, `secret`) e `AiAgentDto.toolKitId/toolKitName`.
- Erros do banco traduzidos (`i18n/errors.ts`): `ai_agents_tool_kit_id_fkey`, `ai_tool_kits_name_key`, `ai_tool_kits_name_check`, `ai_tool_kits_description_check`, `ai_tool_kit_tools_pkey`, `ai_tool_kit_tools_mode_check`, `ai_tool_kit_tools_tool_name_check`. Auditoria nomeia as duas tabelas e as colunas `tool_name`, `mode`, `tool_kit_id`.

**Execução (`apps/server/src/agents/`)**
- `tools-runtime.ts`: `RunTools.forAgent(db, agentId, headersFor, { internal, mcp, isAdmin })` monta as MCP uma vez e as internas por `refreshInternal()` (lê `ai_agents.tool_kit_id` → `ai_tool_kit_tools` em `loadAgentKit`). `requiresConfirmation(tool)`: internas pelo modo do kit; MCP como antes (escrita salvo `readOnlyHint`). `registerInternalTool()` serve só aos testes (a tool `adminOnly` do teste).
- `runner.ts`: não lê mais as colunas removidas; relê o kit no começo de cada volta do loop (antes de resolver pendências e de chamar o modelo), sem reabrir as sessões MCP. Fluxos seguem sem tools. Confirmação já pendente fica como está.
- `/mcp`: continua sem kit; só tira as `adminOnly` de quem não é admin.

**API (`services/ai-admin.ts`, `routes/agents.ts`)**
- `GET/POST /api/admin/ai/tool-kits`, `GET/PATCH/DELETE /api/admin/ai/tool-kits/:id`, `POST /api/admin/ai/tool-kits/:id/duplicate` ("Cópia de <nome>", " (n)" se colidir). `tools` no PATCH substitui o conjunto e grava só o que mudou. Nomes fora do registro: 400. Kit em uso: 422 com os nomes dos agentes (inclusive arquivados). Tudo em `withTx`.
- Agente: `toolKitId` (kit inexistente: 400); a lista devolve `toolKitName`. `GET /api/admin/ai/tools` devolve categoria, tipo, destrutiva, modo sugerido, `adminOnly` e `secret`.

**Tela**
- Nova guia "Kit de Ferramentas" (`/admin/ai/tool-kits`, entre Agentes e MCP; `components/admin-ai/ToolKitsTab.tsx`): lista com tools leitura/escrita, quantas em ask e os agentes; edição com categorias recolhíveis e checkbox tri-estado, "todas allow"/"todas ask" por categoria, selo Leitura/Escrita/Destrutiva (e Só admin/Segredo), seletor allow/ask, busca, "só incluídas", "não incluída" nas de fora, duplicar (na linha e no modal) e remover.
- Formulário do agente: o campo "Kit de ferramentas" (ou "Sem kit — todas as ferramentas, sem aprovação") substitui a lista de tools e a flag; a lista de agentes mostra o kit.

**Backup**
- `catalog.ts`: `ai_tool_kits` com chave natural `lower(name)`; `ai_tool_kit_tools` em `COMPOSITE_KEYS` (`kit_id`, `tool_name`) e `OWNED_BY` (`kit_id`). `import.ts` passou a aceitar parte não-FK (texto) na chave composta.
- Decisão nova (registrada na 021 e na 019): arquivo anterior à F7 (agente com `enabled_tools`/`require_write_confirmation`, sem `tool_kit_id`) é convertido na importação do JSON completo pela regra da migração 0038, com `ai_legacy_tool_registry()`; o agente que já existe no banco (id ou nome) fica como está. Sem isso, um backup antigo daria poder completo a agentes que pediam confirmação.

**Testes**
- `packages/shared/test/agents.test.ts`: categorias e modo sugerido, `kitTools` (sem kit, kit, segredo, `adminOnly`), entrada do kit.
- `apps/server/test/agents.test.ts` (o agente principal agora usa um kit no modo sugerido; o "Conciliador" ficou sem kit): CRUD/duplicar/validação/unicidade/auditoria; kit em uso não excluído (agente ativo e arquivado); fora do kit não chega ao modelo e, chamada mesmo assim, vira erro; escrita em `allow` sem `ai_tool_confirmations`; leitura em `ask` pede; sem kit tudo direto com todas as tools; tool `adminOnly` (registrada no teste) só para admin; kit relido na próxima chamada da mesma execução; retrato `ai_legacy_tool_registry()` × `AGENT_TOOLS` (49/25, tipo e modo).
- `apps/server/test/backup.test.ts`: ida e volta do kit num banco novo, reimportar sem duplicar, kit casado pelo nome, conversão de arquivo antigo nos três casos da migração.
- `e2e/tests/agentes.spec.ts`: o agente do e2e usa um kit no modo sugerido; teste novo cria o kit marcando Conciliação, "todas allow", `ignore_statement_lines` em ask, liga ao agente, vê o cartão (só as 13 tools da conciliação foram ao modelo) e aprova.

**Verificação**: `pnpm lint`, `pnpm typecheck`, `pnpm test` (Testcontainers: shared 121, server 118) e `pnpm build` passaram. e2e contra a pilha Docker reconstruída: `agentes.spec.ts` (6, inclusive o novo), `tema.spec.ts` e `backup.spec.ts` passaram.

**Docs**: 011 (tools e confirmação pelo kit), 021 (detalhes da API, execução e backup), 019 (kit no merge e arquivos antigos), `docs/INDEX.md` e `AGENTS.md`.
