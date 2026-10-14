---
status: aberta
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
