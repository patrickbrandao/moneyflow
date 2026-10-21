---
status: aberta
tipo: melhoria
origem: usuario
autor: principal
responsavel:
prioridade: alta
criada: 2026-10-21
commit:
---

# Corrigir a data do estorno de uma baixa, com auditoria

## Descrição
O estorno (`reverseSettlement` em `apps/server/src/services/settlements.ts`) lança o movimento oposto em cada perna com conta na data `reversedOn`, que a tool `reverse_settlement` preenche com hoje quando o chamador não informa. Não existe forma de corrigir essa data depois: nem a API, nem a tela, nem uma tool. Quando o estorno serve para refazer a baixa (o caso comum: trocar a conta), a data certa é a da própria baixa; com a data de hoje, o movimento original e o novo valem ao mesmo tempo entre a data da baixa e o dia do estorno, e todos os lotes de extrato do intervalo ficam divergentes. Foi o que aconteceu quando um agente estornou e refez várias baixas antigas sem passar `reversedOn`.

Pedido:
1. Uma operação auditada para mudar a data de um estorno: recebe a baixa estornada e a nova data, e muda o `occurred_on` dos movimentos de estorno de todas as pernas (a do espelho inclusive), numa transação pelo `withTx` (ator e auditoria), com o `Access` de escrita nas caixas das pernas. Regras: a data não pode ser antes da baixa nem antes da abertura da conta; mês fechado bloqueia (o `movements_period_lock` já cuida, traduzir o erro); movimento de estorno conciliado com linha de extrato também bloqueia ou exige confirmação — decidir na triagem. Rota na API, ação na gaveta da baixa estornada e uma tool (`set_reversal_date`, categoria titles, com `preview`), no `AGENT_TOOLS` e no `TOOL_HANDLERS`.
2. Evitar a repetição: quando o agente estorna para refazer a baixa, a data do estorno deve ser a da baixa. No mínimo, a descrição da tool `reverse_settlement` diz isso e a prévia destaca quando o estorno cai em data diferente da baixa; avaliar se o padrão de `reversedOn` passa a ser a data da baixa.
3. Se o banco precisar de algo (permissão de UPDATE em `movements.occurred_on` para o papel da aplicação, checagem de que o movimento é de estorno), abrir a tarefa do dba.

## Como reproduzir
Título com baixa em conta, datada no passado; `reverse_settlement` sem `reversedOn`; o movimento de estorno sai com a data de hoje e não há como mudá-la. Pronto quando: a operação muda a data dos estornos de todas as pernas com auditoria (teste de integração com espelho, mês fechado e linha conciliada), a tool tem prévia e teste em `test/agent-tools.test.ts`, e a orientação do item 2 está no `reverse_settlement`.

## Análise (triagem)

## Resolução (executor)
