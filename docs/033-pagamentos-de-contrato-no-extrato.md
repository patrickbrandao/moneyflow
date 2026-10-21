# 033 — Reconhecer o pagamento das séries no extrato (F19, generalizada na F20)

O pagamento de uma ocorrência de série recorrente ([005](005-titulos-baixas-e-movimentos.md)) — uma obrigação de contrato ([020](020-contratos.md), [034](034-contratos-sobre-series.md)) ou qualquer série (contas de luz, escola, assinaturas também variam e atrasam) — é a baixa do título na conta onde o dinheiro se move. Esta especificação faz a conciliação ([009](009-extratos-e-conciliacao.md)) achar e baixar a ocorrência certa nos casos reais (pago com juros e multa, com desconto, atrasado ou adiantado dentro do mês), e mostra no detalhe do contrato os valores mês a mês e os dias de atraso ou adiantamento.

Decisões do usuário (2026-10-20): tolerância de valor com juros, multa e desconto; janela maior e procura no mesmo mês da ocorrência; gráficos no detalhe. Na F20 a regra passou a valer para toda série, com os ajustes na série; a conta das parcelas do contrato, a conta de passagem e a baixa com transferência saíram (a obrigação mora na conta onde o dinheiro se move).

## Conta prevista

- Cada ocorrência guarda a conta prevista (`titles.planned_account_id`): uma conta **da caixa do título** — corrente, poupança ou cofre — onde o pagamento sai (a pagar) ou o recebimento entra (a receber). A série copia a conta da ocorrência mais recente para as novas.
- Trocar: na gaveta do título, "Conta prevista", para ocorrência em aberto ou parcial. Em "só esta" a ocorrência fica com conta própria (`planned_account_custom`); em "esta e as próximas", as seguintes em aberto mudam junto e seguem a série. O aditivo do contrato também troca a conta das obrigações.
- O campo vale em qualquer título (também no avulso). A baixa manual vem com a conta prevista escolhida; o usuário pode trocar.
- O espelho ([006](006-espelhamento-entre-caixas.md)) tem a conta prevista própria, definida por quem escreve na caixa dele.

## Ajustes de reconhecimento (na série)

Campos da série (no formulário do título recorrente, da obrigação do contrato e na edição da série), usados só para reconhecer o valor pago no extrato (não lançam nada sozinhos):

- **Janela** (`match_window_days`, padrão 15, 0–45) além do mesmo mês do vencimento.
- **Multa por atraso** (`late_fee_percent`, 0–20%) sobre o valor da ocorrência, cobrada uma vez.
- **Juros de mora** (`interest_month_percent`, 0–10% ao mês), pró-rata por dia de atraso (mês = 30 dias).
- **Desconto por pontualidade** (`early_discount_percent`, 0–50%) até o vencimento.
- **Tolerância** (`tolerance_cents`, padrão 0, até 10% do valor): diferença aceita além dos encargos (tarifa de boleto, arredondamento do banco).
- **Baixar sem confirmação** (`auto_settle`, padrão desligado).

Sem ajustes, a série casa no mesmo mês do vencimento ou na janela com o valor exato. Título avulso (fora de série) continua com a regra de sempre (valor exato, ±3 dias).

## Como a linha acha a ocorrência

Para cada linha nova de uma conta, além dos candidatos de sempre (movimentos da conta; títulos da caixa da conta com valor exato e ±3 dias), entram as **ocorrências de séries** em aberto ou parciais, na direção da linha, que cumprem:

1. **Onde**: a ocorrência é da caixa da conta e a conta prevista dela é a conta da linha (ou não tem conta prevista).
2. **Quando**: a data da linha está no **mesmo mês do vencimento**, ou a até `match_window_days` dias do vencimento, o que for mais largo.
3. **Quanto**: o valor da linha (absoluto) bate com o saldo em aberto de um destes jeitos:
   - **exato**;
   - **com encargos**, se a linha é depois do vencimento: entre o saldo e o saldo + multa + juros dos dias de atraso + tolerância;
   - **com desconto**, se a linha é até o vencimento: entre o saldo − desconto − tolerância e o saldo;
   - **dentro da tolerância** em qualquer data;
   - **parcial**: menor que o saldo, fora dos casos acima. Só vira candidato quando nenhuma outra ocorrência da série casa, e sempre como sugestão de baixa parcial.

