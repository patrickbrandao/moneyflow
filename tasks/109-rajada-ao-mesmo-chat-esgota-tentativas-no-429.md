---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
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

## Resolução (executor)
