---
status: concluida
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
Feito pelo dba em 2026-10-14 (sem commit ainda; a sessão principal commita).

**Migration `database/migrations/0039_ai_prompts_and_instructions.sql`**
- `user_ai_settings` (`user_id` PK e FK CASCADE, `instructions`, `primary_caixa_id`, `created_at`, `updated_at`):
  - `instructions` é `NOT NULL DEFAULT ''` (vazio = nenhuma), até 20 mil (`user_ai_settings_instructions_check`);
  - `primary_caixa_id` com FK `ON DELETE SET NULL` e índice; só caixa `general` (trigger `user_ai_settings_validate`, `23514 user_ai_settings_primary_caixa_check`); a leitura pelo usuário fica com a aplicação;
  - auditada por `user_ai_settings_audit_row()` com `record_id = user_id` (a linha não tem `id`).
- `ai_agent_prompt_versions`, seguindo o precedente `contract_document_versions` (pontos 1 e 2 da triagem, como a spec revisada):
  - colunas `id`, `agent_id` (CASCADE), `version`, `content` (até 200 mil, o limite do `system_prompt`), `note` (até 500), `created_by_user_id` (`SET NULL`), `restored_from_version_id` (FK composta para uma versão do mesmo agente; não aponta para si), `created_at`, `updated_at`; único (`agent_id`, `version`);
  - `version` atribuída pelo banco: omitida = a próxima, travando o agente (`FOR NO KEY UPDATE`); informada tem de ser a próxima (`23514 ai_agent_prompt_versions_version_check`);
  - imutáveis (só o autor vira nulo) e excluídas só com o agente (`23514 ai_agent_prompt_versions_immutable_check`);
  - auditoria sem o `content` (com `content_chars`); o texto fica no antes/depois do `system_prompt` na linha do `ai_agents`.
- **A versão manda**: `AFTER INSERT` na versão copia o `content` para `ai_agents.system_prompt` (vale na importação). `UPDATE` direto que deixe o `system_prompt` diferente da última versão dá `23514 ai_agents_system_prompt_version_check`; regravar o mesmo valor passa.
- **Agente novo nasce com a versão 1** (decisão do dba): constraint trigger adiado `ai_agents_prompt_version_init`. No COMMIT (ou num `SET CONSTRAINTS … IMMEDIATE`), se o agente inserido ainda não tem versão, o banco cria a 1 com o `system_prompt` atual, sem nota e com autor = `created_by_user_id`. Se a aplicação inserir a versão 1 na mesma transação (com nota), o trigger não faz nada.
  - Por que adiado: um trigger imediato no INSERT do agente faria a versão 1 do arquivo de backup colidir. Uma checagem que só recusa no COMMIT quebraria os arquivos antigos, sem versões.
  - Assim, o arquivo com versões as preserva (ids, números, notas, autores), e o arquivo antigo ganha a versão 1.
  - Condição: o agente e as versões precisam entrar na mesma unidade da importação (ver abaixo).
- Migração: a versão 1 de cada agente existente recebe o `system_prompt` atual (conferido no banco de desenvolvimento: o "Assistente geral" ganhou a versão 1 com o prompt dele; up → down → up limpo). O seed continua idempotente e, num banco novo, o agente do seed nasce com a versão 1.
- `mcp_servers`:
  - `instructions_mode` `ignore|system|user`, `NOT NULL DEFAULT 'ignore'` (`mcp_servers_instructions_mode_check`);
  - `instructions_cache` texto, até 50 mil (`mcp_servers_instructions_cache_check`). Sem `instructions_cached_at`: o cache é atualizado junto com o `tools_cache`, e o `tools_cached_at` já marca quando;
  - `GRANT SELECT` explícito nas duas colunas; o `secret_headers` continua negado;
  - o `mcp_servers_audit` passou a ignorar também o `instructions_cache` (`audit_row('tools_cache,tools_cached_at,tools_error,instructions_cache')`); a troca do modo é auditada;
  - `effective_agent_mcp_servers` ganhou `instructions_mode` e `instructions_cache` no fim.
- Down: volta a visão e a auditoria do MCP, tira as duas colunas, os triggers do agente, as duas tabelas e as funções.