**Desempate** entre ocorrências da mesma série com o mesmo valor (o aluguel igual todo mês): primeiro a do **mesmo mês** da linha; se ela já está paga, a **mais antiga em aberto** dentro da janela (o atraso paga a mais velha antes). Entre séries diferentes, vale a pontuação (data, descrição, entidade), e a ocorrência com a conta prevista igual à da linha ganha um bônus. Ocorrência já sugerida para outra linha do lote não é sugerida de novo.

Na **fatura do cartão**, a mesma regra compara a linha com as ocorrências esperadas das cobranças no cartão ([007](007-cartao-de-credito.md)), sem encargos (só valor exato e tolerância, nunca parcial).

## Baixa a partir da linha

- O valor da linha vira a baixa repartida: **principal** = o saldo da ocorrência (ou o valor da linha, se parcial); o que passa do saldo vai para a **multa** até o máximo calculado e o resto para **juros**; o que falta para o saldo, numa linha até o vencimento ou dentro da tolerância, vira **desconto**. A data da baixa é a da linha, e a conta é a da linha (sempre um título da caixa dela; não há transferência).
- **Confirmação**: continua sugestão, aprovada uma a uma ou em lote. A sugestão mostra a ocorrência (contrato ou série, n, mês), a repartição (principal, multa, juros, desconto) e os dias de atraso ou adiantamento.
- **Baixar sem confirmação**: a linha vira conciliada direto quando há **um único** candidato, ele é ocorrência de uma série com `auto_settle`, a conta da linha é a conta prevista e o valor é exato ou com encargos/desconto dentro dos limites (nunca parcial, nunca só pela tolerância). Na fatura, a cobrança esperada com o valor exato vira a compra ligada. Fica com a marca de baixa automática, e a notificação do sino avisa uma vez por lote quantas foram baixadas.
- O agente (conciliação com IA, receitas, tools) recebe a ocorrência nos candidatos com a repartição, e `match_statement_line` com `titleId` faz a mesma baixa repartida.

## Detalhe do contrato: pagamentos

Seção **Pagamentos** no detalhe do contrato, somando as obrigações, com o filtro da vigência (atual, uma anterior ou todas):

- **Valores por mês** (barras): previsto (soma das ocorrências que vencem no mês) e pago/recebido (as baixas do mês, principal; no cartão, a compra), com encargos e desconto à parte, nas cores dos gráficos (`--chart-N`). Valores no formato contábil.
- **Atraso ou adiantamento** (barras por ocorrência): dias entre o vencimento e a baixa que quitou (a última baixa ativa); no cartão, entre a data esperada e a da compra. Positivo = atraso, negativo = adiantamento, zero = no dia. Em aberto e vencida aparece com o atraso até hoje, em tom de alerta.
- **Resumo**: pagas no prazo (%), atraso médio e máximo em dias, total de encargos e de desconto, ocorrências em aberto, em atraso e não cobradas (cartão).
- **Tabela**: obrigação, ocorrência, mês, vencimento, valor, pago, data da baixa (ou da compra), dias, conta, conta prevista, origem da baixa (manual, conciliação, automática) e, no cartão, "Cobrada", "Esperada" ou "Não cobrada". Exportação CSV/PDF como as demais.
- API: `GET /api/contracts/:id/payments?cycleId=` (a vigência filtra pelo vencimento) devolve as linhas da função `contract_payments` com as baixas, os dias e o resumo; os gráficos usam os auxiliares de `admin-ai/usage-charts.tsx`.

## Decisões da implementação

