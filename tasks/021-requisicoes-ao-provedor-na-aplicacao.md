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
