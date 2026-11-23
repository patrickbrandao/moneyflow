---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: alta
criada: 2026-10-21
commit:
---

# Corrigir a data do estorno de uma baixa, com auditoria

## Descrição
O estorno (`reverseSettlement` em `apps/server/src/services/settlements.ts`) lança o movimento oposto em cada perna com conta na data `reversedOn`, que a tool `reverse_settlement` preenche com hoje quando o chamador não informa. Não existe forma de corrigir essa data depois: nem a API, nem a tela, nem uma tool. Quando o estorno serve para refazer a baixa (o caso comum: trocar a conta), a data certa é a da própria baixa; com a data de hoje, o movimento original e o novo valem ao mesmo tempo entre a data da baixa e o dia do estorno, e todos os lotes de extrato do intervalo ficam divergentes. Foi o que aconteceu quando um agente estornou e refez várias baixas antigas sem passar `reversedOn`.

Pedido:
1. Uma operação auditada para mudar a data de um estorno: recebe a baixa estornada e a nova data, e muda o `occurred_on` dos movimentos de estorno de todas as pernas (a do espelho inclusive), numa transação pelo `withTx` (ator e auditoria), com o `Access` de escrita nas caixas das pernas. Regras: a data não pode ser antes da baixa nem antes da abertura da conta; mês fechado bloqueia (o `movements_period_lock` já cuida, traduzir o erro); movimento de estorno conciliado com linha de extrato também bloqueia ou exige confirmação — decidir na triagem. Rota na API, ação na gaveta da baixa estornada e uma tool (`set_reversal_date`, categoria titles, com `preview`), no `AGENT_TOOLS` e no `TOOL_HANDLERS`.
2. Evitar a repetição: quando o agente estorna para refazer a baixa, a data do estorno deve ser a da baixa. No mínimo, a descrição da tool `reverse_settlement` diz isso e a prévia destaca quando o estorno cai em data diferente da baixa; avaliar se o padrão de `reversedOn` passa a ser a data da baixa.
3. Se o banco precisar de algo (permissão de UPDATE em `movements.occurred_on` para o papel da aplicação, checagem de que o movimento é de estorno), abrir a tarefa do dba.

## Como reproduzir
Título com baixa em conta, datada no passado; `reverse_settlement` sem `reversedOn`; o movimento de estorno sai com a data de hoje e não há como mudá-la. Pronto quando: a operação muda a data dos estornos de todas as pernas com auditoria (teste de integração com espelho, mês fechado e linha conciliada), a tool tem prévia e teste em `test/agent-tools.test.ts`, e a orientação do item 2 está no `reverse_settlement`.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba). A aplicação fica com a API, a tela e a tool.

Confirmado no banco:
- O estorno (`reverseSettlement`) marca as pernas como estornadas e lança, em cada perna com conta, o movimento oposto em `reversedOn`.
- O `moneyflow_app` já tem UPDATE em `movements`, e várias regras já valem para a data do estorno:
  - "não antes da baixa": `settlement_assert_movements` exige no COMMIT o estorno com `occurred_on >= settled_on`;
  - "não antes da abertura": `movements_validate`;
  - mês fechado na data antiga ou na nova: `movements_period_lock`.
- Faltavam três coisas: reconhecer qual movimento é o estorno, trocar as duas pernas juntas e barrar o estorno conciliado com uma linha de extrato. `movements_validate_statement` só protege conta e valor do movimento conciliado.

