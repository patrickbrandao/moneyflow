---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: b492cc7
---

# Falhas engolidas sem log no worker de faturas, de contratos, das séries e na baixa automática

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** erro engolido / observabilidade
- **Arquivos afetados:** `apps/server/src/services/cards.ts:540-571`, `apps/server/src/services/contract-worker.ts:57-92`, `apps/server/src/worker.ts:30-39`, `apps/server/src/services/recurrence.ts:119-124`, `apps/server/src/services/statements.ts:721-725`, `apps/server/src/services/statements.ts:752-801`
- **Depende de / relacionado a:** 063 (mesmo padrão corrigido em `produceMessages`); tarefa 085; tarefa 082
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando o worker não consegue fechar uma fatura (com `CARD_AUTO_CLOSE`), renovar ou encerrar um contrato ou materializar uma série, ele só soma "1 falha" e tenta de novo na passada seguinte, para sempre, sem dizer o motivo. O contrato continua "vigente" depois do fim, sem renovação nem aviso, e ninguém sabe por quê. O mesmo vale para a baixa automática do extrato: se a baixa falha por qualquer motivo, a linha vira só sugestão e ninguém fica sabendo por quê, nem o usuário, nem o log do servidor.

### Evidência e análise técnica
É o mesmo padrão (`catch` que descarta o erro e devolve só um contador ou `false`) em quatro lugares:

**1. Worker de faturas (`cardMaintenance`).**
- `cards.ts:545-552` e `559-567`: `catch { failed += 1; }` no horizonte e no fechamento automático.
- `worker.ts:35-39` registra só os contadores (`log.info(cards, ...)`). O erro, o id da fatura e o código do banco se perdem.
- Falhas persistentes possíveis no caminho: `no_open_invoice` no crédito do fechamento (ver o arquivo relacionado), mês fechado na pagadora (`period_closings_locked_check` ao criar o título da fatura) e qualquer checagem deferida no COMMIT.
- Com vários workers, o segundo que tenta fechar a mesma fatura recebe `invoice_closed` (`closeInvoiceTx` trava a linha e confere `closedAt`) e também entra como falha, misturando corrida benigna com erro real.

**2. Worker de contratos (`contractMaintenance`).**
- `contract-worker.ts:66-88`: `catch { failed += 1; }` em cada `syncLifecycle`.
- `worker.ts:35-39` registra só os contadores (`log.info(contracts, ...)`).
- Falhas persistentes possíveis: `series_end_blocked` ao estender uma série na renovação e qualquer checagem deferida no COMMIT.

**3. Materialização das séries (`materializeAll`).**
- `apps/server/src/services/recurrence.ts:121-123` engole o erro de cada série (`catch { failed += 1 }`); o worker só registra a contagem (`apps/server/src/worker.ts:34`, `log.info(result, 'worker: séries materializadas')`), e uma série que falha a cada passada nunca aparece no log. (Nota de outro revisor, conferida nas duas linhas no commit `7f0984f`.)

**4. Baixa automática do extrato (`autoSettleLine`).**
- `autoSettleLine` envolve a baixa num savepoint e termina em `catch { return false; }` (`statements.ts:798-800`). `autoMatch` então grava a linha como sugerida (`:721-725`, `:738`). O `catch` não distingue:
  - o caso previsto pela spec (o usuário não escreve na caixa: `assertWrite` em `settleInTx`/`insertChargePurchase`);
  - uma divergência entre `splitSettlement` e `settleInTx` (a checagem `statement_lines_movement_check` do valor do movimento, `schema.sql:9316-9324`);
  - qualquer outra checagem deferida forçada pelo `SET CONSTRAINTS ALL IMMEDIATE` (`:794`), que inclui as pendências do lote inteiro, não só desta linha.

### Verificação (tentativa de refutação)
- A tarefa 063 corrigiu o mesmo padrão em `produceMessages` (log por assinatura e contadores separados), mas estes laços não foram tocados. Não há outro ponto que registre esses erros: as funções capturam tudo e devolvem só números.
- Baixa automática: a spec quer o recuo para sugestão ("se o usuário não escreve na caixa ou o lançamento falha, a linha fica como sugestão", `docs/033-pagamentos-de-contrato-no-extrato.md:70`): o comportamento está certo, o que falta é o rastro. O caso "sem escrita" nem acontece nos dois chamadores: importar e "Casar de novo" já exigem escrita na caixa da conta ou do cartão (`resolveTarget(…, true)`, `statements.ts:388`; `rematchImport`, `:1190`), e a ocorrência é sempre da mesma caixa (`t.caixa_id = a.caixa_id`, `:621`; no cartão, `chargeTarget` exige a série do próprio cartão). Toda falha que chega ao `catch` é, portanto, inesperada. `autoMatch` recebe `ctx`, mas o `ServiceContext` não tem logger; o `eachLine` de `reconciliation.ts:160-163` pelo menos devolve o motivo em `failed`; aqui o motivo some.
- Não há teste que force a falha da baixa automática e confira o resultado.

### Impacto
Operação e diagnóstico: uma fatura que nunca fecha sozinha, um contrato que nunca renova, uma série que não materializa ou uma baixa automática que "não funciona" ficam invisíveis, salvo pelo `failed` > 0 repetido a cada passada. Não há como saber se é permissão, dado ou defeito; o diagnóstico exige reproduzir à mão. Sem efeito em dado no caso da baixa.

