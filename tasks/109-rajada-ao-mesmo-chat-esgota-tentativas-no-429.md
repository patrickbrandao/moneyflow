---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit:
---

# Rajada para o mesmo chat: cada 429 gasta uma das 5 tentativas e a mensagem vira falha definitiva

- **Severidade:** média
- **Confiança:** provável
- **Categoria:** bug
- **Subcategoria:** limite de taxa do Telegram tratado como falha
- **Arquivos afetados:** `apps/server/src/services/message-worker.ts:766-786`, `apps/server/src/services/messages.ts:497-524`, `apps/server/src/integrations/telegram.ts:67-70`, `database/schema.sql:6876` (`max_attempts` 5), `database/schema.sql:7023-7050` (`message_outbox_mark_failed`), `docs/013-mensagens-telegram.md:40`
- **Depende de / relacionado a:** tarefa 105 (corrigido, ele aumenta as rajadas)
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O Telegram limita quantas mensagens um bot manda para o mesmo grupo (cerca de 20 por minuto). Quando o MoneyFlow tem muitas mensagens para o mesmo grupo, como no dia em que alguém liga "Atrasados" com dezenas de contas vencidas, ele continua mandando depois do primeiro "espere", cada recusa conta como tentativa e, depois de cinco, a mensagem é dada como perdida, com o aviso "mensagem não enviada" no sino.

### Evidência e análise técnica
- `consumeOutbox` reserva até 10 por rodada, 5 rodadas por passada (até 50 a cada 30 s), e envia uma a uma (`message-worker.ts:770-783`). Depois de um 429, segue mandando as outras reservadas para o mesmo chat, que também levam 429.
- `deliver` → `markFailed(..., sent.retryAfterSec, false)` (`messages.ts:507`). No banco, `message_outbox_mark_failed` volta a `pending` com `next_attempt_at = agora + retry_after`, mas a tentativa já foi contada na reserva (`attempts + 1` em `message_outbox_claim`) e, com `attempts >= max_attempts` (5, `schema.sql:6876`), vira `failed` (`schema.sql:7023-7050`). O 429 não tem tratamento diferente de uma falha comum.
- Todas as mensagens recusadas ganham o mesmo `next_attempt_at` e voltam juntas na reserva seguinte (`ORDER BY next_attempt_at, id`), gerando nova rajada.
- Conta aproximada, para 200 mensagens a um grupo (20 por minuto): são cerca de 10 minutos para escoar, e cada mensagem é reservada a cada 30–60 s. As do fim da fila passam de 5 tentativas antes da vez delas.
- De onde vêm as rajadas: `overdue` gera uma mensagem por título atrasado, até 1000 (`message-worker.ts:323`), já na primeira passada depois de criar a assinatura; `due_reminder` gera até 30 por alvo (90 com D-3/D-1/D-0); a spec cita destinos de caixa como "grupo da casa" (`docs/013:10`).

### Verificação (tentativa de refutação)
- A spec define "mark_failed com retry_after do 429, backoff exponencial (30 s × 2^n, até 1 h, 5 tentativas)" (`docs/013:40`), mas não diz que o 429 deva gastar tentativa; o objetivo do `retry_after` é esperar, não desistir.
- O teste existente (`vision.test.ts:331-400`) cobre um 429 isolado, não uma sequência para o mesmo chat.
- Os limites do Telegram (20 mensagens por minuto no mesmo grupo, cerca de 1 por segundo por chat) vêm da documentação pública da Bot API; não conferi na rede nesta revisão.

### Impacto
No primeiro dia de uma assinatura de atrasados num grupo com acúmulo, ou num dia de muitos vencimentos, boa parte dos avisos vira `failed` sem ter saído, e cada uma gera um "mensagem não enviada" no sino do dono. Mandar às cegas depois do 429 também prolonga o bloqueio do bot.

## Como reproduzir
1. Bot API falsa (`e2e/fakes/fake-telegram.ts`) respondendo 429 com `retry_after: 2` depois de 20 envios por minuto para o mesmo `chat_id`.
2. Destino de grupo com `overdue` e 120 títulos atrasados.
3. Rode o laço de mensagens por alguns minutos: parte das mensagens termina `failed` com `attempts = 5` e `last_error` 429.

