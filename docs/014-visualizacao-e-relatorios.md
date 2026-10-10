# 014 — Visualização e relatórios

## Canvas de fluxo (React Flow)
- Nós: caixas (hubs, com saldo) e entidades externas (folhas, agrupadas por categoria quando forem muitas).
- Arestas: valor que fluiu no período, com espessura proporcional, cor por tipo (pagamento, recebimento, transferência, fatura) e tracejado animado para o previsto.
- O clique abre a gaveta com os movimentos. Posições salvas por usuário, com auto-layout inicial.

## Relatórios
- Despesa/receita por categoria (por caixa ou consolidado, mês a mês, variação, ranking).
- Fluxo de caixa projetado (30/60/90 dias, por caixa e por conta).
- Por entidade, incluindo o rastreio até o recebedor final via cartão.
- Export CSV/PDF de relatórios e listagens.
