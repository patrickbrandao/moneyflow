# 033 — Pagamentos de contrato no extrato (F19)

As parcelas de um contrato ([020](020-contratos.md)) são títulos da caixa do contrato; o pagamento é a baixa do título numa conta. Hoje a conciliação ([009](009-extratos-e-conciliacao.md)) só acha a parcela quando o valor é exato, o vencimento está a ±3 dias e a conta é da mesma caixa. Esta especificação faz a conciliação achar e baixar a parcela certa nos casos reais (pago com juros e multa, com desconto, atrasado ou adiantado dentro do mês, por uma conta de outra caixa), define a **conta das parcelas** e mostra no detalhe do contrato os valores mês a mês e os dias de atraso ou adiantamento.

Decisões do usuário (2026-10-20): tolerância de valor com juros, multa e desconto; janela maior para título de contrato e procura no mesmo mês da parcela; busca nas caixas pagadoras; conta das parcelas no contrato com troca por parcela; gráficos no detalhe.

## Conta das parcelas

- **No contrato**: "Conta das parcelas" (`payment_account_id`), opcional: uma conta `checking`/`savings` onde o pagamento (a pagar) sai ou o recebimento (a receber) entra. Pode ser da caixa do contrato ou de **outra caixa** em que o usuário escreve (a caixa pagadora).
- **Conta de outra caixa**: o contrato também pede a **conta de passagem** (`transit_account_id`), uma conta da caixa do contrato. A baixa usa o mecanismo de "pagar o título da caixa B com uma conta da caixa A" ([005](005-titulos-baixas-e-movimentos.md)): transferência entre a conta pagadora e a de passagem e a baixa na de passagem, numa transação.
- **Na parcela**: cada título guarda a conta prevista (`titles.planned_account_id`, e `planned_transit_account_id` quando ela é de outra caixa). Ativar, renovar e o aditivo copiam a do contrato para as parcelas que geram ou recalculam.
- **Trocar a conta de uma parcela**: no detalhe do contrato (lista das parcelas) e na gaveta do título, "Conta prevista", para parcela em aberto ou parcial. A parcela trocada fica **própria** (`planned_account_custom = true`).
- **Trocar a do contrato**: pergunta se aplica às parcelas em aberto que seguem o contrato (as próprias não mudam), com a prévia de quantas mudam.
- O campo vale em qualquer título (a gaveta mostra "Conta prevista" sempre), mas só o contrato o preenche sozinho. A baixa manual vem com a conta prevista escolhida; o usuário pode trocar.
- O espelho ([006](006-espelhamento-entre-caixas.md)) tem a conta prevista própria, definida por quem escreve na caixa dele.

## Encargos do contrato

Campos opcionais no contrato, usados só para reconhecer o valor pago no extrato (não lançam nada sozinhos):

- **Multa por atraso** (`late_fee_percent`, 0–20%) sobre o valor da parcela, cobrada uma vez.
- **Juros de mora** (`interest_month_percent`, 0–10% ao mês), pró-rata por dia de atraso (mês = 30 dias).
- **Desconto por pontualidade** (`early_discount_percent`, 0–50%) até o vencimento.
- **Tolerância** (`tolerance_cents`, padrão 0, até 10% da parcela): diferença aceita além dos encargos (tarifa de boleto, arredondamento do banco).

## Como a linha acha a parcela

Para cada linha nova de uma conta, além dos candidatos de hoje (movimentos da conta; títulos da caixa da conta com valor exato e ±3 dias), entram as **parcelas de contrato** em aberto ou parciais, na direção da linha, que cumprem:

1. **Onde**: a parcela é da caixa da conta, **ou** a conta prevista dela é a conta da linha (assim a caixa pagadora acha a parcela da outra caixa).
2. **Quando**: a data da linha está no **mesmo mês do vencimento** da parcela, ou a até `match_window_days` dias do vencimento (no contrato, padrão 15, 0–45), o que for mais largo.
3. **Quanto**: o valor da linha (absoluto) bate com o saldo em aberto de um destes jeitos:
   - **exato**;
   - **com encargos**, se a linha é depois do vencimento: entre o saldo e o saldo + multa + juros dos dias de atraso + tolerância;
   - **com desconto**, se a linha é até o vencimento: entre o saldo − desconto − tolerância e o saldo;
   - **dentro da tolerância** em qualquer data;
   - **parcial**: menor que o saldo, fora dos casos acima. Só vira candidato quando nenhuma outra parcela do contrato casa, e sempre como sugestão de baixa parcial.

**Desempate** entre parcelas do mesmo contrato com o mesmo valor (o aluguel igual todo mês): primeiro a parcela do **mesmo mês** da linha; se ela já está paga, a **mais antiga em aberto** dentro da janela (o atraso paga a mais velha antes). Entre contratos diferentes, vale a pontuação de hoje (data, descrição, entidade), e a parcela da conta prevista igual à da linha ganha um bônus. Parcela já sugerida para outra linha do lote não é sugerida de novo.