## Solução proposta
1. **dba:** um jeito de devolver a mensagem à fila sem gastar tentativa no 429 — por exemplo `message_outbox_mark_failed(..., p_count_attempt boolean DEFAULT true)` que, com `false`, desfaz o `attempts + 1` da reserva (mantendo um teto total de adiamentos, para não girar para sempre) —, ou uma `message_outbox_release(id, retry_after)`.
2. **app:** em `consumeOutbox`, ao receber 429 de um destino, guardar o `retry_after` daquele destino na passada e liberar as demais reservadas dele sem enviar, com o mesmo prazo. Opcional: espaçar os envios ao mesmo chat (por exemplo, 1 por segundo).
3. Atualizar a `docs/013` (o 429 adia, não conta como tentativa).

## Critérios de aceite
- [ ] 120 mensagens para um grupo limitado a 20 por minuto terminam todas `sent`, sem nenhuma `failed`.
- [ ] Depois de um 429, nenhuma outra mensagem do mesmo destino é enviada antes do `retry_after`.
- [ ] Erros que não são 429 continuam com as 5 tentativas e o backoff atuais.

## Testes recomendados
- `apps/server/test/vision.test.ts`: Bot API falsa com cota por chat; várias chamadas de `consumeOutbox` avançando o tempo (ou `next_attempt_at` ajustado à mão) até esvaziar; nenhuma `failed`.
- pgTAP da outbox (dba): a variante sem contar a tentativa mantém `attempts` e reagenda.

