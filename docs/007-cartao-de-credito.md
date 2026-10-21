# 007 — Cartão de crédito (caixa do tipo cartão)

- Titular = emissor (entidade, ex.: Nu Pagamentos). Atributos: caixa pagadora padrão, limite, dia de fechamento e de vencimento, final do cartão.
- As **compras** ficam na caixa do cartão, cada uma com entidade recebedora (lojista/CNPJ), categoria e caixa pagadora (herda a padrão, pode ser trocada por compra). Assim todo movimento é rastreável até o recebedor final.
- Parcelado: a compra-mãe gera N parcelas nas faturas futuras (limite comprometido). Estorno: crédito vinculado à compra original, na fatura aberta.
- No **fechamento**, gera-se uma fatura-título por caixa pagadora (soma das compras dela): "a receber" na caixa do cartão, espelhada como "a pagar" na pagadora ([006](006-espelhamento-entre-caixas.md)). A pagadora navega da fatura para o detalhe das compras.
- Pagamento parcial ou antecipado abate a fatura; o restante rola para a próxima, com juros/IOF/multa lançados como encargos do emissor. A fatura pode ser reaberta enquanto não houver pagamento.
- A aba **Compras** filtra pela data da compra com o mesmo período do extrato: padrão dos últimos 60 dias e próximos 30, atalhos Mês anterior, Mês atual, Próximo mês e Hoje, e a última escolha lembrada por cartão ([004](004-caixas-e-contas.md)).
- Import de fatura OFX/CSV ([009](009-extratos-e-conciliacao.md)): as linhas casam com as parcelas lançadas (valor oposto, data da compra ±3 dias) ou viram compras.

## Regras de operação (F2)

- **Competência da fatura** = mês do vencimento. Ela vence no dia de vencimento desse mês e fecha no dia de fechamento do mesmo mês, se ele vem antes do vencimento, ou do mês anterior (meses curtos usam o último dia). Uma compra entra na primeira fatura **aberta** que fecha no dia da compra ou depois; as parcelas seguem nas faturas dos meses seguintes. O resto da divisão em centavos fica na primeira parcela.
- O worker mantém criadas as faturas até 3 meses à frente. O fechamento é **manual** por padrão: a tela sugere fechar quando a data passa. Com `CARD_AUTO_CLOSE=true` o worker fecha sozinho.
- **Fechamento**: por pagadora, título = soma dos itens − antecipações já pagas. Saldo negativo (estornos/antecipações acima das compras) vira item "saldo anterior" negativo na fatura seguinte.
- **Lados do título da fatura**: "a receber" na caixa do cartão (o original) e "a pagar" na pagadora (o espelho). O `mirror_status` fica **no lado da pagadora**: aceito, ou aguardando aceite se quem fechou não tem permissão de escrita na pagadora. O lado do cartão é baixado sempre sem conta e não conta como "conta a definir".
- **Pagamento parcial**: a baixa cobre o valor pago, o par de títulos é reduzido a esse valor (ou cancelado, se nada foi pago), o restante rola como "saldo anterior" na fatura seguinte e os encargos (juros, IOF, multa) entram nela como lançamentos do emissor.
- **Pagamento antecipado** (fatura aberta): par de títulos já quitado, com as duas pernas da baixa e o movimento na conta da pagadora.
- **Reabrir**: só sem pagamento ativo; os títulos não pagos são excluídos (ou cancelados, se já tiveram baixa estornada) e o crédito rolado é desfeito.
- **Relatórios por competência** (F3, [014](014-visualizacao-e-relatorios.md)) usam as **compras** do cartão (recebedor final, categoria, data da compra) e **excluem** os títulos `card_invoice`, para não contar a despesa duas vezes. No **regime de caixa** o pagamento da fatura conta como o pagamento do título da pagadora, com a **categoria desse título** (origem `card_invoice_payment`), **sem ratear pelas compras**; os lojistas (recebedores finais) aparecem no regime de competência.
- **Status da fatura** (F3): aberta, fechada (com saldo a pagar), **rolada** (`carried_over`: fechada, nada mais a pagar nela, mas com saldo devedor rolado para a seguinte) e paga.
- O **canvas de fluxo** ([014](014-visualizacao-e-relatorios.md)) mostra o caminho pagadora → cartão (fatura) → lojista (compras); o relatório por entidade traz o mesmo rastreio.

```
Caixa "Nubank PJ" (cartão)
 titular: Nu Pagamentos  CNPJ …
 pagadora: Minha Empresa
 fecha dia 3 · vence dia 10 · limite 20.000

 Fatura 10/2026  (aberta)
  05/09  Posto Shell   CNPJ …  Combustível    350,00
  12/09  Kalunga       CNPJ …  Escritório   1.200,00 (2/6)
  20/09  Estorno Kalunga                      -80,00
  Σ = 1.470,00

Caixa "Minha Empresa"
 A pagar: Fatura Nubank 10/2026  1.470,00  → [ver detalhes]
```

## Cobrança recorrente esperada (F20, [034](034-contratos-sobre-series.md))

- Uma assinatura ou obrigação de contrato paga no cartão é uma **série na caixa do cartão** com a cobrança esperada (`card_recurring_charges`): calendário, valor (com degraus "dali em diante" de aditivos e reajustes), recebedor, categoria de despesa e a **caixa pagadora**. Não gera título nem compra adiantada: a fatura só tem o que de fato foi cobrado. Pode ser obrigação de um contrato (só "eu pago") ou solta (`POST /api/series`).
- As ocorrências esperadas são calculadas pelo calendário (não materializadas). A compra que atende uma ocorrência fica ligada a ela (`card_purchases.recurrence_rule_id`, `occurrence` e o contrato da série); no máximo uma compra não estornada por inteiro por ocorrência.
- **Na importação da fatura**, a linha nova que a regra de reconhecimento casa com uma ocorrência esperada (mesmo mês ou a janela da série, valor exato ou dentro da tolerância, sem encargos) mostra a sugestão **"Lançar como cobrança de <obrigação> de <mês>"**: confirmar cria a compra à vista na pagadora da obrigação, já ligada, e concilia a linha (`POST /api/statement-lines/:id/card-charge`). Com "baixar sem confirmação" na série e o valor exato, a compra é criada na importação (marca de baixa automática).
- **Compra lançada à mão**: "É cobrança de um contrato?" lista as ocorrências esperadas perto da data e do valor (`GET /api/cards/:id/expected-charges`) e liga a compra (`charge` no `POST /api/cards/:id/purchases`); a gaveta da compra liga ou solta depois (`POST /api/card-purchases/:id/charge-link`).
- **Não cobrada**: ocorrência cuja fatura esperada (a primeira que fecha na data esperada ou depois) já fechou sem compra ligada aparece como "Não cobrada" nos pagamentos do contrato e gera o aviso do sino `contract_charge_missing`, uma vez por ocorrência.
- Encerrar ou estender a cobrança é pela série (`POST /api/series/:id/end`); o aditivo do contrato muda o valor esperado a partir da primeira ocorrência na data de efeito.