## Baixa a partir da linha

- O valor da linha vira a baixa repartida: **principal** = o saldo da parcela (ou o valor da linha, se parcial); o que passa do saldo vai para a **multa** até o máximo calculado e o resto para **juros**; o que falta para o saldo, numa linha até o vencimento ou dentro da tolerância, vira **desconto**. A data da baixa é a da linha.
- A conta da baixa é a da linha. Se a linha é de outra caixa (a conta prevista), a baixa é na conta de passagem da parcela com a transferência a partir da conta da linha. O movimento conciliado com a linha é a perna da transferência na conta dela. Desfazer estorna a baixa e a transferência juntas.
- **Confirmação**: continua sugestão, aprovada uma a uma ou em lote, como hoje. A sugestão mostra a parcela (contrato, n/N, mês), a repartição (principal, multa, juros, desconto) e os dias de atraso ou adiantamento.
- **Baixar sem confirmação** (`auto_settle`, no contrato, desligado por padrão): a linha vira conciliada direto quando há **um único** candidato, ele é parcela desse contrato, a conta da linha é a conta prevista da parcela e o valor é exato ou com encargos/desconto dentro dos limites (nunca parcial, nunca só pela tolerância). Fica com a marca de baixa automática, e a notificação do sino avisa uma vez por lote quantas parcelas foram baixadas.
- O agente (conciliação com IA, receitas, tools) recebe a parcela nos candidatos com a repartição, e `match_statement_line` com `titleId` faz a mesma baixa repartida.

## Detalhe do contrato: pagamentos

Nova seção **Pagamentos** no detalhe do contrato, com o filtro do ciclo (atual, um anterior ou todos):

- **Valores por mês** (barras): previsto (soma das parcelas que vencem no mês) e pago/recebido (as baixas do mês, principal), com encargos e desconto empilhados à parte, nas cores dos gráficos (`--chart-N`). Valores no formato contábil.
- **Atraso ou adiantamento** (barras por parcela): dias entre o vencimento e a baixa que quitou (a última baixa ativa); positivo = atraso, negativo = adiantamento, zero = no dia. Parcela em aberto e vencida aparece com o atraso até hoje, em tom de alerta.
- **Resumo**: pagas no prazo (%), atraso médio e máximo em dias, total de encargos e de desconto, parcelas em aberto e em atraso.
- **Tabela**: n/N, mês, vencimento, valor, pago, data da baixa, dias (± em relação ao vencimento), conta, conta prevista (com o seletor de troca), origem da baixa (manual, conciliação, automática). Exportação CSV/PDF como as demais.
- API: `GET /api/contracts/:id/payments?cycleId=` devolve as parcelas com as baixas, os dias e o resumo; os gráficos usam os auxiliares de `admin-ai/usage-charts.tsx`.

## Banco (dba)

- `contracts`: `payment_account_id`, `transit_account_id` (FK `financial_accounts`), `late_fee_percent`, `interest_month_percent`, `early_discount_percent` (numeric com os limites acima, nulos = sem), `tolerance_cents` (≥ 0, padrão 0), `match_window_days` (0–45, padrão 15), `auto_settle` (padrão false). Conta das parcelas `checking`/`savings`; a de passagem obrigatória quando a das parcelas é de outra caixa e nula senão, sempre da caixa do contrato.
- `titles`: `planned_account_id`, `planned_transit_account_id`, `planned_account_custom` (padrão false), com as mesmas regras em relação à caixa do título; índice por `planned_account_id` (só os em aberto).
- `statement_lines.created_entry` aceita a baixa com transferência (o desfazer estorna as duas) e `auto_settled boolean` (só em `matched`).
- Uma função de leitura `contract_payments(contrato, ciclo)` (ou a view equivalente) com as parcelas, as baixas ativas repartidas, a data da que quitou e os dias; a aplicação monta o resumo.
- pgTAP das regras novas.

## Aplicação (app)

- Shared: entradas do contrato e do título com os campos novos; a regra de candidato e da repartição (`contractMatch`, `splitSettlement`) em `packages/shared/src/reconcile.ts`, com testes unitários (mesmo mês, janela, encargos, desconto, tolerância, parcial, desempate do aluguel igual, atraso pagando a mais antiga).
- Serviços: `candidatesFor` com as parcelas de contrato (inclusive a caixa pagadora pela conta prevista), `settleFromLine` com a repartição e a transferência, `auto_settle` na importação, o aviso do sino, `contracts.ts` copiando a conta prevista ao ativar/renovar/aditivo e aplicando a troca às parcelas que seguem o contrato, `GET /api/contracts/:id/payments`.
- Tools: candidatos e prévia de `match_statement_line` com a repartição; `update_contract` e a edição do título com a conta prevista.
- Telas: os campos no formulário do contrato (conta das parcelas, passagem, encargos, janela, baixar sem confirmação), a conta prevista na lista das parcelas e na gaveta do título, a sugestão com a repartição na conciliação e a seção Pagamentos.
- Testes de integração (`test/contracts.test.ts`, `test/statements.test.ts`): aluguel pago 10 dias atrasado com multa e juros; pago com desconto antes; dois meses iguais com o atraso pagando o mais antigo; pago pela conta de outra caixa (transferência e baixa, desfazer estorna as duas); `auto_settle` só no caso único; troca da conta da parcela e do contrato; o resumo de pagamentos. E2E: contrato com conta das parcelas, importar o OFX com o pagamento atrasado, confirmar a sugestão e ver o atraso no gráfico.