## Limitações e suposições
Nada foi executado; a conta de tentativas é uma estimativa. O comportamento exato do 429 do Telegram (valor do `retry_after`, janela) não foi medido.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado no `schema.sql`: `message_outbox_claim` soma a tentativa na reserva (`attempts + 1`), e `message_outbox_mark_failed` não distingue o 429. Com o `retry_after`, ela só muda o `next_attempt_at`, e a mensagem vira `failed` quando `attempts >= max_attempts` (5). O banco não tinha como devolver a mensagem à fila sem gastar a tentativa.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0071_message_outbox_release.sql`; teste `database/tests/0071_message_outbox_release.sql`.

- Coluna nova `message_outbox.deferrals smallint NOT NULL DEFAULT 0`, de 0 a 100 (`message_outbox_deferrals_check`): quantas vezes a mensagem voltou à fila sem gastar tentativa.
- Função nova `message_outbox_release(p_message_id uuid, p_retry_after interval DEFAULT NULL, p_error text DEFAULT NULL) RETURNS text`, com `EXECUTE` para a aplicação. Para uma mensagem em `sending`:
  - grava `status = pending`, `attempts − 1` (desfaz a reserva), `deferrals + 1` e `next_attempt_at` = agora + `p_retry_after`;
  - o `p_retry_after` é de 30 s por padrão, limitado entre 1 s e 1 dia;
  - grava `last_error = p_error`, ou mantém o anterior se vier vazio;
  - devolve o novo status;
  - fora de `sending`, dá `23514 message_outbox_transition_check`; com `p_retry_after` negativo, `22023`.
- Decisão: o teto é de 100 adiamentos. No teto, a liberação conta a tentativa como `message_outbox_mark_failed` e vira `failed` quando não sobram tentativas. Assim a mensagem não gira para sempre. 100 cobre com folga a fila de 1000 atrasados de um grupo a 20 por minuto, porque cada mensagem é adiada no máximo uma vez por reserva.
- A mesma função serve às outras reservadas do mesmo destino, que o worker libera sem enviar depois de um 429.
- O comentário de `message_outbox_mark_failed` passou a dizer que a tentativa conta e indica a função nova.

Testes:
- o 429 desfaz a tentativa, conta o adiamento e respeita o `retry_after`;
- a mensagem não é reservada de novo antes do prazo;
- a rajada da tarefa: 120 mensagens para um chat que aceita 20 por passada (os 50 do `claim` e o resto liberado), todas `sent` em 6 passadas, nenhuma `failed`, cada uma com uma tentativa só;
- o teto conta a tentativa e chega a `failed`;
- a faixa de `deferrals`;
- a falha comum continua contando a tentativa, com o backoff de 30 s.

Verificação:
- `make test` com `0071`, `0020` e `0023` passou, com o down da 0071.
- `docs/016` (Mensagens, outbox) atualizada. `make dump` rodado.

### Pendente na aplicação

1. `pnpm db:pull`, para a coluna nova `message_outbox.deferrals`, que também volta no `SETOF message_outbox` do `message_outbox_claim` e do `claim_one`.
2. `apps/server/src/services/messages.ts` (`deliver`/`markFailed`): quando `sendTelegramMessage` devolver 429 (o `retryAfterSec` preenchido e não permanente), chamar `SELECT message_outbox_release(${id}::uuid, ${retry}::interval, ${error}) AS status` em vez de `message_outbox_mark_failed`. As outras falhas ficam como estão.
   - `notifyFailure` só se o status devolvido for `failed`, o que agora só acontece no teto.
3. `apps/server/src/services/message-worker.ts` (`consumeOutbox`):
   - ao receber 429 de um destino, guardar até quando ele está bloqueado na passada (`destination_id` → agora + `retry_after`);
   - liberar as demais mensagens reservadas daquele destino sem enviar, com `message_outbox_release(id, retry_after restante, '429 …')`.
   - A reserva precisa devolver o `destination_id` (`c.destination_id` no SELECT do `claim`).
   - Opcional: espaçar os envios ao mesmo chat (cerca de 1 por segundo) dentro da passada.
4. Teste em `apps/server/test/vision.test.ts`: a Bot API falsa com cota por `chat_id` (429 com `retry_after` depois de 20 por minuto) e várias chamadas de `consumeOutbox`, ajustando `next_attempt_at`, até esvaziar. Nenhuma `failed`, e nenhuma mensagem do destino enviada antes do `retry_after`.
5. `docs/013` (Mensagens): o 429 adia e não conta como tentativa, com o teto de 100 adiamentos.

### Aplicação (app)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `deliver` mandava o 429 para `message_outbox_mark_failed`, e `consumeOutbox` seguia enviando as outras reservadas do mesmo destino.

1. `pnpm db:pull`: o schema gerado da integração já tinha `message_outbox.deferrals`.
2. `apps/server/src/services/messages.ts`: no 429 (`retryAfterSec` preenchido e não permanente), `deliver` chama `releaseMessage` (`SELECT message_outbox_release(id, retry, erro)`) em vez de `mark_failed`, e devolve o `retryAfterSec`. `notifyFailure` só com o status `failed`, que agora só vem do teto. As outras falhas seguem pelo `mark_failed` sem mudança.
3. `apps/server/src/services/message-worker.ts` (`consumeOutbox`): a reserva devolve `c.destination_id`; o 429 guarda até quando o destino espera, na passada, e as demais reservadas dele voltam à fila sem envio por `releaseMessage` com o prazo restante e o motivo `429 rate limited: destination waiting for retry_after (not sent)`.
   - Decisão: sem espaçar os envios ao mesmo chat (opcional na tarefa); com o 429 segurando o destino, a rajada já escoa sem falhas.
4. `docs/013` (Mensagens): o 429 adia e não conta como tentativa, as reservadas do destino voltam sem envio e o teto de 100 adiamentos.

Testes (`test/vision.test.ts`; a Bot API do teste ganhou a cota por chat e o modo 500):
- a rajada da tarefa: 120 mensagens para um chat que aceita 20 por janela, com `consumeOutbox` e o `next_attempt_at` adiantado entre as passadas, terminam todas `sent`, cada uma com uma tentativa, sem `message_failed` no sino, e em cada passada nada vai ao chat depois do primeiro 429 (no máximo 20 aceitas e a recusada);
- no teto (100 adiamentos e 4 tentativas), o 429 conta a tentativa e a mensagem vira `failed` com 5; um 500 conta a tentativa, sem adiamento, e volta com o backoff de 30 s;
- o "enviar teste" com 429 agora fica com `attempts` 0 e `deferrals` 1.

Verificação: rápida, `pnpm verify:quick --base HEAD`.
