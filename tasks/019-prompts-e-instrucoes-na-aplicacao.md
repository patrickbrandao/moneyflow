---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-14
commit:
---

# Montagem do prompt, variáveis, versões e instructions do MCP na aplicação (F8)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [022](../docs/022-prompts-e-instrucoes.md), seção "Aplicação (app)". O que fazer: `buildSystemPrompt` na ordem da spec com dois pontos de cache; instruções do usuário em Minha conta → IA; contexto automático; variáveis `{{…}}` (validação ao salvar, voláteis fora do cache); histórico/diff/restaurar; "Ver prompt montado"; `instructions` do `initialize` no cache do MCP e o modo por servidor.

Ordem: Depois da 018. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [022](../docs/022-prompts-e-instrucoes.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **`apps/server/src/agents/runner.ts`**: `buildSystemPrompt` (l. 75–89) hoje tem duas partes:
  - `stable`: a base, o prompt e o prompt do fluxo;
  - `volatile`: a data, o usuário e a tela.
  - Passa a ter três partes: estável, por usuário e volátil.
  - As `instructions` dos MCP no modo `user` entram como um bloco `user` no início do histórico montado (`balanceToolUses(toNeutral(rows))`, l. ~165), sem gravar em `ai_messages`.
- **`apps/server/src/agents/llm/types.ts` e `anthropic.ts`** (l. 136–139):
  - hoje os pontos de cache ficam na última tool e no system estável;
  - entra o segundo ponto, que dá 3 dos 4 que a Anthropic aceita.
- **`openai.ts`**: concatena as partes na mesma ordem, sem marcas de cache.
- **MCP**: `agents/mcp-client.ts` (`connectMcp`) e `services/ai-admin.ts` (`refreshMcpServer`, l. ~477, grava `tools_cache`) passam a guardar as `instructions` do `initialize`.
- **Contexto automático**: montado a partir de `Access` (`authz/access.ts`), com o limite de 60 caixas e 300 contas.
- **Variáveis**:
  - parser com o escape `\{{`;
  - validação em `aiAgentCreateInput` e `aiAgentUpdateInput` (`packages/shared/src/agents/schemas.ts`);
  - as voláteis levam o prompt para depois do ponto de cache 2.
- **Versões**: o diff usa `packages/shared/src/text-diff.ts`, que já existe.
- **Rotas novas** em `routes/agents.ts`.
- **Web**:
  - `pages/AccountPage.tsx`: guia IA;
  - `components/admin-ai/AgentsTab.tsx`: variáveis, "Ver prompt montado" e Histórico;
  - `McpTab.tsx`: modo e texto em cache.
- **Backup** (`catalog.ts`):
  - `user_ai_settings` não tem `id`: precisa de `COMPOSITE_KEYS ['user_id']` e de entrar no recurso `users`;
  - as versões entram como filhas do agente (`OWNED_BY`).

**Riscos e observações**
- As `instructions` de um MCP são texto de terceiros e podem trazer injeção de prompt. O padrão `ignore` mitiga.
- O cache por usuário aumenta as gravações de cache. A spec aceita isso.
- Conferir `getInstructions()` no `Client` do `@modelcontextprotocol/sdk` 1.32.1.

**Dependências**
- Depende da 018.

**Como verificar**
- Os testes da 022: ordem e conteúdo, variáveis, contexto de um viewer, versões e restaurar, fluxo sem as instruções do usuário.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` e o e2e do histórico e da restauração.

**Pontos para a revisão da spec**
1. (022, Variáveis e Contexto automático) `users` não tem nome nem caixa principal.
   - A tabela tem só `username`, `email`, `role` e `is_active` (spec 002).
   - A "caixa principal" pertence ao titular (`caixas.is_primary`, por entidade), e o usuário não está ligado a nenhuma entidade.
   - Ficam sem fonte `{{usuario.nome}}`, `{{usuario.caixa_principal}}`, `{{empresa.titular_principal}}`, a "caixa principal" do contexto e o título "Instruções de <nome do usuário>".
   - Recomendação:
     - `usuario.nome` passa a ser o `username`;
     - entra `user_ai_settings.primary_caixa_id`, opcional e escolhida em Minha conta → IA entre as caixas legíveis, que alimenta `usuario.caixa_principal` e `empresa.titular_principal` (o titular dela);
     - sem valor, a variável fica vazia.
   - Alternativa: remover essas variáveis.
2. (022, Instruções do usuário) "O admin as vê no detalhe do usuário" não tem rota. Recomendação: `GET /api/admin/users/:id/ai`.

## Resolução (executor)
Feito pelo app em 2026-10-14, na branch `spec/f7-agentes-ia`, sem commit (a sessão principal commita). `pnpm db:pull` rodado (`user_ai_settings`, `ai_agent_prompt_versions`, colunas novas de `mcp_servers` e da visão).

**Montagem do prompt (`apps/server/src/agents/prompt.ts`, novo)**
- `assemblePrompt` (puro) devolve três partes na ordem da spec e o bloco user dos MCP:
  - estável: base, prompt do agente com as variáveis estáveis, MCP `system` ("Instruções do servidor MCP <nome>") e prompt do fluxo;
  - por usuário: "Instruções de <login>" (nunca nos fluxos) e o contexto automático;
  - volátil: o prompt do agente quando usa variável volátil, a data, o usuário e a tela.
- `loadPromptInputs` lê uma vez por execução as instruções, a caixa principal (só se ainda legível e não arquivada), o contexto (`autoContext`, pelo `Access`: até 60 caixas contando os cartões e 300 contas, com "lista parcial: use list_caixas") e as `instructions` de `effective_agent_mcp_servers` fora do modo `ignore`. Fluxos: sem instruções do usuário e sem MCP.
- `runner.ts`: `buildSystemPrompt` saiu; o bloco dos MCP `user` entra no início do histórico enviado, sem gravar em `ai_messages`.
- `llm/types.ts` ganhou `systemUser`. `anthropic.ts` põe o 2º ponto de cache no fim dessa parte (com a última tool, são 3 dos 4). `openai.ts` concatena na mesma ordem.

**Variáveis (`packages/shared/src/agents/prompt-vars.ts`, novo)**
- O registro `PROMPT_VARIABLES` e as funções `scanPromptVariables`, `renderPromptVariables` (escape `\{{`) e `volatilePromptValues` (`mes_ano` = "outubro de 2026").
- `aiAgentCreateInput`/`aiAgentUpdateInput` recusam variável desconhecida (400, com o nome) e aceitam `promptNote`.

**Versões e MCP (`services/ai-admin.ts`)**
- Criar o agente insere a versão 1 na mesma transação (autor e nota). Mudar o prompt = `INSERT` na tabela de versões (o mesmo prompt não cria versão; o `UPDATE` não toca mais `system_prompt`).
- `listPromptVersions`, `restorePromptVersion` (versão nova com `restored_from_version_id` e "Restaurada da versão N") e `previewPrompt` (o prompt de um usuário, com as partes e os pontos de cache). `AiAgentDto.promptVersion`.
- MCP: `instructionsMode` no criar e no editar. O `refreshMcpServer` grava `instructions_cache` (de `getInstructions()`, cortado em 50 mil) junto com o `tools_cache`. `McpServerDto.instructionsMode` e `instructions`.
- `mcp-client.ts`: `session.instructions()`.

**Minha conta → IA (`services/ai-settings.ts`, novo)**
- `GET/PUT /api/account/ai` faz upsert por `ON CONFLICT (user_id)`. A caixa principal passa pelo `Access`: fora das legíveis, 404 com mensagem; cartão, 422.
- `GET /api/users/:id/ai` é a leitura do admin (decisão registrada na 022, no lugar de `/api/admin/users/:id/ai`).

**Rotas** (`routes/agents.ts`)
- `GET /api/admin/ai/agents/:id/prompt-versions`;
- `POST /api/admin/ai/agents/:id/prompt-versions/:versionId/restore`;
- `POST /api/admin/ai/agents/:id/prompt-preview` (`userId`).

**Erros** (`i18n/errors.ts`)
- Os da 018: `ai_agents_system_prompt_version_check`, `ai_agent_prompt_versions_{version,immutable,note,content}_check`, `_restored_from_version_id_fkey` e `_restored_self_check`, `user_ai_settings_{primary_caixa,instructions}_check`, `mcp_servers_instructions_{mode,cache}_check`.
- A auditoria nomeia as duas tabelas novas.

**Backup (`catalog.ts`)**
- `ai_agents` e `ai_agent_prompt_versions` em `DEFERRED_CLUSTER`;
- `OWNED_BY.ai_agent_prompt_versions = ['agent_id']`;
- `user_ai_settings` em `COMPOSITE_KEYS`/`OWNED_BY` (`['user_id']`) e no recurso `users`.

**Tela**
- Minha conta: painel IA (`components/account/AiSettingsPanel.tsx`) com as instruções (contador de 20 mil) e a "Minha caixa principal" (caixas comuns legíveis).
- Usuários: ação "Instruções de IA" (leitura, admin).
- Agente (`AgentsTab.tsx` + `AgentPrompt.tsx`):
  - versão atual, lista de variáveis (clicar insere no cursor), aviso de variável desconhecida e o de volátil ("…não será cacheado");
  - "Nota da versão" quando o prompt muda;
  - "Histórico", com conteúdo, diff A→B pelo `text-diff.ts` e restaurar com confirmação;
  - "Ver prompt montado": escolhe o usuário e mostra as partes com os pontos de cache.
  - O histórico e o prompt montado abrem dentro do próprio modal.
- MCP: modo das instruções no formulário. O detalhe mostra o modo e o texto em cache, com o aviso de que ele vai ao modelo.
- Correção encontrada pelo e2e (`components/ui.tsx`): a confirmação (`useConfirm`) pedida de dentro de um modal abria por baixo dele. Agora sai por portal no `<body>`, acima dos modais.

**Testes**
- `packages/shared/test/prompt-vars.test.ts`: parser, escape, render, voláteis e recusa no schema.
- `apps/server/test/agent-prompts.test.ts` (8, novo):
  - Minha conta → IA (upsert, caixa ilegível e cartão, leitura do admin, auditoria com o ator);
  - ordem e conteúdo das três partes com os `cache_control`, nos modos MCP `ignore`/`system`/`user` (bloco user não gravado) e sem instruções;
  - cache de 50 mil, sem auditoria no refresh;
  - variável desconhecida (400) e volátil fora das partes cacheadas, com preview;
  - contexto de um viewer: só a caixa dele, com conta, papel, cartão e caixa principal; perder o acesso a tira;
  - corte em 60 caixas;
  - versões (nota, autor, sem versão quando o prompt não muda, restaurar, versão de outro agente 404, 403 para não admin, UPDATE direto recusado, ator na auditoria);
  - fluxo de leitura de documento sem as instruções do usuário nem o MCP, mas com o contexto.
- `apps/server/test/backup.test.ts`:
  - ida e volta das versões (ids, números, notas e restauração preservados; reimportar não duplica; arquivo sem versões ganha a 1);
  - `user_ai_settings` no recurso usuários, com a caixa ausente anulada.
- `e2e/tests/agentes.spec.ts`:
  - editar o prompt, ver o histórico e o diff, restaurar, inserir `{{data}}` (aviso) e "Ver prompt montado" com 2 pontos de cache;
  - Minha conta → IA salva.

**Verificação**
- `pnpm lint` e `pnpm typecheck` passaram.
- `pnpm test` (Testcontainers) passou: shared com 125 testes, server com 128.
- `pnpm build` passou.
- e2e completo contra a pilha Docker reconstruída (`TELEGRAM_API_BASE=http://host.docker.internal:18081`): 21 passaram, inclusive os 8 de `agentes.spec.ts`. A pilha foi parada no fim.

**Docs**: 022 (decisões da execução: rota do admin, rota de restaurar, fluxos sem MCP, limites, nota da versão, DTOs), 011 (montagem do prompt e cache) e `AGENTS.md`.