## Decisões da implementação (F19)

Entregue nas tarefas [041](../tasks/041-pagamentos-de-contrato-no-banco.md) (banco) e [042](../tasks/042-pagamentos-de-contrato-na-aplicacao.md) (aplicação). O que a especificação deixava em aberto ficou assim:

- **Encargos**: a multa é sobre o valor da parcela; os juros, sobre o **saldo em aberto**, `round(saldo × % × dias / 30 / 100)`; o desconto, sobre o saldo. A tolerância usada no reconhecimento é `min(tolerance_cents, 10% da parcela)`; gravar acima do teto é recusado (`contracts_tolerance_cents_check`, com o máximo na mensagem), contando a menor parcela do ciclo atual (`total ÷ parcelas`, arredondado para baixo).
- **Classificação do valor** (`splitSettlement` em `packages/shared/src/reconcile.ts`): `exact`; `charges` quando o excedente cabe na multa + juros; `discount` quando a falta cabe no desconto; `tolerance` quando só a tolerância explica (inclusive excedente antes do vencimento, que vai para os juros, porque a multa ali é zero); `partial` para qualquer valor menor que o saldo fora desses casos. Baixar sem confirmação só com `exact`, `charges` ou `discount`.
- **Pontuação da parcela** entre contratos: `60 − 2 × dias` (no mesmo mês do vencimento os dias contam no máximo 10) `+ 30 × semelhança da descrição + 10` se a conta prevista é a da linha, `− 20` na parcial (mínimo 1). A mesma parcela achada também pela regra de sempre (valor exato, ±3 dias) conta uma vez só, a do contrato.
- **Onde procura**: parcelas em aberto ou parciais, não arquivadas, da caixa da conta (o espelho da contraparte também, se ele é parcela de contrato) ou com a conta prevista igual à conta da linha **e** a de passagem definida. As de outra caixa só aparecem para quem lê aquela caixa; baixar exige escrita nas duas.
- **Casar à mão** (`match_statement_line`, "Casar" da tela) não confere a janela: o valor da linha é repartido pela regra do contrato (parcial se menor que o saldo; recusado se passar dos encargos e da tolerância). Título fora de contrato continua com o valor inteiro como principal.
- **Baixa sem confirmação**: na importação e no "Casar de novo" do lote, cada uma num savepoint (se o usuário não escreve na caixa da parcela ou a baixa falha, a linha fica como sugestão). O aviso do sino vai para quem importou, tipo `system`, uma vez por lote (`dedup_key = auto_settled:<lote>`), com o link da conciliação do lote.
- **Conta prevista**: trocar só em título em aberto ou parcial (qualquer título, pela `PATCH /api/titles/:id` com `plannedAccountId`/`plannedTransitAccountId`, e pela tool `update_title`); a troca deixa a parcela própria. Não há o "voltar a seguir o contrato". Conta da mesma caixa descarta a de passagem sozinha (no título e no contrato).
- **Conta do contrato**: `applyAccountToInstallments` (padrão false) em `PATCH /api/contracts/:id` e `update_contract`; a tela pergunta com a contagem de `followingOpenInstallments` (parcelas em aberto ou parciais, do lado do contrato, sem conta própria). Ativar e renovar copiam a conta para as parcelas geradas; o aditivo, para as recalculadas que não são próprias.
- **Pagamentos** (`GET /api/contracts/:id/payments?cycleId=`): quem lê o contrato (inclusive pelo espelho) vê; os nomes das contas só das caixas legíveis. A "Conta" de cada parcela é a da outra caixa que pagou pela transferência, senão a da última baixa. Resumo: pagas no prazo = pagas com dias ≤ 0 sobre as pagas; atraso médio = média de `max(0, dias)` das pagas; atraso máximo = o maior entre pagas e vencidas em aberto. Valores por mês: previsto pelo mês do vencimento; pago (principal), encargos e desconto pelo mês da baixa — em **colunas lado a lado** por mês (o `MonthColumns` da tela da conta), não empilhadas.
- **Gráfico de atraso**: barras por parcela a partir de zero (para cima atraso, para baixo adiantamento), paga com atraso `--chart-2`, no prazo ou adiantada `--chart-3`, em aberto e vencida `--danger`; parcela em aberto no prazo não aparece.
- **Excluir conta referenciada**: o `deleteAccount` de sempre arquiva quando há vínculo (FK); as mensagens dos `*_fkey` novos estão traduzidas para quando o banco recusar.
