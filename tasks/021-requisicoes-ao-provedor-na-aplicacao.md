---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-14
commit: (sem commit; a sessão principal commita)
---

# Registro de requisições, tentativas próprias e detalhe do provedor (F9)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [023](../docs/023-requisicoes-ao-provedor.md), seção "Aplicação (app)". O que fazer: Invólucro `request-log.ts` em todas as chamadas (fetch customizado do SDK, `maxRetries: 0`, até 3 tentativas com backoff/retry-after, sem repetir stream iniciado); segredos fora dos cabeçalhos; purga no worker (banco vence a variável); detalhe do provedor (uso, saúde, recentes, Editar), guia "Requisições" com filtros e a gaveta do detalhe; testes.

Ordem: Depois da 020. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [023](../docs/023-requisicoes-ao-provedor.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **Invólucro novo** `apps/server/src/agents/llm/request-log.ts`. Passam por ele:
  - `anthropic.ts` (l. 111–116: `maxRetries: 2`, timeout de 10 min) e `listModels` (l. 205);
  - `openai.ts` (l. 73–78, e `embedTexts` em l. 177–182, também com `maxRetries: 2`) e `listModels` (l. 164);
  - `services/ai-admin.ts`: `testProvider` (l. 137).
- **Contexto do invólucro**: ele precisa saber provedor, agente, usuário, conversa, execução, operação e finalidade, e ter o `db`. `createLlmClient` (`llm/index.ts`) e os chamadores (`runner.ts`, `agents/embeddings.ts`, `ai-admin.ts`) mudam.
- **`runner.ts`**:
  - o retry que já existe (l. ~226: `LlmError.retryable` devolve a execução à fila) fica para a queda no meio do stream;
  - o INSERT de `ai_usage` (l. ~170) passa a levar `request_id`;
  - o cancelamento interrompe a espera do backoff.
- **Manutenção**: `agents/worker.ts` (l. 58–62) ganha a purga.
- **Config**: `AI_REQUEST_RETENTION_DAYS` e `AI_REQUEST_MAX_ATTEMPTS`, em `.env.example`, no compose e nos docs.
- **Rotas novas**: `requests`, `requests/:id`, `body`, `providers/:id/summary` e `settings/:key`.
- **Web**:
  - `components/admin-ai/ProvidersTab.tsx`: o nome vira link;
  - página nova `/admin/ai/providers/:id`;
  - guia "Requisições" e a gaveta do detalhe;
  - `config/navigation.tsx`.
- **Backup** (`catalog.ts`):
  - `app_settings` com `COMPOSITE_KEYS ['key']`;
  - `ai_requests` e `ai_request_attempts` em `EXCLUDED_TABLES`;
  - `dump.ts`, se a exclusão dos dados for aceita (ponto 4 da 020).
- **Provedor falso** `e2e/fakes/fake-llm.ts`: precisa injetar 429, 5xx e a queda no meio do stream.

**Riscos e observações**
- O `fetch` customizado precisa duplicar o stream (`tee`) sem atrasar os deltas do SSE.
- Gravar o stream bruto de respostas longas.
- Trocar os cabeçalhos de credencial antes de gravar.
- Nunca segurar transação durante a chamada (AGENTS.md).
- Um `retry-after` de até 60 s convive bem com o heartbeat de 3 s.

**Dependências**
- Depende da 020. A 023 e a 025 usam o invólucro nas operações novas.

**Como verificar**
- Os testes da 023: 429 seguido de 200, três 5xx, queda no stream, `log_bodies` desligado e ligado, purga pelo banco e pela variável, 403 para quem não é admin.
- O e2e do detalhe do provedor.

**Pontos para a revisão da spec**
1. (023, Rotas) O botão "Usar o padrão (apaga o valor do banco)" não tem rota. Recomendação: `DELETE /api/admin/settings/:key`.
2. (023, Segredos) "Os campos marcados como segredo nas tools já chegam mascarados" depende da 027, que tem um problema de viabilidade (veja a 029). Até lá, um segredo digitado no texto vai no corpo gravado. Recomendação: citar esse limite no aviso de ligar `log_bodies`.

## Resolução (executor)
Feito pelo app em 2026-10-14, na branch `spec/f7-agentes-ia` (sem commit). `pnpm db:pull` regenerou o schema (0040).

**Invólucro (`apps/server/src/agents/llm/request-log.ts`)**
- `RequestRecorder`: entra como o `fetch` dos SDKs (Anthropic e OpenAI, `maxRetries: 0`; um cliente por chamada). Cada chamada HTTP vira uma linha em `ai_requests`: INSERT no início (fora da transação do negócio) e UPDATE no fim, com `finished_at = greatest(clock_timestamp(), started_at)`.
- Tentativas próprias, até `AI_REQUEST_MAX_ATTEMPTS` (padrão 3):
  - repete 408, 409, 429, 5xx/529, erro de rede e timeout (5 min até os cabeçalhos);
  - espera backoff de 1 s, 2 s, 4 s com jitter (base em `AI_REQUEST_BACKOFF_MS`) ou o `retry-after`/`retry-after-ms` (até 60 s);
  - cada tentativa é um INSERT em `ai_request_attempts`, com tipo do erro, mensagem, `retry_after_ms`, cabeçalhos de rate limit e, com `log_bodies`, o corpo do erro;
  - o signal da execução corta a espera.
- Streaming: depois de devolvida a resposta ao SDK, não repete. O corpo é repassado pedaço a pedaço, sem atrasar os deltas, medindo bytes e primeiro byte. Uma queda vira `stream_interrupted`, a requisição termina em erro e o adaptador lança `LlmError` retryable: a execução volta à fila.
- Corpos (completos, com o base64), cabeçalhos, resposta montada e stream bruto só são enviados ao banco com `log_bodies`. As credenciais viram `[omitido]` no app: a lista fixa e qualquer nome com key/token/secret/auth…, o que cobre os `anthropic-*` de credencial. Parâmetros de URL com esses nomes também.
- Uma falha ao gravar o registro não derruba a chamada (aviso no log).

**Quem passa pelo invólucro**
- `anthropic.ts`/`openai.ts`: chat (`operation`/`purpose` no `LlmRequest`) e `listModels(operation)`. `LlmResponse.requestId` sai daqui.
- `embedTexts(…, log)`.
- `runner.ts`:
  - chat dos agentes e dos fluxos, com a finalidade do fluxo, e o título (`title`/`title`);
  - `log_bodies` lido do provedor da execução;
  - os dois INSERTs de `ai_usage` levam `request_id`.
- `embeddings.ts`: `EmbeddingCredentials` ganhou `logBodies` e as tentativas da config; indexação e busca registram, e o uso leva `request_id`.
- `ai-admin.testProvider`: `test_connection`, com o usuário do admin.

**Worker e configuração**
- `agents/worker.ts`: `purgeAiRequests` no laço de manutenção chama `ai_requests_purge(dias, 1000)` em lotes. Os dias vêm de `app_settings` e, sem valor lá, de `AI_REQUEST_RETENTION_DAYS`.
- `config.ts`: `aiRequestMaxAttempts`, `aiRequestBackoffMs` e `aiRequestRetentionDays`.
- `.env.example` e `docker-compose.yml` (API e worker).

**Backup**
- `catalog.ts`: `ai_requests`/`ai_request_attempts` em `EXCLUDED_TABLES` e `app_settings` em `COMPOSITE_KEYS ['key']`.
- `import.ts` anula `ai_usage.request_id`.
- `dump.ts`: `--exclude-table-data` das duas tabelas e, depois do `pg_restore`, `SELECT ai_usage_unlink_missing_requests()`. Conferido à mão na pilha: dump e restore ok, 0 requisições e 0 vínculos órfãos depois.

**API e serviços**
- `services/ai-requests.ts`:
  - lista com filtros e cursor (`started_at`, `id` em µs), sem os corpos;
  - detalhe com as tentativas e os corpos até 8 MB por parte;
  - download `body?part=request|response|stream`;
  - resumo do provedor: uso por período (mês, 30 dias, total) com GROUPING SETS por finalidade e por modelo, `ai_provider_health(7, id)` e as 50 recentes;
  - `app_settings` com GET (valor em vigor, origem `database|env`, variável), PUT (upsert em `withTx`) e DELETE ("Usar o padrão"). Chave desconhecida dá 404.
- Rotas em `routes/agents.ts`, como na spec.
- `log_bodies` nas colunas, no DTO e nas entradas do provedor.
- pt-BR de `app_settings_value_check`/`app_settings_key_check` e os nomes das tabelas.

**Web**
- `ProvidersTab`: o nome vira link para o detalhe (o lápis continua). Há um selo "Registra corpos", e o formulário ganhou a flag, que pede confirmação com o aviso da spec (inclusive o limite do segredo digitado no texto, ponto 2 da triagem). `ProviderFormModal` foi exportado.
- `pages/AdminAiProviderPage.tsx` (`/admin/ai/providers/:id`): cabeçalho, Editar, resumo de uso por período, saúde (7 dias) e recentes.
- Guia "Requisições" (`RequestsTab`): filtros, "Carregar mais" e o painel de retenção (origem banco/variável, Salvar e "Usar o padrão").
- Gaveta `RequestDrawer`:
  - resumo e link que abre a conversa na janela do agente (somente leitura para conversa de outro usuário);
  - linha do tempo das tentativas;
  - Enviado e Resposta com abas Corpo, Stream bruto e Cabeçalhos;
  - Baixar e "Copiar como cURL" sem a chave (`buildCurl` em shared).
- `JsonViewer`: árvore recolhível. O base64 aparece recolhido com tipo e tamanho; imagem e áudio têm ver/ouvir, PDF abre noutra aba, e todos têm baixar (`detectBase64` em shared).
- `navigation.tsx` não precisou mudar: a trilha casa `/admin/ai/…` pelo prefixo.

**Provedor falso**: `e2e/fakes/fake-llm.ts` ganhou `headers` na resposta de erro e `dropAfter` (derruba a conexão no meio do stream).

**Testes**
- `apps/server/test/ai-requests.test.ts` (12):
  - 429→200, com 2 tentativas, 1 `ok`, tokens, uso ligado, `retry-after` e rate limit;
  - três 5xx: erro e a execução volta à fila, depois conclui;
  - 400 sem repetir;
  - queda no stream sem repetir, com a execução de volta à fila;
  - cancelar cortando um `retry-after` de 30 s;
  - sem/com `log_bodies`: base64 completo, `[omitido]`, a chave em lugar nenhum, rota body;
  - `test_connection` e embeddings registrados;
  - purga pelo banco e pela variável (o uso fica com o vínculo nulo) e auditoria da configuração;
  - validação 422/400/404;
  - lista com filtros e cursor, resumo e saúde;
  - 403 para quem não é admin em todas as rotas;
  - backup sem as requisições e com `app_settings`.
- `packages/shared/test/ai-requests.test.ts`: cURL e detecção do base64.
- e2e em `agentes.spec.ts`: 429→200 na conversa, link do nome para o detalhe, gaveta com as duas tentativas, Editar, retenção salva no banco e "Usar o padrão".

**Verificações**
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 128, server 140) e `pnpm build`: ok.
- Na pilha (`TELEGRAM_API_BASE=… docker compose up --build -d`), e2e `agentes.spec.ts` + `backup.spec.ts`: 10/10. A pilha foi parada no fim.
- Nenhum banco `moneyflow_bk_*` na 5432.

**Specs**
- 023: Banco, com a FK `NOT VALID`, `ai_usage_unlink_missing_requests()` e `ai_provider_health(dias, provedor)`. Também as tentativas (timeout de 5 min, `AI_REQUEST_BACKOFF_MS`, uma linha por chamada HTTP), as decisões da aplicação, as rotas de configuração, o limite de 8 MB do detalhe e os testes entregues.
- 011: F9 entregue, retry e `request_id`.
- 019: as requisições fora do JSON e do dump, `app_settings` dentro e o unlink depois do restore.
- `docs/INDEX.md` e `AGENTS.md`.

**Pendências**
- As capacidades no cabeçalho do detalhe chegam com a F10 (024).
- `vision_describe`/`transcription`/`speech` já são aceitas pelo invólucro, mas só serão usadas pelas 024/025.
- O corpo multipart da transcrição (025) é gravado como um resumo dos campos, sem o áudio; a 025 decide se grava o base64.