Entregue na F19 (tarefas [041](../tasks/041-pagamentos-de-contrato-no-banco.md) e [042](../tasks/042-pagamentos-de-contrato-na-aplicacao.md)) e generalizada na F20 (tarefas [043](../tasks/043-contratos-sobre-series-no-banco.md) e [044](../tasks/044-contratos-sobre-series-na-aplicacao.md)):

- **Encargos**: a multa é sobre o valor da ocorrência; os juros, sobre o **saldo em aberto**, `round(saldo × % × dias / 30 / 100)`; o desconto, sobre o saldo. A tolerância usada é `min(tolerance_cents, 10% do valor)`; gravar acima do teto (do valor atual da série) é recusado (`recurrence_rules_tolerance_cents_check`, com o máximo na mensagem).
- **Classificação do valor** (`splitSettlement` em `packages/shared/src/reconcile.ts`): `exact`; `charges` quando o excedente cabe na multa + juros; `discount` quando a falta cabe no desconto; `tolerance` quando só a tolerância explica (inclusive excedente antes do vencimento, que vai para os juros, porque a multa ali é zero); `partial` para qualquer valor menor que o saldo fora desses casos. Baixar sem confirmação só com `exact`, `charges` ou `discount` (no cartão, só `exact`).
- **Candidatos** (`seriesMatch`, `cardChargeMatch` e `pickSeriesOccurrences` no shared; `candidatesFor` em `services/statements.ts`): pontuação da ocorrência `60 − 2 × dias` (no mesmo mês do vencimento os dias contam no máximo 10) `+ 30 × semelhança da descrição + 10` se a conta prevista é a da linha, `− 20` na parcial (mínimo 1). A mesma ocorrência achada também pela regra de sempre conta uma vez só, a da série. As cobranças esperadas do cartão são calculadas pelo calendário (`services/card-charges.ts`), sem as que já têm compra não estornada por inteiro.
- **Casar à mão** (`match_statement_line`, "Casar" da tela) não confere a janela: o valor da linha é repartido pelos ajustes da série (parcial se menor que o saldo; recusado se passar dos encargos e da tolerância). Título fora de série continua com o valor inteiro como principal.
- **Fatura do cartão**: a cobrança esperada não vira sugestão gravada (não há lançamento para ligar); a tela do lote mostra, em cada linha nova, a sugestão calculada (`cardCharge`), e confirmar (`POST /api/statement-lines/:id/card-charge`, tool `create_card_charge_from_line`) cria a compra à vista na pagadora da obrigação, ligada à série, à ocorrência e ao contrato, conciliada com `created_entry = purchase` (o desfazer e excluir a tira).
- **Baixa sem confirmação**: na importação e no "Casar de novo" do lote, cada uma num savepoint (se o usuário não escreve na caixa ou o lançamento falha, a linha fica como sugestão). O aviso do sino vai para quem importou, tipo `system`, uma vez por lote (`dedup_key = auto_settled:<lote>`), com o link do lote.
- **Histórico da F19**: as linhas conciliadas com `transfer_settlement` (baixa na conta de passagem com a transferência) continuam valendo e o desfazer continua estornando as duas; a baixa nova não cria transferência.
- **Pagamentos**: quem lê o contrato (inclusive pelo espelho) vê; os nomes das contas só das caixas legíveis. Resumo: pagas no prazo = pagas (ou cobradas) com dias ≤ 0 sobre as pagas; atraso médio = média de `max(0, dias)` das pagas; atraso máximo = o maior entre pagas e vencidas em aberto. Valores por mês: previsto pelo mês do vencimento; pago (principal), encargos e desconto pelo mês da baixa — em **colunas lado a lado** por mês (o `MonthColumns` da tela da conta).
- **Gráfico de atraso**: barras por ocorrência a partir de zero (para cima atraso, para baixo adiantamento), paga com atraso `--chart-2`, no prazo ou adiantada `--chart-3`, em aberto e vencida `--danger`; em aberto no prazo não aparece.
