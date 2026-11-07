---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: dba
prioridade: baixa
criada: 2026-11-07
commit:
---

# As listas de leitores e de segredos blindados na documentação e no schema estão incompletas

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência
- **Subcategoria:** documentação da fronteira de segredos
- **Arquivos afetados:** `database/migrations/0041_ai_provider_capabilities.sql:749-753`, `database/migrations/0042_ai_chat_multimedia.sql:163-197`, `database/migrations/0045_ai_autonomous_flows.sql:574-575`, `docs/016-banco-de-dados.md:33-35`, `database/AGENTS.md:70`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
A lista de quem pode ler a chave do provedor de IA e a regra para quem mexe no banco estão incompletas. Um próximo agente pode esquecer um leitor ou um segredo numa revisão de segurança.

### Evidência e análise técnica
- O comentário vigente de `ai_providers.api_key` (`0041:749-753`, não recriado depois) lista `ai_run_provider_credentials`, `ai_capability_credentials`, `ai_embedding_credentials` e `admin_ai_provider_api_key`. Falta `ai_transcription_credentials` (`0042:163`), que também devolve `p.api_key` (`0042:196`).
- `docs/016:35` também não a cita; ela aparece só na `docs/016:134` e na `docs/025:67`.
- `database/AGENTS.md:70` lista `bot_token`, `api_key`, `secret_headers` e `token_hash`, sem `webhook_secret_hash` e `telegram_pairing_codes.code_hash`. Os dois estão blindados e na lista `secrets` do `audit_row` (`0045:574-575`).
- A frase "Cada segredo tem um leitor `admin_*`" está errada para o `code_hash`, que de propósito não tem leitor de admin (`docs/016:33`).

### Verificação (tentativa de refutação)
O código e a auditoria estão corretos. A falha é só de documentação e comentário.

### Impacto
Sem efeito em execução. Risco de manutenção futura da fronteira de segredos.

## Como reproduzir
Comparar o `col_description` de `ai_providers.api_key` com as funções que devolvem `api_key` (`rg "p.api_key" database/migrations`).

## Solução proposta
- Uma migration nova com o `COMMENT ON COLUMN ai_providers.api_key` atualizado (as antigas não se editam), acrescentando `ai_transcription_credentials` (dba).
- Ajustar `database/AGENTS.md:70` (dba) e `docs/016:35` (app, ou o dba na mesma mudança).

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/database/AGENTS.md
+++ b/database/AGENTS.md
@@
-- Mesma blindagem (INSERT/UPDATE sim, SELECT não, leitura só por função `SECURITY DEFINER`, fora do `audit_log` pela lista `secrets` de `audit_row()`) para `message_destinations.bot_token`, `ai_providers.api_key`, `mcp_servers.secret_headers` e `user_api_tokens.token_hash`. [...] Cada segredo tem um leitor `admin_*(id, ator)` (admin ativo, senão `42501`) para o export de backup; segredo novo também ganha o seu.
+- Mesma blindagem (INSERT/UPDATE sim, SELECT não, leitura só por função `SECURITY DEFINER`, fora do `audit_log` pela lista `secrets` de `audit_row()`) para `message_destinations.bot_token`, `message_destinations.webhook_secret_hash`, `telegram_pairing_codes.code_hash`, `ai_providers.api_key`, `mcp_servers.secret_headers` e `user_api_tokens.token_hash`. [...] Cada segredo que vai ao backup tem um leitor `admin_*(id, ator)` (admin ativo, senão `42501`); o `code_hash` não vai ao backup e não tem leitor.
--- a/docs/016-banco-de-dados.md
+++ b/docs/016-banco-de-dados.md
@@
-... `ai_capability_credentials(agente, capacidade, ator)` e `ai_embedding_credentials(provedor)` (abaixo, em *Capacidades*), ...
+... `ai_capability_credentials(agente, capacidade, ator)`, `ai_embedding_credentials(provedor)` e `ai_transcription_credentials(id, lock_token)` (abaixo, em *Capacidades*), ...
```
O `[...]` marca o trecho intermediário da linha, que fica igual; copie-o do arquivo real.

## Critérios de aceite
- [ ] O comentário da coluna `ai_providers.api_key` cita os cinco leitores.
- [ ] `docs/016:35` e `database/AGENTS.md:70` batem com a lista `secrets` de `0045:574-575`.

## Testes recomendados
Opcional: um pgTAP que confere a lista `secrets` vigente do `audit_row`. Nada foi executado nesta auditoria.

## Limitações e suposições
Nenhuma relevante.

## Análise (triagem)

Confirmado (dba, 2026-11-07): `ai_transcription_credentials` (0042) devolve `p.api_key` e não estava no comentário da coluna nem na `docs/016:35`; `database/AGENTS.md` não citava `webhook_secret_hash` nem `code_hash`, e dizia que todo segredo tem leitor de admin. Só documentação; executor: dba (a linha da 016 vai na mesma mudança).

## Resolução (executor)

- `database/migrations/0054_ai_provider_api_key_readers.sql`: `COMMENT ON COLUMN ai_providers.api_key` com os cinco leitores (inclui `ai_transcription_credentials`); o down devolve o comentário da 0041.
- `database/tests/0054_ai_provider_api_key_readers.sql` (pgTAP): o comentário cita os cinco leitores, nenhuma função que lê `p.api_key` fica fora dele, e a lista `secrets` do `audit_row()` vigente traz os sete segredos (inclusive `webhook_secret_hash` e `code_hash`).
- `database/AGENTS.md` (Segurança): a blindagem lista `message_destinations.webhook_secret_hash` e `telegram_pairing_codes.code_hash`; "cada segredo que vai ao backup tem um leitor `admin_*`", e o `code_hash` não tem leitor.
- `docs/016-banco-de-dados.md` (Segurança, segredos da IA): `ai_transcription_credentials(id, lock_token)` na lista.
- `make test T="/tests/0001_base.sql /tests/0054_… /tests/0055_…"` (rápido) passou; `make dump` rodado. Nada a ajustar na aplicação (só comentário; o `pnpm db:pull` pode ser rodado junto com a 0055 da tarefa 054).
