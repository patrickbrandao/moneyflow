# 004 — Caixas e contas financeiras

## Caixa = livro financeiro de um titular

- Não existe camada de "Espaço". Cada Caixa tem um **titular** (entidade) e é a unidade de permissão ([002](002-usuarios-e-permissoes.md)).
- Uma entidade pode ser titular de várias caixas (ex.: Patrick → Casa Praia, Casa Cidade) e marca uma como **principal**.
- Tipos de caixa: **geral** (empresa, pessoa, casa) e **cartão de crédito** ([007](007-cartao-de-credito.md)).
- Cada caixa tem os próprios títulos a pagar e a receber ([005](005-titulos-baixas-e-movimentos.md)).
- Na tela da caixa, o nome no título é um link para a página inicial dela (`/caixas/:id`, a primeira aba), de qualquer aba ou sub-tela.

## Contas financeiras (dentro de uma caixa geral)

Cada conta pertence a uma única caixa.

- **Corrente/pagamento**: banco (COMPE/ISPB), agência, conta, saldo inicial, import OFX/CSV ([009](009-extratos-e-conciliacao.md)).
- **Cofre/dinheiro**: espécie física, lançamentos manuais e ajuste por contagem.
- **Poupança/investimento**: aportes, resgates e rendimento lançado; sem cotação de ativos.

## Navegação: a caixa e a conta

A interface é hierárquica: a caixa mostra o geral, e cada conta tem uma tela própria que não mistura os totais da caixa nem as outras contas.

- **Tela da caixa** (`/caixas/:id/:aba`): continua como antes — saldo somado das contas, a receber e a pagar em aberto, vencidos, e as abas A pagar, A receber, Contas, Extrato (com o seletor de conta), Conciliação (idem, mais a guia Regras com o seletor de conta, [032](032-regras-de-classificacao-por-conta.md)), Fechamento e Membros. Logo abaixo dos números, uma faixa com cada conta ativa leva à tela da conta — cada botão mostra só o nome e o saldo (o tipo fica na dica, para a faixa caber quando há muitas contas, 2026-10-20); o nome da conta na aba Contas e o ícone ao lado do seletor no Extrato e na Conciliação também.
- **Tela da conta** (`/caixas/:id/accounts/:contaId/:aba`, aba padrão Resumo): o título mostra "Caixa › Conta", a trilha da topbar idem, e o subtítulo leva de volta à caixa. No topo, só números da conta: saldo atual, entradas e saídas do mês corrente e, em conta corrente e poupança, as linhas de extrato a conciliar (novas + sugeridas) com a data do último extrato; no cofre, o saldo inicial. Um seletor troca de conta na mesma aba; as ações são Voltar para a caixa, Lançamento avulso e Editar (para quem edita a caixa).
  - **Resumo**: período de 6 ou 12 meses (padrão), este ano ou o ano passado (`?period=`). Colunas de entradas e saídas por mês (baixas e avulsos; um interruptor soma as transferências entre contas), a linha do saldo ao fim de cada mês (vazia antes da abertura), uma pizza de despesas e outra de receitas pelos grupos de categoria (até 7 grupos e "Outras"; sem categoria em separado) e a tabela mês a mês com entradas, saídas, resultado, transferências recebidas e enviadas e o saldo final, exportável em CSV/PDF.
  - **Extrato**: o mesmo extrato da caixa, preso nesta conta (sem o seletor), e, separados dos movimentos, os **Previstos** ([034](034-contratos-sobre-series.md)): as ocorrências em aberto das séries com esta conta prevista (obrigações de contrato inclusive), cada uma com **Baixar** (a baixa já vem nesta conta, na data de hoje e no valor em aberto, editáveis).
  - **Cofre** (2026-10-20, [034](034-contratos-sobre-series.md)): não há extrato; o fato é o lançamento manual. O **lançamento avulso** com entidade, data e um valor que a regra de reconhecimento da série aceita para uma ocorrência em aberto prevista no cofre oferece "É o pagamento de <obrigação> de <mês>? Baixar a ocorrência" no lugar do avulso (`GET /api/accounts/:id/obligation-matches`).
- **Filtro de período do extrato** (2026-10-20, também nas listagens de títulos — [005](005-titulos-baixas-e-movimentos.md) — e nas compras do cartão — [007](007-cartao-de-credito.md)): as datas inicial e final começam preenchidas com os **últimos 60 dias e os próximos 30** (o botão **Padrão**) e há os atalhos **Mês anterior**, **Mês atual**, **Próximo mês** e **Hoje**. Mês anterior/próximo andam a partir do mês mostrado quando o filtro já é um mês inteiro (clicar de novo continua andando); senão, a partir do mês atual. A interface **lembra a última escolha de cada visão** neste navegador (`localStorage`): o extrato por conta — a mesma memória na aba Extrato da caixa e na tela da conta —, os títulos por caixa e direção e as compras por cartão; quem navega entre as telas volta ao filtro que deixou. Padrão, Mês atual e Hoje são guardados pelo atalho e recalculados no dia em que a tela abre; um mês escolhido ou datas digitadas ficam fixos. A lógica das datas fica em `packages/shared/src/period.ts`.
  - **Conciliação** (só corrente e poupança): os lotes e linhas desta conta, como na aba da caixa.
  - **Regras** (só corrente e poupança): as regras de classificação desta conta ([032](032-regras-de-classificacao-por-conta.md)), a mesma lista da guia Regras da caixa presa na conta, com Nova regra, Aplicar regras e Copiar regras de outra conta.
- **Resumo da conta na API**: `GET /api/accounts/:id/summary?from&to` (até ~36 meses; leitura na caixa da conta, senão 404). Devolve por mês as entradas e saídas sem transferências, as transferências recebidas e enviadas e o saldo ao fim do mês (`financial_account_balance_at`; nulo em mês futuro ou antes da abertura); as categorias pelo regime de caixa com as regras de `report_category_totals` restritas aos movimentos da conta (baixas pela categoria do título — o pagamento de fatura de cartão pela do título da fatura — e avulsos pela própria, sem categoria = tipo pelo sinal; transferências nunca entram); e, para corrente e poupança, a situação da conciliação (lotes, último lote e fim do período dele, linhas novas e sugeridas).
- Os links que a API e o worker gravam (notificações, mensagens, gaveta do canvas) continuam apontando para as abas da caixa com `?account=`; ambas as telas funcionam.

## Exemplo

```
Caixa "Contabilidade"  (titular: Escritório Contábil)
 ├ Contas: Itaú CC, Cofre
 └ A receber: Minha Empresa  R$ 900

Caixa "Minha Empresa"  (titular: Minha Empresa)
 ├ Contas: Inter PJ
 ├ A receber: Cliente X
 └ A pagar: Escritório R$ 900, Sócio

Caixa "Casa Praia"  (titular: Patrick)
 ├ Contas: Cofre casa
 └ A pagar: Energia, Água
```
