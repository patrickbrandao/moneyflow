---
status: aberta
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: media
criada: 2026-10-14
commit:
---

# Instruções do usuário, versões do prompt e instructions do MCP no banco (F8)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [022](../docs/022-prompts-e-instrucoes.md), seção "Banco (dba)". O que fazer: `user_ai_settings`, `ai_agent_prompt_versions` (versão atribuída pelo banco, imutável, versão 1 migrada do prompt atual, prompt do agente = última versão), `mcp_servers.instructions_mode`/`instructions_cache`; auditoria e backup.

Ordem: Depois da F7 (017); depois vem a 019. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [022](../docs/022-prompts-e-instrucoes.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: dba.** Tipo confirmado: banco.

**Arquivos afetados**
- Migration nova, pgTAP novo e `schema.sql`.
- Também o teste `database/tests/0025_mcp_servers.sql` (colunas novas).
- Objetos:
  - `user_ai_settings`;
  - `ai_agent_prompt_versions`;
  - `mcp_servers.instructions_mode` e `instructions_cache` (e talvez `instructions_cached_at`).

**Riscos e observações**
- **`mcp_servers` guarda segredo** (`secret_headers`). As colunas novas precisam de `GRANT SELECT` explícito (database/AGENTS.md, Segurança).
  - A auditoria é `audit_row('tools_cache,tools_cached_at,tools_error')` (`schema.sql` l. 12294). `instructions_cache` entra nessa lista para não gerar auditoria, como a spec pede.
  - A view `effective_agent_mcp_servers` (l. ~8091), que o runner lê, precisa expor `instructions_mode` e `instructions_cache`.
- **Versões do prompt.** O precedente é `contract_document_versions` (l. 7697): `id uuid`, `version` e `restored_from_version_id uuid`.
  - A spec usa `restored_from_version` (número) e não diz se há `id`.
  - Tabela sem `id` exige `COMPOSITE_KEYS` no backup. Recomendação: seguir o precedente.
- **Sincronia `system_prompt` = última versão.** Fica a escolha do dba, mas com atenção ao backup:
  - o `import.ts` importa por registro, em savepoints;
  - uma checagem no COMMIT exigiria pôr `ai_agents` e as versões no `DEFERRED_CLUSTER` (`catalog.ts`);
  - um trigger que cria a versão 1 no INSERT do agente faria a versão 1 do arquivo colidir com a criada.
  - Recomendação: a aplicação insere a versão (com nota e autor), e um trigger AFTER INSERT na versão grava `ai_agents.system_prompt`. Um UPDATE direto que deixe `system_prompt` diferente da última versão é recusado, mas o agente ainda sem versões (import) é aceito.
- **`user_ai_settings`**: chave `user_id`, `ON DELETE CASCADE` e auditada.
- **Migração**: a versão 1 de cada agente existente recebe o `system_prompt` atual.

**Dependências**
- Depois da 017. A 019 vem depois.
- Pode precisar de uma coluna a mais em `user_ai_settings`: veja o ponto 3 e a 019.

**Como verificar**
- `make -C database test`.
- pgTAP:
  - a versão é sequencial por agente, inclusive com gravações concorrentes;
  - as versões são imutáveis;
  - `system_prompt` acompanha a última versão;
  - o modo de instruções inválido é recusado;
  - `moneyflow_app` lê as colunas novas de `mcp_servers`, mas não `secret_headers`.

**Pontos para a revisão da spec**
1. (022, Banco) `restored_from_version` e a chave sem `id` divergem do precedente `contract_document_versions`. Recomendação: `id` + `restored_from_version_id`, com único em (`agent_id`, `version`).
2. (022, Banco) O trigger ou a checagem no COMMIT conflita com a importação do backup, como descrito acima. Recomendação: a versão manda no `system_prompt`, pelo trigger na versão.
3. (022, Variáveis/Contexto) Não existem o "nome" nem a "caixa principal" do usuário (detalhes na 019). Se a resposta for uma caixa principal escolhida pelo usuário, ela entra aqui como `user_ai_settings.primary_caixa_id`.

## Resolução (executor)
