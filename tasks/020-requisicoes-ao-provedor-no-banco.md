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
Feito pelo dba em 2026-10-14 (sem commit ainda; a sessão principal commita).

**Migration `database/migrations/0040_ai_requests_and_app_settings.sql`**
- `app_settings` (`key` texto PK no formato `area.nome`, até 100; `value` jsonb; `updated_by_user_id` `SET NULL`; `created_at`, `updated_at`):
  - `app_setting_valid(key, value)` (IMMUTABLE) é o CHECK `app_settings_value_check`. Chave desconhecida é inválida; `ai.request_retention_days` aceita só número inteiro de 1 a 365 (`"30"`, `30.5`, `30.0`, `0`, `366` recusados). As fases 028/029 acrescentam chaves por `CREATE OR REPLACE`;
  - `updated_by_user_id` é preenchido pelo banco com o `app.user_id` da transação, quando definido (vence o informado);
  - auditada com `record_id = md5(key)::uuid` (a linha não tem `id`; histórico de uma chave = `WHERE table_name = 'app_settings' AND record_id = md5(chave)::uuid`).
- `ai_providers.log_bodies boolean NOT NULL DEFAULT false`, auditada pelo `audit_row` e com `GRANT SELECT` explícito (a `api_key` continua negada).
- `ai_requests` (metadados sempre; cabeçalhos e corpos só com `log_bodies`), com os pontos 1 e 2 da triagem como a spec revisada:
  - FKs provedor, agente, usuário, conversa e execução, todas `ON DELETE SET NULL`;
  - `operation` já aceita `vision_describe`, `transcription` e `speech`; `purpose` com o vocabulário atual de `ai_usage.purpose`, nula só e sempre em `test_connection`/`list_models` (`ai_requests_purpose_null_check`);
  - status `running` (padrão, INSERT no início) → `ok|error|canceled` com `finished_at` (`ai_requests_finished_check`); `duration_ms` gerada (`finished_at − started_at`); `error_message` até 4000 e nunca em `ok`;
  - informada a execução, o banco completa conversa, usuário, agente, provedor e modelo (`ai_requests_links_check` se a conversa for outra), e `chat` numa conversa de fluxo vira a finalidade dela, como no `ai_usage`;
  - **o banco descarta** cabeçalhos e corpos gravados com `log_bodies` desligado (ou sem provedor) e troca por `[omitido]` os cabeçalhos de credencial (`ai_request_headers_redact`: authorization, proxy-authorization, x-api-key, api-key, openai-organization, openai-project, cookie, set-cookie), como rede de segurança;
  - **imutabilidade** (`23514 ai_requests_immutable_check`): FK só muda para nulo; em andamento, id, operação, finalidade, modelo, método, caminho, streaming e início não mudam; terminada, nada muda além das FKs anuladas e do contador de tentativas;
  - índices (`provider_id`, `started_at` desc, `id` desc), (`started_at`, `id`) para a purga e a lista geral, `run_id`, e os das demais FKs; fora da auditoria.
- `ai_request_attempts`: PK (`request_id`, `attempt` 1–100), CASCADE; início, duração, HTTP, `error_type` (snake_case livre da aplicação), mensagem, `retry_after_ms`, `rate_limit_headers` (sempre) e `response_body` do erro (só com `log_bodies`). Inserir uma tentativa atualiza `ai_requests.attempts`.
- Privilégios: `moneyflow_app` tem `SELECT`/`INSERT`/`UPDATE` nas duas tabelas, **sem `DELETE`**; só a purga apaga.
- `ai_usage.request_id` com índice e trigger `ai_usage_request_check`: mesmo provedor e mesma execução, senão `23514 ai_usage_links_check`.
- **A FK `ai_usage.request_id` é `NOT VALID`** (decisão do dba, ponto 4 da triagem):
  - testei o `pg_dump --exclude-table-data` seguido do `pg_restore --clean --if-exists --single-transaction` do `dump.ts`: com a FK validada, o restore falha ao recriar a FK, porque o `ai_usage` traz `request_id` de requisições que não vieram;
  - `NOT VALID` só deixa de checar as linhas existentes no momento da criação; as linhas novas continuam checadas (o teste confere o `23503`);
  - `ai_usage_unlink_missing_requests()` (`SECURITY DEFINER`, idempotente, devolve quantas) anula os vínculos órfãos depois do restore;
  - no mesmo teste, o dump não levou nenhum corpo das requisições.
- `ai_requests_purge(p_days, p_limit = 1000)` (`SECURITY DEFINER`): apaga até o limite (máx. 100000) das iniciadas há mais de N dias, as mais velhas primeiro, com `SKIP LOCKED`, e devolve quantas. As tentativas saem em CASCADE e o uso fica com o vínculo nulo. Dias < 1 ou limite fora da faixa dão `22023`.
- `ai_provider_health(p_days = 7, p_provider_id = NULL)` (ponto 3 da triagem: função). Considera só as requisições terminadas, por provedor e modelo, nos últimos N dias (1–365, senão `22023`). Devolve:
  - `requests`, `ok`, `errors`, `canceled`;
  - `error_rate` = erros ÷ (ok + erros), sem as canceladas;
  - `p50_ms`/`p95_ms` e `p50_first_byte_ms`/`p95_first_byte_ms` das que deram certo;
  - `avg_attempts` e `last_error_at`.
  - O provedor opcional serve ao detalhe do provedor.
- Down: tira as funções, o trigger e a coluna do uso, as duas tabelas, `log_bodies` e `app_settings`.

