---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Linha da fatura casa com qualquer parcela da compra, sem olhar a fatura do lote

- **Severidade:** baixa
- **Confiança:** provável
- **Categoria:** ponto fraco
- **Subcategoria:** casamento assistido na fatura do cartão (parcelas)
- **Arquivos afetados:** `apps/server/src/services/statements.ts:531-553`, `packages/shared/src/reconcile.ts:135-141`, `docs/007-cartao-de-credito.md:9`
- **Depende de / relacionado a:** tarefa 139 (mesma consulta de candidatos)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Numa compra parcelada, todas as parcelas têm a mesma data de compra e o mesmo valor. Ao importar a fatura de um mês, a linha "LOJA X 02/10" vê as dez parcelas como candidatas iguais: nunca concilia sozinha (sempre fica para confirmar) e pode ser sugerida com a parcela de outra fatura, que depois falta para o mês dela.

### Evidência e análise técnica
- Os candidatos da linha do cartão (`statements.ts:532-541`) são os itens `installment` do cartão com o valor oposto e `p.purchased_on` a ±3 dias, sem filtro pela fatura do lote (`statement_imports.card_invoice_id`, que a tela preenche: `ImportModal.tsx:193`) nem pelo número da parcela, e sem `ORDER BY`.
- Para uma compra em N parcelas iguais, as N − (já conciliadas) parcelas empatam em valor, data e descrição. `pickMatch` só concilia direto com um único candidato do tipo (`reconcile.ts:137-141`), então a linha fica sempre `suggested`, e a escolhida entre as empatadas é a que o Postgres devolver primeiro.
- Se a fatura de um mês não foi importada, ou foi importada fora de ordem, a sugestão pode apontar a parcela de outra fatura; confirmada, essa parcela fica presa à linha (`statement_lines_card_item_matched_key`) e a linha do mês certo não a acha mais.

### Verificação (tentativa de refutação)
- A spec define o casamento pela "data da compra ±3 dias" (`docs/007-cartao-de-credito.md:9`), o que o código cumpre; ela não trata o empate das parcelas da mesma compra, e o lote já sabe a fatura.
- O banco só confere cartão e valor da parcela casada (`statement_lines_validate`, `schema.sql:9326-9335`), não a fatura.
- O teste da fatura (`apps/server/test/statements.test.ts:240-302`) usa compras à vista; a fixture tem uma "PARC 01/03" (`fatura-cartao.ofx`), mas só uma fatura é importada. A confiança é "provável" porque depende do banco escrever a data da compra original em cada parcela (o comum nas faturas, não verificado sem rede).

### Impacto
Faturas com compras parceladas: confirmação manual todo mês para cada parcela e, nos casos de fatura pulada ou fora de ordem, parcela casada com a linha de outra fatura. Sem efeito nos totais da fatura (o item continua na fatura dele).

## Como reproduzir
1. Compra de R$ 300,00 em 3x no cartão.
2. Importar a fatura do mês 2 antes da do mês 1, com a linha "LOJA X 02/03" de R$ -100,00 na data da compra.
3. A linha fica sugerida com a parcela 1 (ou outra), não com a 2 da fatura do lote.

## Solução proposta
1. Passar a fatura do lote ao `candidatesFor` (via `LineRow` ou um parâmetro) e, quando o lote tem `card_invoice_id`, preferir os itens dessa fatura: candidatos de outras faturas só se a do lote não tiver nenhum.
2. Sem fatura no lote, desempatar pelo menor `installment_number` em aberto (`ORDER BY i.installment_number` e o desempate por tipo/dias em `pickMatch` já preserva a ordem).
3. Com o empate resolvido pela fatura, deixar `pickMatch` conciliar direto quando sobrar uma parcela só daquela fatura.

## Critérios de aceite
- [ ] Na fatura do mês 2 de uma compra em 3x, a linha da parcela 2 é sugerida (ou conciliada) com o item da fatura do mês 2, mesmo com a fatura do mês 1 ainda não importada.
- [ ] Compra à vista continua casando como hoje.

## Testes recomendados
`apps/server/test/statements.test.ts`: compra em 3x e duas faturas OFX importadas fora de ordem, conferindo o item casado de cada linha.

## Limitações e suposições
Nada foi executado. A data que cada banco escreve nas parcelas não foi verificada.

## Análise (triagem)

## Resolução (executor)
