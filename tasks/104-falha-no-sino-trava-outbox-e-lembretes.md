---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 4c1fd05
---

# Uma falha ao gerar as notificações do sino para o Telegram e os alarmes dos lembretes

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** etapas do laço sem isolamento de erro
- **Arquivos afetados:** `apps/server/src/services/message-worker.ts:596-761,870-877`, `apps/server/src/worker.ts:51-61`
- **Depende de / relacionado a:** tarefa 063 (isolou só as assinaturas de `produceMessages`)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O laço de mensagens faz quatro coisas em fila: gera os avisos do Telegram, cria as notificações do sino, dispara os lembretes das anotações e envia a fila do Telegram. Se a etapa do sino der erro, as duas seguintes não rodam: nenhuma mensagem sai e nenhum alarme de lembrete toca, enquanto o erro se repetir.

### Evidência e análise técnica
- `messageTick` (`message-worker.ts:870-877`) encadeia `produceMessages` → `produceNotifications` → `noteRemindersTick` → `consumeOutbox` sem `try` entre elas. O `catch` fica em `worker.ts:56-57`, que só loga "falha no laço de mensagens" e espera a próxima passada.
- `produceMessages` isola cada assinatura (tarefa 063, `:533-553`), mas `produceNotifications` (`:596-761`) não isola nada: espelhos pendentes, contestados, faturas, limite, divergência, `contractNotifications` (outro módulo, `contract-worker.ts`), o resumo por caixa, `budgetAlerts` e o `createNotifications` em lotes de 200. Um erro em qualquer uma dessas consultas, ou uma linha recusada no INSERT de um lote, derruba a função.
- A própria resolução da tarefa 063 registrou o efeito ao testar: "o relógio inválido também derrubaria o sino e os lembretes da mesma passada".
- O laço de hora em hora (`worker.ts:29-46`) tem a mesma forma: um erro em `materializeAll` pula `cardMaintenance`, `contractMaintenance` e `purgeExpiredSessions` naquela passada (esses têm isolamento interno por item, o que reduz o risco).

### Verificação (tentativa de refutação)
- Erros transitórios (deadlock, FK de um usuário apagado entre a consulta e o INSERT, conexão) só atrasam 30 s. O problema sério é o erro que se repete: um dado que quebra `contractNotifications` ou `budgetAlerts` (funções do banco e código de outras features) para o Telegram e os lembretes de todos os usuários até alguém corrigir.
- A spec 035 põe o disparo dos lembretes "no laço de mensagens… antes do consumo da outbox" e a spec 013 não pede que o sino bloqueie o envio. Não há motivo funcional para a dependência.
- Não há teste que injete falha em `produceNotifications` e confira a outbox.

### Impacto
Ponto único de falha entre funções independentes: o alarme de um lembrete (que o usuário configurou para não esquecer algo) depende de as notificações de fatura, contrato e orçamento estarem sem erro.

## Como reproduzir
Com um `Executor` dublê que lança só na consulta de `card_limits` (ou o relógio inválido usado no teste da tarefa 063), chame `messageTick` com uma mensagem `pending` na outbox e um lembrete vencido: a mensagem continua `pending` e nenhum disparo é gravado.

## Solução proposta
1. Em `messageTick`, rodar cada etapa num `try/catch` próprio e devolver as falhas (`stageErrors`), como `subscriptionErrors`; `logMessageTick` loga cada uma. `consumeOutbox` roda sempre.
2. Em `produceNotifications`, isolar cada bloco (espelhos, faturas, limite, divergência, diários, contratos, orçamentos) e o INSERT de cada lote; um bloco que falha não impede os outros.
3. No laço de hora em hora, o mesmo para as quatro etapas.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/message-worker.ts
+++ b/apps/server/src/services/message-worker.ts
 export async function messageTick(db: Database, config: Config, clock: SpClock = spClock()) {
-  const produced = await produceMessages(db, config, clock);
-  const notifications = await produceNotifications(db, config, clock);
-  const reminders = await noteRemindersTick(db, config);
-  const consumed = await consumeOutbox(db, config);
-  return { ...produced, ...notifications, ...reminders, ...consumed };
+  const stageErrors: { stage: string; error: string }[] = [];
+  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
+    try { return await fn(); } catch (error) { stageErrors.push({ stage: name, error: String((error as Error)?.message ?? error).slice(0, 500) }); return null; }
+  };
+  const produced = await stage('messages', () => produceMessages(db, config, clock));
+  const notifications = await stage('notifications', () => produceNotifications(db, config, clock));
+  const reminders = await stage('reminders', () => noteRemindersTick(db, config));
+  const consumed = await stage('outbox', () => consumeOutbox(db, config));
+  return { ...produced, subscriptionErrors: produced?.subscriptionErrors ?? [], ...notifications, ...reminders, ...consumed, stageErrors };
 }
```
(O texto do erro deve passar pelo saneamento de tarefa 070.)

## Critérios de aceite
- [ ] Com `produceNotifications` lançando, a mensagem pendente é enviada e o lembrete vencido dispara na mesma passada.
- [ ] A falha aparece no log com o nome da etapa.

## Testes recomendados
`apps/server/test/vision.test.ts` (perto do caso da tarefa 063): `Executor` dublê que delega ao banco real e lança numa consulta de `produceNotifications`; uma mensagem `test` pendente e um lembrete com `next_fire_at` no passado; depois de `messageTick`, a mensagem está `sent` na Bot API falsa, há um disparo em `note_reminder_firings` e `stageErrors` tem a etapa `notifications`.

## Limitações e suposições
Nada foi executado. Não identifiquei um dado real que faça `produceNotifications` falhar sempre; o achado é a falta de contenção, que já mordeu no teste da 063.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: `messageTick` encadeava as quatro etapas sem `try` entre elas, `produceNotifications` não isolava nenhum bloco e o laço de hora em hora (`worker.ts`) tinha um `try` só para as quatro etapas.

## Resolução (executor)

- `apps/server/src/services/message-worker.ts`: `messageTick` roda cada etapa (`messages`, `notifications`, `reminders`, `outbox`) num `try` próprio e devolve `stageErrors` (`{ stage, error }`, o texto por `errorText`, tarefa 070); `produceNotifications` isola cada bloco (`mirror_pending`, `mirror_disputed`, `invoice_closed`, `card_limit`, `reconciliation_divergence`, `contracts`, `daily`, `ai_budget_alert`) e o INSERT de cada lote de 200 (recusado, refeito linha a linha para as boas entrarem), devolvendo `notificationErrors` (`notifications.<bloco>`), que o `messageTick` junta aos `stageErrors`. `logMessageTick` avisa cada etapa que falhou.
- `apps/server/src/worker.ts`: no laço de hora em hora, séries, cartões, contratos e sessões rodam cada um isolado (`step`), com o nome no log.
- Spec: `docs/013`, "Fila e envio".
- Testes: `apps/server/test/vision.test.ts` ("uma etapa que falha não para as outras…"): com o banco recusando a leitura das assinaturas (a etapa inteira do Telegram) e o bloco dos espelhos pendentes, a mesma passada envia a mensagem pendente, grava o disparo do lembrete vencido, devolve as duas etapas em `stageErrors` e o log as avisa com o nome. Os testes de `budgets`, `contracts`, `errors` e `notes` seguem passando.
- Verificação: `pnpm verify:quick`.
