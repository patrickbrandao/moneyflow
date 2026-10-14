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

# Requisições, tentativas e app_settings no banco (F9)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [023](../docs/023-requisicoes-ao-provedor.md), seção "Banco (dba)". O que fazer: `app_settings` (+ `app_setting_valid`, chave `ai.request_retention_days`), `ai_requests`, `ai_request_attempts`, `ai_providers.log_bodies`, `ai_usage.request_id`, `ai_requests_purge`, visão `ai_provider_health`; backup (requisições fora, settings dentro).

Ordem: Depois da F8; depois vem a 021. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [023](../docs/023-requisicoes-ao-provedor.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: dba.** Tipo confirmado: banco.

**Arquivos afetados**
- Migration nova, pgTAP novo, e também `database/tests/0027_ai_usage.sql`. Mais `schema.sql`.
- Objetos:
  - `app_settings` e `app_setting_valid`;
  - `ai_requests` e `ai_request_attempts`;
  - `ai_providers.log_bodies` e `ai_usage.request_id`;
  - `ai_requests_purge` e `ai_provider_health`.

**Riscos e observações**
- **Segredo em `ai_providers`** (`api_key`): `log_bodies` precisa de `GRANT SELECT` explícito (database/AGENTS.md).
- **`ai_usage.request_id`**: FK nula, `ON DELETE SET NULL`, com índice. O `ai_usage` de hoje está em `schema.sql` l. 5594.
- **FKs de `ai_requests`** (provedor, agente, usuário, conversa, execução): a spec não define o `ON DELETE`.
  - Excluir a conversa apaga as execuções (CASCADE em `ai_runs.conversation_id`).
  - Provedor e agente podem ser excluídos (`deleteProvider`/`deleteAgent`). Com RESTRICT, um provedor que já foi chamado não poderia mais ser excluído.
  - Recomendação: `SET NULL` em todas, como o `ai_usage` faz com conversa, mensagem e execução.
- **Domínios**:
  - `operation` já deve aceitar `vision_describe`, `transcription` e `speech` (F10/F11), para não precisar de outra migration;
  - `purpose` é nula em `test_connection`/`list_models`, porque `ai_usage.purpose` (CHECK em l. 5616) não tem finalidade para essas operações.
- **`app_settings`**: sem `id` (a chave primária é `key`). O backup vai precisar de `COMPOSITE_KEYS` na aplicação (021). `app_setting_valid(key, value)` entra como CHECK e é auditada.
- **"Últimos N dias"**: uma view não recebe parâmetro. Recomendação: a função `ai_provider_health(p_days)` ou uma view fixa em 7 dias.
- **Purga**: em lotes, com índice em `started_at` e as tentativas em CASCADE.
- **Volume**: com `log_bodies`, os corpos completos com base64 (anexos de até 20 MB) ficam em `text`. O `pg_dump` do backup (`apps/server/src/services/backup/dump.ts`, l. 133) não exclui tabela nenhuma, então o dump leva esses corpos, com conversas e dados financeiros.

**Dependências**
- Depois da F8. A 021 vem depois.
- `app_settings` é base para a 030 e a 032.

**Como verificar**
- `make -C database test`.
- pgTAP:
  - `app_setting_valid` aceita e recusa;
  - a purga apaga por prazo, devolve a contagem e deixa o vínculo de `ai_usage` nulo;
  - as tentativas são apagadas em CASCADE;
  - `moneyflow_app` lê `log_bodies`, mas não `api_key`.

**Pontos para a revisão da spec**
1. (023, Banco) Falta o `ON DELETE` das FKs de `ai_requests`. Recomendação: `SET NULL`.
2. (023, O que é registrado) Não há finalidade para `test_connection`/`list_models`. Recomendação: `purpose` nula nessas operações.
3. (023, Banco) Uma view não recebe o "últimos N dias". Recomendação: uma função com parâmetro.
4. (023, Backup) O dump do PostgreSQL inclui os corpos de `ai_requests`. Recomendação: `--exclude-table-data=ai_requests` e `ai_request_attempts` no `pg_dump`, mudança da aplicação em `dump.ts`, coerente com "requisições fora do backup".

## Resolução (executor)
