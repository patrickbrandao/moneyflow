# 005 — Títulos, baixas, movimentos e transferências

- Cada caixa tem os próprios **títulos** a pagar e a receber: entidade, categoria, competência, vencimento, valor, anotações e anexos.
- Um título recebe uma ou mais **baixas** (parcial, juros, multa, desconto); cada baixa gera um **movimento** numa conta financeira. O estorno de baixa é uma operação própria.
- Recorrência e parcelamento por regra (mensal no dia X, semanal, anual, N parcelas). O worker materializa os títulos até 12 meses à frente; editar "esta e as próximas" reescreve os futuros.
- **Transferência** = par de movimentos ligados por `transfer_id`; não conta como receita nem despesa.
- Pagar um título da caixa B com uma conta da caixa A (com permissão) gera automaticamente a transferência A → B e a baixa em B.
- Títulos cuja contraparte é titular de uma caixa são espelhados ([006](006-espelhamento-entre-caixas.md)).