**Testes**
- `database/tests/0039_ai_prompts_and_instructions.sql` (131 testes):
  - estrutura, FKs e tipo de exclusão, índices, triggers, constraint trigger adiado e privilégios;
  - instruções e caixa principal: limite, cartão recusado no INSERT e no UPDATE, caixa inexistente, caixa excluída vira nula, auditoria com `record_id = user_id` e ator;
  - **concorrência real por `dblink`**: duas sessões gravam versões do mesmo agente; a segunda espera a trava, e as versões saem 1, 2, 3, com o `system_prompt` = a última;
  - versão 1 no COMMIT (com o prompt final; a da aplicação, com nota, fica; agente excluído na transação não gera nada);
  - número atribuído, repetido ou com buraco recusado, restauração, restauração de outro agente ou de si mesma, limites;
  - `UPDATE` direto do prompt recusado e regravação do mesmo valor;
  - imutabilidade (conteúdo, nota, número, autor, DELETE);
  - importação simulada (agente com as versões do arquivo + `SET CONSTRAINTS ALL IMMEDIATE`: ids e números preservados, `system_prompt` = a última) e arquivo sem versões;
  - autor excluído, auditoria sem `content`, CASCADE com o agente;
  - MCP: modo padrão, inválido e nulo, limite do cache, cache sem auditoria, modo auditado, visão efetiva;
  - papel da aplicação (upsert das instruções, criar versão, 23514 no UPDATE direto e no DELETE, colunas novas legíveis, `secret_headers` negado).
- O `0025_mcp_servers.sql` não precisou mudar: ele já confere que o app lê toda coluna de `mcp_servers` menos `secret_headers`, e as novas passam.
- `make test`: PASS (35 arquivos, 2208 testes). `make dump` rodado.

**Para a 019 (app)**
- Rodar `pnpm db:pull` (tabelas `user_ai_settings` e `ai_agent_prompt_versions`, colunas novas de `mcp_servers` e da visão).
- **Prompt do agente** (`ai-admin.ts`):
  - mudar o prompt = `INSERT INTO ai_agent_prompt_versions (agent_id, content, note, created_by_user_id)` sem `version` (o banco atribui e copia para o agente). Tirar `system_prompt = …` do UPDATE do agente: hoje ele dá `23514 ai_agents_system_prompt_version_check` quando o valor muda;
  - na criação, pode seguir inserindo `ai_agents.system_prompt` (o banco cria a versão 1 no COMMIT) ou inserir a versão 1 na mesma transação, se quiser nota;
  - restaurar = nova versão com o `content` antigo, `restored_from_version_id` e a nota "Restaurada da versão N".
- **Erros a traduzir** (`errors.ts`):
  - `23514 ai_agents_system_prompt_version_check` (não deveria chegar ao usuário);
  - `23514 ai_agent_prompt_versions_version_check` (gravação concorrente com número informado);
  - `23514 ai_agent_prompt_versions_immutable_check`;
  - `23503 ai_agent_prompt_versions_restored_from_version_id_fkey` (versão de outro agente);
  - `23514 ai_agent_prompt_versions_note_check` / `_content_check`;
  - `23514 user_ai_settings_primary_caixa_check` (a caixa principal tem de ser general);
  - `23514 user_ai_settings_instructions_check`;
  - `23514 mcp_servers_instructions_mode_check` e `mcp_servers_instructions_cache_check` (truncar o cache em 50 mil antes de gravar).
- **Minha conta → IA**: `user_ai_settings` por upsert (`ON CONFLICT (user_id) DO UPDATE`); sem linha = sem instruções nem caixa principal. A permissão de leitura da caixa escolhida é do `Access`.
- **MCP**: gravar `instructions_cache` junto com o `tools_cache`/`tools_cached_at`; o runner lê `instructions_mode`/`instructions_cache` de `effective_agent_mcp_servers`, que traz o cache também no modo `ignore` (o filtro é da aplicação).
- **Catálogo do backup** (`catalog.ts`):
  - `ai_agents` e `ai_agent_prompt_versions` em `DEFERRED_CLUSTER`. É obrigatório: fora do cluster, o `SET CONSTRAINTS ALL IMMEDIATE` de outra unidade dispararia a versão 1 do banco antes das versões do arquivo, e a versão 1 do arquivo seria recusada;
  - `OWNED_BY.ai_agent_prompt_versions = ['agent_id']` (agente já cadastrado fica com o histórico dele);
  - `user_ai_settings` em `COMPOSITE_KEYS` (`['user_id']`), em `OWNED_BY` (`['user_id']`) e no recurso `users`. A `primary_caixa_id` é `SET NULL`, então caixa ausente é anulada;
  - as versões entram em ordem de `id` (uuidv7) e com o `version` do arquivo, que o banco confere.
  - Arquivo antigo, sem versões: nada a fazer, o banco cria a versão 1.
