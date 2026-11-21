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

# Requisição ao provedor interrompida por queda do processo fica "em andamento" até a purga

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** ciclo de `ai_requests` (spec 023)
- **Arquivos afetados:** `apps/server/src/agents/llm/request-log.ts:6-22,545-558`, `database/schema.sql:2214-2292` (`ai_requests_before_write`), `database/schema.sql:2306-2330` (`ai_requests_purge`), `database/schema.sql:1651-1690` (`ai_provider_health`), `apps/server/src/agents/worker.ts:188-194`, `docs/023-requisicoes-ao-provedor.md`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Cada chamada à IA vira uma linha na tela Requisições, que começa "em andamento" e é fechada quando a resposta chega. Se o worker for reiniciado no meio da resposta (um deploy, por exemplo), essa linha nunca é fechada e fica "em andamento" por 30 dias, até ser apagada. O admin vê chamadas fantasmas e não sabe que elas caíram.

### Evidência e análise técnica
- A requisição nasce `running` no INSERT e só é fechada pelo `UPDATE … WHERE id = … AND status = 'running'` do fim da chamada (`request-log.ts:545-558`). Se esse UPDATE falhar, a falha vira só um aviso no log (`request-log.ts:21,556-557`).
- Com o processo morto (SIGKILL no `docker stop` depois do prazo, OOM, queda), ninguém fecha a linha. O worker espera as execuções em andamento ao parar (`agents/worker.ts:188-194`), mas um streaming longo passa do prazo padrão de 10 s do `docker stop`.
- `ai_run_claim` retoma a execução com reserva velha e cria requisições novas. A antiga continua `running`.
- O banco não tem reaper: `ai_requests_purge` (`schema.sql:2306-2330`) apaga pela idade, sem olhar o status; `ai_provider_health` ignora as `running` (`schema.sql:1675`). Nenhuma função ou laço passa `running` velha a `error`/`canceled`.

### Verificação (tentativa de refutação)
- O trigger permite o fechamento depois (`running` → final, com `finished_at`; `ai_requests_before_write`, `schema.sql:2263-2289`), então a correção não exige mudar a imutabilidade.
- A saúde do provedor não é distorcida (as `running` ficam de fora), mas também não registra a falha.
- Não há teste de integração para requisição órfã em `apps/server/test/ai-requests.test.ts` (o arquivo nem menciona o status `running`); o pgTAP da 0040 cobre só o ciclo normal e a imutabilidade.

### Impacto
A tela Requisições e o detalhe do provedor mostram, por até `AI_REQUEST_RETENTION_DAYS`, chamadas "em andamento" que já morreram, uma por chamada interrompida em cada deploy ou queda. A taxa de erro do provedor não conta essas falhas.

## Como reproduzir
1. Com o provedor falso (`e2e/fakes/fake-llm.ts`) respondendo devagar, inicie uma conversa.
2. Mate o worker no meio do streaming (`docker kill moneyflow-worker-1`) e suba de novo.
3. Em /admin/ai → Requisições, a primeira chamada continua "em andamento"; a execução foi retomada com outra requisição.

## Solução proposta
1. dba: `ai_requests_close_stale(p_after interval DEFAULT '30 minutes')` passa a `error` (mensagem `interrupted: worker stopped`, `finished_at` = agora) as `running` iniciadas há mais que o prazo, em lote com `FOR UPDATE SKIP LOCKED`, e devolve quantas. O prazo fica acima do maior timeout de chamada (o `AI_DOCUMENT_TIMEOUT_MS` e o do streaming).
2. app: chamar no laço de manutenção (`agents/worker.ts`), junto da purga das requisições.
3. `docs/023` (Ciclo) e `docs/016` (Requisições): a regra do fechamento.

## Critérios de aceite
- [ ] Requisição `running` mais velha que o prazo vira `error` com motivo e `finished_at`.
- [ ] Requisição em andamento dentro do prazo não é tocada.
- [ ] A saúde do provedor passa a contar essas falhas.

## Testes recomendados
- pgTAP em `database/tests/0040_ai_requests_and_app_settings.sql`: `running` antiga fecha, recente fica, terminada não muda, limite respeitado.
- `apps/server/test/ai-requests.test.ts`: uma requisição inserida `running` com `started_at` antigo some da lista de em andamento depois da manutenção.

## Limitações e suposições
Nada foi executado. O `stop_grace_period` do compose de produção não foi visto; com um prazo maior, o caso fica mais raro, mas a queda por OOM continua.

## Análise (triagem)

## Resolução (executor)
