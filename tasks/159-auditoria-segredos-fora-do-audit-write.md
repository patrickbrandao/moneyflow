---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Auditoria: a remoção dos segredos e das colunas ruidosas vive só no `audit_row()`, e 11 triggers próprios a contornam

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** auditoria (segredos e volume do `audit_log`)
- **Arquivos afetados:** `database/schema.sql:4313-4340` (`audit_row`), `database/schema.sql:4391-4431` (`audit_write`), `database/schema.sql:319`, `:445`, `:1966`, `:3439`, `:4194`, `:4255`, `:4354`, `:5587`, `:6108`, `:7788`, `:10055` (triggers próprios), `database/schema.sql:14166-14193` (`mcp_servers`), `database/schema.sql:20279`, `database/AGENTS.md:72`
- **Depende de / relacionado a:** tarefa 069 (listas de leitores de segredo)
- **Executor sugerido:** dba
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O histórico de alterações nunca pode guardar senhas e chaves. Hoje essa proteção está escrita numa só das doze funções que gravam o histórico. As outras onze não a repetem. Não há vazamento hoje, mas basta um segredo novo numa dessas tabelas para ele ir parar no histórico sem ninguém perceber.

### Evidência e análise técnica
- A lista `secrets` (`password`, `bot_token`, `api_key`, `secret_headers`, `token_hash`, `webhook_secret_hash`, `code_hash`) e o corte `o - secrets, n - secrets` existem só em `audit_row()` (`schema.sql:4319-4337`).
- `audit_write` (`schema.sql:4391-4431`), por onde todos passam, grava `p_old` e `p_new` como chegam.
- Onze funções montam o JSON com `to_jsonb(OLD/NEW)` e chamam `audit_write` direto, sem a lista: `ai_agent_inferences_audit_row` (319), `ai_agent_prompt_versions_audit_row` (445), `ai_reconcile_recipe_targets_audit_row` (1966), `ai_tool_kit_tools_audit_row` (3439), `app_settings_audit_row` (4194), `attachments_audit_row` (4255), `audit_row_keyed` (4354, usada em três tabelas), `contract_document_versions_audit_row` (5587), `entity_tag_links_audit_row` (6108), `note_reminders_audit_row` (7788) e `user_ai_settings_audit_row` (10055).
- A regra do dba (`database/AGENTS.md:72`) diz "segredo novo entra na lista `secrets` de `audit_row()`". Ela só protege as tabelas auditadas por `audit_row()`. Um segredo em `app_settings.value` (chave nova de integração) ou num `user_ai_settings` futuro iria inteiro para o log, e `moneyflow_app` tem SELECT no `audit_log`.
- Ponto ligado, de volume: as colunas "ruidosas" (`TG_ARGV[0]`) só deixam de *gerar* linha; quando outra coluna muda, elas entram inteiras no antes e no depois. Em `mcp_servers` (trigger em `schema.sql:20279`), `tools_cache` (jsonb sem limite, o `tools/list` inteiro) e `instructions_cache` (até 50 mil caracteres) são gravados duas vezes a cada troca de nome, modo, visibilidade ou cabeçalho.

### Verificação (tentativa de refutação)
- Nenhuma das tabelas dos onze triggers tem hoje coluna de segredo: não há vazamento atual, por isso a severidade é baixa.
- `tests/0015_audit_log.sql:44,71-74`, `0025_mcp_servers.sql:115` e `0028_user_api_tokens.sql:70` conferem a remoção tabela a tabela, todas de `audit_row()`. Não há teste que percorra os triggers de auditoria e as colunas de segredo para garantir a combinação.
- A tarefa 069 tratou das listas de leitores na documentação, não deste ponto.

### Impacto
Risco latente de segredo no `audit_log` na próxima tabela ou chave de configuração com segredo; e linhas de auditoria grandes sem necessidade em `mcp_servers`.

## Como reproduzir
1. Num banco de teste, crie uma tabela com a coluna `api_key` auditada por `audit_row_keyed('id')`.
2. Faça um INSERT: `new_data` do `audit_log` traz o `api_key`.
3. Para o volume: com um `mcp_servers.tools_cache` de 200 KB, `UPDATE mcp_servers SET name = 'x'` grava cerca de 400 KB em `audit_log`.

## Solução proposta
1. Migration nova: `audit_write` aplica o corte, `p_old - secrets` e `p_new - secrets`, com a lista numa função `IMMUTABLE` (`audit_secret_columns()`); `audit_row()` passa a usá-la. A proteção fica num ponto só.
2. `audit_row()` também tira do corpo as colunas ruidosas que são cache (`tools_cache`, `instructions_cache`), deixando-as só em `changed_columns`. A alternativa é um segundo argumento do trigger, "colunas fora do corpo".
3. Atualizar `database/AGENTS.md:72` e a `docs/016` (Auditoria).

## Critérios de aceite
- [ ] Qualquer trigger de auditoria que passe por `audit_write` sai sem as colunas da lista de segredos.
- [ ] `UPDATE` de `mcp_servers` que não toca o cache não grava `tools_cache` no log.
- [ ] Um teste falha se uma tabela auditada tiver coluna de segredo fora da lista.

## Testes recomendados
- `database/tests/0015_audit_log.sql`: `audit_write` chamada direto com `{"api_key": "x"}` grava sem a chave; um laço por `pg_trigger` das funções de auditoria × colunas com nome da lista confere que nenhuma sai no `audit_log`.
- `database/tests/0025_mcp_servers.sql`: renomear um servidor com cache não grava `tools_cache` em `old_data`/`new_data`.

## Limitações e suposições
Nada foi executado. A decisão de manter a linha inteira no antes e depois (spec 008) não é questionada; só o cache entra na proposta.

## Análise (triagem)

## Resolução (executor)
