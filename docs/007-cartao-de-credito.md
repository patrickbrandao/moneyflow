# 007 — Cartão de crédito (caixa do tipo cartão)

- Titular = emissor (entidade, ex.: Nu Pagamentos). Atributos: caixa pagadora padrão, limite, dia de fechamento e de vencimento, final do cartão.
- As **compras** ficam na caixa do cartão, cada uma com entidade recebedora (lojista/CNPJ), categoria e caixa pagadora (herda a padrão, pode ser trocada por compra). Assim todo movimento é rastreável até o recebedor final.
- Parcelado: a compra-mãe gera N parcelas nas faturas futuras (limite comprometido). Estorno: crédito vinculado à compra original, na fatura aberta.
- No **fechamento**, gera-se uma fatura-título por caixa pagadora (soma das compras dela): "a receber" na caixa do cartão, espelhada como "a pagar" na pagadora ([006](006-espelhamento-entre-caixas.md)). A pagadora navega da fatura para o detalhe das compras.
- Pagamento parcial ou antecipado abate a fatura; o restante rola para a próxima, com juros/IOF/multa lançados como encargos do emissor. A fatura pode ser reaberta enquanto não houver pagamento.
- Import de fatura OFX/CSV ([009](009-extratos-e-conciliacao.md)).

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