Decisões:
- Funções do banco (`SECURITY INVOKER`) em vez de um UPDATE direto da aplicação. A regra fica num lugar só, e a auditoria sai com o ator da transação do `withTx`.
- Movimento de estorno conciliado com linha de extrato **bloqueia** (a mais conservadora): a linha é o que o banco mostrou naquela data. Para mudar, o usuário desfaz a conciliação antes.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0064_settlement_reversal_date.sql`; teste `database/tests/0064_settlement_reversal_date.sql`.

- `settlement_reversal_movements(p_settlement_id uuid)` devolve `(settlement_id, title_id, caixa_id, settled_on, reversed_at, movement_id, financial_account_id, occurred_on, amount_cents, opening_date, statement_line_id)`:
  - as pernas da baixa (ela e a do espelho), a pedida primeiro, com a caixa do título;
  - o movimento de estorno de cada uma, que é o de sinal oposto ao valor em dinheiro da baixa; fica nulo se a perna não tem conta ou não foi estornada;
  - a linha de extrato `matched` com ele;
  - nenhuma linha se a baixa não existe.
- `settlement_reversal_set_date(p_settlement_id uuid, p_reversed_on date)` devolve `(movement_id, settlement_id, financial_account_id, old_date, new_date)`:
  - trava as pernas (`FOR UPDATE`) e muda a data do movimento de estorno das duas para `p_reversed_on`;
  - devolve só os movimentos que mudaram (a mesma data não muda nada).
- Erros de `settlement_reversal_set_date`:
  - `22023`: data nula;
  - `P0002`: baixa inexistente;
  - `23514 settlements_reversal_date_check`: baixa não estornada, ou data antes da baixa;
  - `23514 settlements_reversal_reconciled_check`: estorno conciliado;
  - `23514 period_closings_locked_check`: mês fechado na data antiga ou na nova, em qualquer perna, e nenhuma muda;
  - `23514 movements_opening_date_check`: antes da abertura da conta; na prática coberto por "não antes da baixa".
- `EXECUTE` só para `moneyflow_app`.
- Testes:
  - as pernas e o estorno (com juros, conciliado, baixa ativa, sem conta, inexistente);
  - cada recusa;
  - mês fechado na data antiga, na nova e na caixa do espelho;
  - a troca nas duas pernas pela baixa e pela perna do espelho, com o COMMIT passando e os movimentos da baixa sem mudar;
  - a auditoria com `user_id` e `actor_kind = human`;
  - a chamada pelo `moneyflow_app`.
- `docs/016` (Baixas) atualizada. `make dump` rodado.

### Pendente na aplicação

1. `pnpm db:pull`, se o schema gerado lista as funções.
2. Serviço (`apps/server/src/services/settlements.ts`): `setReversalDate(ctx, settlementId, { reversedOn })` dentro de `withTx(ctx, …)`:
   - Ler `SELECT * FROM settlement_reversal_movements($id)`. Sem linhas: 404.
   - `ctx.access.assertWrite(caixa_id)` em cada perna devolvida, inclusive a do espelho.
   - Chamar `SELECT * FROM settlement_reversal_set_date($id, $data::date)` e devolver o título (`getTitle`).
   - Traduzir em `apps/server/src/errors.ts` as constraints `settlements_reversal_date_check` ("a baixa não está estornada" / "a data do estorno não pode ser antes da baixa"), `settlements_reversal_reconciled_check` ("o estorno está conciliado com o extrato: desfaça a conciliação antes") e `period_closings_locked_check` (já existe).
3. Rota na API, por exemplo `POST /api/settlements/:id/reversal-date` com `{ reversedOn: 'YYYY-MM-DD' }`; schema Zod no shared.
4. Tela: na gaveta da baixa estornada, a ação "Corrigir data do estorno", com a data (sugestão: a data da baixa) e a prévia das pernas e contas que mudam, vinda de `settlement_reversal_movements`.
5. Tool `set_reversal_date` (categoria `titles`, escrita, com `preview`):
   - registrar em `AGENT_TOOLS` (shared) e em `TOOL_HANDLERS` (server), sobre o serviço acima;
   - a prévia lista as pernas com a data atual e a nova;
   - não entra sozinha em nenhum kit.
6. Item 2 da tarefa, em `reverse_settlement`:
   - a descrição da tool diz que, para refazer a baixa (trocar a conta), a data do estorno deve ser a da baixa;
   - a prévia destaca quando `reversedOn` difere de `settledOn`;
   - avaliar o padrão de `reversedOn` = data da baixa no fluxo de refazer.
7. Testes:
   - integração (`apps/server/test/titles.test.ts` ou `operation.test.ts`): troca com espelho, mês fechado, linha conciliada e permissão negada na caixa do espelho;
   - `test/agent-tools.test.ts`: prévia, execução e `/mcp` da tool.

### Aplicação (app)

- Decisões:
  - Permissão: escrita na caixa da baixa pedida e nas caixas das pernas cujo movimento de estorno muda (as com conta). A perna sem conta não muda nada e não pede escrita, para o espelho com "conta a definir" do outro lado não travar a correção. Sem escrita numa perna que muda: 403 com `t.errors.reversalDateOtherCaixa`; sem leitura na caixa da baixa: 404.
  - O padrão de `reversedOn` no estorno continua hoje (API, tela e tool): um estorno de verdade é de hoje. Para o caso de refazer a baixa, a descrição e a prévia do `reverse_settlement` orientam a data da baixa, e o modal de estorno mostra a dica com um atalho para a data da baixa.
  - Estorno conciliado bloqueia (a decisão da triagem); a tela e a prévia explicam e pedem desfazer a conciliação antes.
- `packages/shared`: `settlementReversalDateInput` (`schemas/index.ts`); `SettlementReversalInfo`/`SettlementReversalLeg` e, em `SettlementRow`, `reversalOn` (a data do movimento de estorno da perna) e `transferUndoAllowed` (`types.ts`); textos em `t.errors` e `t.settlement`; a tradução de `settlements_reversal_date_check` e `settlements_reversal_reconciled_check` em `i18n/errors.ts` (o mapa que `apps/server/src/errors.ts` usa; `period_closings_locked_check` já existia).
- `apps/server/src/services/settlements.ts`: `reversalInfo` (as pernas por `settlement_reversal_movements`, com a caixa e a conta, a pedida primeiro) e `setReversalDate` (`withTx`, o `Access` acima, as recusas de baixa não estornada e data antes da baixa antes do banco, e `settlement_reversal_set_date`, que devolve o título pedido). Rotas `GET /api/settlements/:id/reversal` e `POST /api/settlements/:id/reversal-date` (`routes/titles.ts`). `titles.ts` (`listSettlements`): `reversalOn` e `transferUndoAllowed`.
- Tool `set_reversal_date` (categoria `titles`, escrita, fora de qualquer kit): `AGENT_TOOLS` (`packages/shared/src/agents/tools.ts`) e `TOOL_HANDLERS` (`apps/server/src/agents/tool-handlers.ts`), com a prévia das pernas (data atual → nova), as recusas antes do cartão e os avisos (nada muda, data diferente da baixa, a divergência dos lotes). O `reverse_settlement` ganhou na descrição a orientação de refazer a baixa com `reversedOn = settledOn` e, na prévia, o aviso quando o estorno cai noutra data. A contagem do e2e de `agentes.spec.ts` é só da categoria Conciliação e não muda.
- Tela: na gaveta do título, a baixa estornada mostra "Estorno em …" e a ação "Corrigir data do estorno" (`ReversalDateModal` em `SettlementModal.tsx`: a data sugerida é a da baixa, as pernas com a data atual e a nova, e o aviso quando não dá para mudar).
- Specs: `docs/005` (o estorno e a correção da data), `docs/011` (as tools) e `docs/021` (a tool na categoria Títulos e baixas); linha da 005 no `docs/INDEX.md`.
- Testes:
  - `apps/server/test/titles.test.ts`, "muda as duas pernas com auditoria; recusa antes da baixa, mês fechado, estorno conciliado e quem não edita a outra caixa": espelho com as duas pernas com conta, a troca pela perna do espelho, a auditoria com o ator, o extrato, antes da baixa, baixa sem estorno, editor só de uma caixa, leitor e quem não vê, mês fechado na caixa do espelho (nenhuma perna muda) e a linha do extrato conciliada com o estorno (recusa até desfazer).
  - `apps/server/test/agent-tools.test.ts`, "estorno na data da baixa e set_reversal_date…": o aviso do `reverse_settlement`, as recusas pela prévia, a execução com o ator agente, "nada muda" e o `/mcp`.
- Fica para o e2e (não criei): o fluxo da gaveta com a ação nova.
- Verificação: `pnpm verify:quick` (nível rápido).