## Como reproduzir
- Fatura: fechar o mês de outubro na caixa pagadora e deixar passar o fechamento da fatura 10/2026 com `CARD_AUTO_CLOSE=true`. O log mostra `{ closed: 0, failed: 1 }` a cada `WORKER_INTERVAL_MS`, sem o motivo.
- Baixa automática: série com `auto_settle` e algo que faça `settleInTx` recusar a baixa na data da linha (por exemplo, o mês da linha fechado na caixa, se o fechamento barrar a baixa): a linha fica sugerida e nada aparece no log nem na resposta.

## Solução proposta
- Passar o `log` (ou um callback `onError`) a `cardMaintenance`, a `contractMaintenance` e a `materializeAll` e registrar `warn` com o id (fatura, contrato ou série), o código e a mensagem do erro. Os erros crus do banco, que chegam aqui sem passar pelo tradutor das rotas, têm o `code` do Postgres e o `constraint`, e o log deve incluir os dois (`AppError` tem `code`, `errors.ts:5-13`).
- Tratar `invoice_closed` no fechamento automático como "já fechada" (não conta como falha).
- Opcional: devolver a lista de ids com falha no resultado, como fez a 063 com `subscriptionErrors`.
- Baixa automática: manter a defesa do caso previsto pela spec sem exceção (se `ctx.access.canWrite(caixaId)` é falso, devolver `false` sem tentar); nos erros, registrar `warn` com `importId`, `lineId`, o `code`/`constraint` do erro do banco (sem dados da linha) e devolver `false`. O logger pode entrar no `ServiceContext` (`apps/server/src/context.ts`) ou o erro voltar no resultado de `autoMatch` (`autoSettleFailed`) para a rota registrar.
- Opcional: devolver `autoSettleFailed` na resposta do import, para a tela mostrar "N baixas automáticas viraram sugestão".

### Diff/patch proposto — NÃO APLICADO
```diff
-      } catch {
-        failed += 1;
-      }
+      } catch (error) {
+        if ((error as { code?: string }).code === 'invoice_closed') continue;
+        failed += 1;
+        opts.log?.warn({ err: error, invoiceId: id }, 'worker: fatura não fechou');
+      }
```

## Critérios de aceite
- [ ] Toda falha do fechamento automático, da manutenção de contratos e da materialização das séries gera um `warn` com o id e o motivo.
- [ ] Fatura fechada por outro worker não conta como falha.
- [ ] Na baixa automática com falha, a linha vira sugestão e o log registra o motivo (código do erro), sem valores.

## Testes recomendados
- `apps/server/test/contracts.test.ts` e `apps/server/test/cards.test.ts`: com um logger dublê, forçar a falha (mês fechado na pagadora, série com baixa depois do fim novo) e conferir o `warn`, como no teste da 063 em `test/vision.test.ts`.
- `apps/server/test/contracts.test.ts` (onde está a baixa automática): série com `auto_settle` e uma falha forçada na baixa (por exemplo, um mês fechado na data da linha, que faz `settleInTx` recusar), conferindo que a linha fica sugerida e que `autoSettleFailed` traz o código do erro.

## Limitações e suposições
Nada foi executado. O `ServiceContext` não tem logger, por isso a proposta da baixa automática cobre os dois jeitos (logger no contexto ou o motivo no resultado).

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `cardMaintenance` e `contractMaintenance` tinham `catch { failed += 1; }`. O worker registrava só os contadores. `autoSettleLine` terminava em `catch { return false; }`. A materialização das séries já tinha o `onError` (tarefa 082, lote S1a).

## Resolução (executor)

- `apps/server/src/errors.ts`: `failureReason(erro)` devolve o código do `AppError` ou o traduzido do banco, o código do Postgres, a constraint e a mensagem.
- `apps/server/src/services/cards.ts`: `cardMaintenance(db, { autoClose, onError })` entrega cada cartão ou fatura que falhou (`CardMaintenanceFailure`, com o id e o motivo). A fatura que outro worker já fechou (`invoice_closed`) não conta como falha.
- `apps/server/src/services/contract-worker.ts`: `contractMaintenance(db, hoje, destinatários, onError)` entrega cada contrato que falhou (`ContractMaintenanceFailure`).
- `apps/server/src/worker.ts`: registra os dois em `warn` ("worker: fatura de cartão não atualizada" e "worker: contrato não renovado nem encerrado").
- Baixa automática: `ServiceContext.log` (opcional; `apps/server/src/context.ts`) recebe o `request.log` nas rotas (`apps/server/src/app.ts`). Em `apps/server/src/services/statements.ts`, `autoSettleLine` não tenta quando o usuário não escreve na caixa da conta ou do cartão (devolve `false`, o caso previsto pela spec). Na falha, registra `warn` com o lote, a linha, o código, o código do Postgres e a constraint, sem valores, e devolve `'failed'`. `autoMatch` conta `autoSettleFailed`. A resposta do import não mudou.
- Docs: `docs/007-cartao-de-credito.md` (fechamento automático), `docs/020-contratos.md` (worker) e `docs/033-pagamentos-de-contrato-no-extrato.md` (baixa sem confirmação).
- Testes: em `apps/server/test/cards.test.ts`, "fechamento automático que falha vai para o log com a fatura e o motivo (tarefa 136)" usa outubro fechado na pagadora e `period_closings_locked_check`. Em `apps/server/test/contracts.test.ts`, "contrato que o worker não consegue renovar vai para o log com o id e o motivo" usa agosto fechado e confere que o contrato fica vigente. No mesmo arquivo, "baixa sem confirmação que falha vira sugestão e deixa o motivo no log, sem valores" usa novembro fechado e um logger dublê no `ServiceContext`. O caso `invoice_closed` entre dois workers não tem teste, porque a corrida não é reproduzível sem dois processos.
- Verificação: `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s1 pnpm verify:quick` (nível rápido).
