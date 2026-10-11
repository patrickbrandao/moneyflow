# 007 — Cartão de crédito (caixa do tipo cartão)

- Titular = emissor (entidade, ex.: Nu Pagamentos). Atributos: caixa pagadora padrão, limite, dia de fechamento e de vencimento, final do cartão.
- As **compras** ficam na caixa do cartão, cada uma com entidade recebedora (lojista/CNPJ), categoria e caixa pagadora (herda a padrão, pode ser trocada por compra). Assim todo movimento é rastreável até o recebedor final.
- Parcelado: a compra-mãe gera N parcelas nas faturas futuras (limite comprometido). Estorno: crédito vinculado à compra original, na fatura aberta.
- No **fechamento**, gera-se uma fatura-título por caixa pagadora (soma das compras dela): "a receber" na caixa do cartão, espelhada como "a pagar" na pagadora ([006](006-espelhamento-entre-caixas.md)). A pagadora navega da fatura para o detalhe das compras.
- Pagamento parcial ou antecipado abate a fatura; o restante rola para a próxima, com juros/IOF/multa lançados como encargos do emissor. A fatura pode ser reaberta enquanto não houver pagamento.
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
