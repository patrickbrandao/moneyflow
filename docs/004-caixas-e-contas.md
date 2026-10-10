# 004 — Caixas e contas financeiras

## Caixa = livro financeiro de um titular

- Não existe camada de "Espaço". Cada Caixa tem um **titular** (entidade) e é a unidade de permissão ([002](002-usuarios-e-permissoes.md)).
- Uma entidade pode ser titular de várias caixas (ex.: Patrick → Casa Praia, Casa Cidade) e marca uma como **principal**.
- Tipos de caixa: **geral** (empresa, pessoa, casa) e **cartão de crédito** ([007](007-cartao-de-credito.md)).
- Cada caixa tem os próprios títulos a pagar e a receber ([005](005-titulos-baixas-e-movimentos.md)).

## Contas financeiras (dentro de uma caixa geral)

Cada conta pertence a uma única caixa.

- **Corrente/pagamento**: banco (COMPE/ISPB), agência, conta, saldo inicial, import OFX/CSV ([009](009-extratos-e-conciliacao.md)).
- **Cofre/dinheiro**: espécie física, lançamentos manuais e ajuste por contagem.
- **Poupança/investimento**: aportes, resgates e rendimento lançado; sem cotação de ativos.

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