**Testes**
- `database/tests/0040_ai_requests_and_app_settings.sql` (205 testes):
  - estrutura, tipos de exclusão das FKs (e a `NOT VALID`), índices, triggers e privilégios;
  - `app_setting_valid` aceita e recusa; configurações: chave, valor, unicidade, autor pela sessão, autor excluído, auditoria com `md5(key)` e regravação sem linha nova; `log_bodies` auditado sem a chave;
  - requisições:
    - sem `log_bodies`, nada de corpo; com ele, o corpo completo com base64;
    - credenciais omitidas sem distinção de maiúsculas; flag desligada no meio da chamada;
    - vínculos pela execução, finalidade do fluxo, domínio de operação e finalidade e cada CHECK;
    - ciclo e imutabilidade (em andamento e terminada);
  - tentativas: contador, corpo do erro com e sem a flag, rate limit, CHECKs, CASCADE;
  - provedor, conversa e usuário excluídos (SET NULL);
  - `ai_usage.request_id`: coerência e `23503` em linha nova; a órfã de um restore, simulada, é anulada;
  - purga: prazo, lotes, `22023`, `42501` no `DELETE` direto da aplicação, tentativas apagadas e uso com o vínculo nulo;
  - saúde com números conferidos (p50/p95, taxa sem as canceladas, média de tentativas, período, filtro por provedor e `22023`);
  - o fluxo inteiro como `moneyflow_app`.
- `database/tests/0015_audit_log.sql`: `ai_requests` e `ai_request_attempts` entraram na lista das tabelas fora da auditoria. O `0027_ai_usage.sql` não precisou mudar; o vínculo com a requisição é testado no 0040.
- `make test`: PASS (36 arquivos, 2413 testes). `make dump` rodado. O seed continua carregando. Apaguei os 15 bancos `moneyflow_bk_*` que tinham sobrado.

**Para a 021 (app)**
- Rodar `pnpm db:pull`: tabelas `app_settings`, `ai_requests` e `ai_request_attempts`, mais `ai_providers.log_bodies` e `ai_usage.request_id`. A `duration_ms` é coluna gerada: não grave.
- **Dump** (`dump.ts`):
  - no `pg_dump`, acrescentar `--exclude-table-data=public.ai_requests` e `--exclude-table-data=public.ai_request_attempts`;
  - depois de um `pg_restore` bem-sucedido, rodar `SELECT ai_usage_unlink_missing_requests()`.
- **Backup JSON** (`catalog.ts`):
  - `ai_requests` e `ai_request_attempts` em `EXCLUDED_TABLES`;
  - `app_settings` em `COMPOSITE_KEYS` (`['key']`, texto), no JSON completo;
  - `ai_usage.request_id` é referência fraca para uma tabela excluída: anule na importação, como `run_id`, senão `23503`;
  - na importação, `updated_by_user_id` vira o admin que importa (o banco usa o `app.user_id`).
- **`request-log.ts`**:
  - INSERT no início, com `status` e `started_at` padrão. `operation`, `purpose`, `model`, `method`, `path` e `streaming` ficam fixos depois do INSERT. `purpose` é obrigatória, menos em `test_connection`/`list_models`, e vem do vocabulário atual. Para `vision_describe`/`transcription`/`speech`, as finalidades novas chegam na 022.
  - Cada tentativa é um INSERT em `ai_request_attempts` (`attempt` = 1, 2, 3…). Não grave `ai_requests.attempts`.
  - No fim, um UPDATE com `status`, `finished_at` (use `clock_timestamp()` no SQL, ou envie os dois instantes do mesmo relógio; o `finished_at` não pode ficar antes do `started_at`), HTTP, erro, `first_byte_ms`, tokens, bytes e, com `log_bodies`, cabeçalhos e corpos.
  - Terminada, a linha não muda mais (`23514 ai_requests_immutable_check`).
  - Só envie corpos e cabeçalhos quando o provedor tiver `log_bodies`. O banco descarta o resto, mas os 20 MB trafegariam à toa.
  - Omita as credenciais na aplicação, inclusive os `anthropic-*` de credencial. O banco só repete a lista fixa.
  - Teste de conexão de provedor ainda não salvo: `provider_id` nulo (sem corpos).
- **Uso**: grave `ai_usage.request_id`, com o mesmo provedor e a mesma execução da requisição.
- **Purga** no laço de manutenção: `SELECT ai_requests_purge($dias, 1000)` em lotes, até devolver menos que o limite.
  - `$dias` = `app_settings.value` de `ai.request_retention_days` ou, sem ele, `AI_REQUEST_RETENTION_DAYS`.
  - A aplicação não tem `DELETE` nessas tabelas (`42501`); limpeza de teste, só pela purga ou pelo dono.
- **Saúde**: `SELECT * FROM ai_provider_health(7, $provedor)`.
- **Settings**:
  - `PUT` = `INSERT … ON CONFLICT (key) DO UPDATE`, e `DELETE` = "Usar o padrão";
  - pode pré-validar com `app_setting_valid`;
  - traduzir `23514 app_settings_value_check` e `app_settings_key_check`.
- **Provedores**: incluir `log_bodies` nas listas de colunas e no formulário (com o aviso da spec).
- **Erros que não deveriam chegar ao usuário**: `ai_requests_*_check`, `ai_requests_immutable_check`, `ai_requests_links_check` e `ai_usage_links_check`.

**Para a spec 023 (fora da pasta do dba)**
- Registrar na seção Banco:
  - que a FK `ai_usage.request_id` é `NOT VALID`;
  - o `ai_usage_unlink_missing_requests()` depois do restore;
  - a assinatura `ai_provider_health(dias, provedor opcional)`.
