---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: dba
prioridade: baixa
criada: 2026-11-21
commit: cad1ff1
---

# O canvas de fluxo lê todos os títulos das caixas, de qualquer data, a cada chamada

- **Severidade:** baixa
- **Confiança:** provável (CTE referenciada duas vezes é materializada por padrão; o plano real não foi visto)
- **Categoria:** desempenho
- **Subcategoria:** CTE materializada sem o filtro de período
- **Arquivos afetados:** `database/schema.sql:6319-6425` (`flow_graph_lines`), `database/schema.sql:6297-6305` (`flow_graph_edges`), `database/schema.sql:6439-6485` (`flow_graph_nodes`), `apps/server/src/services/flow.ts:42,46,115`
- **Depende de / relacionado a:** tarefa 093
- **Executor sugerido:** dba
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Abrir o canvas de um mês custa o mesmo que abrir o de dez anos, porque o banco separa antes todos os títulos que as caixas já tiveram e só depois aplica o período. Isso acontece duas vezes por abertura, uma para os nós e outra para as arestas.

### Evidência e análise técnica
Em `flow_graph_lines` (`schema.sql:6331-6357`), `tt` seleciona `t.*` de todos os títulos das caixas pedidas, sem data, e `title_ends` deriva os extremos de cada um. `title_ends` aparece em dois ramos do `UNION ALL`: o realizado (`JOIN settlements s ... WHERE s.settled_on BETWEEN p_from AND p_to`, `:6359-6364`) e o previsto (`JOIN title_balances ... WHERE e.due_date BETWEEN p_from AND p_to`, `:6367-6373`). Desde o PostgreSQL 12, uma CTE sem `NOT MATERIALIZED` referenciada mais de uma vez é materializada. As condições de período dos ramos não descem até `titles`, e a materialização carrega todas as colunas (`t.*`, inclusive `notes` e `description`) de todo o histórico.

`flow.ts:42` e `:46` chamam `flow_graph_nodes` e `flow_graph_edges` em paralelo, e as duas chamam `flow_graph_lines`. A gaveta (`flow.ts:115`) chama de novo.

### Verificação (tentativa de refutação)
- `tt` é referenciada uma vez (em `title_ends`) e é inlinada; o problema está em `title_ends`, referenciada duas vezes.
- O período aceito vai até 3660 dias (`:6323`). Mesmo um período curto lê o histórico inteiro.
- Não há teste de desempenho do canvas; `database/tests/0019_flow_graph.sql` confere só os valores.

### Impacto
O custo de cada abertura do canvas e da gaveta cresce com o total de títulos das caixas legíveis, e não com o período mostrado. Para quem lê várias caixas com anos de histórico, o canvas de um mês lê dezenas de milhares de linhas duas ou três vezes.

## Como reproduzir
`EXPLAIN (ANALYZE)` de `SELECT * FROM flow_graph_edges(ARRAY[<caixa>], '2026-10-01', '2026-10-31')` numa caixa com anos de títulos: aparece um `CTE Scan on title_ends` com todas as linhas de `titles` da caixa.

## Solução proposta
1. Marcar `title_ends AS NOT MATERIALIZED`. O planejador inlina cada ramo, e o realizado parte das baixas do período (índice `settlements_settled_on_idx`) e busca o título pela chave. O previsto usa `titles_caixa_id_due_date_idx` (ou o índice com `status`, conforme o arquivo relacionado).
2. Ou separar em duas CTEs: uma com os títulos que têm baixa no período e outra com os que vencem no período e estão em aberto (`status IN ('open','partial')`).
3. Conferir com `EXPLAIN` que nenhum ramo lê `titles` sem caixa e data.

### Diff/patch proposto — NÃO APLICADO
```diff
-  title_ends AS (
+  title_ends AS NOT MATERIALIZED (
     SELECT tt.*,
```

## Critérios de aceite
- [ ] O `EXPLAIN` de `flow_graph_lines` num período de um mês não lê títulos fora do período, a não ser os que têm baixa no período.
- [ ] `database/tests/0019_flow_graph.sql` passa sem mudar os valores esperados.

## Testes recomendados
`database/tests/0019_flow_graph.sql`: os casos existentes, mais um título antigo pago fora do período, que não pode aparecer nem mudar os totais.

## Limitações e suposições
Nada foi executado. Com `NOT MATERIALIZED`, a expressão de `title_ends` é avaliada em cada ramo; o custo disso é pequeno perto da leitura do histórico.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado: em `flow_graph_lines`, `title_ends` é referenciada nos ramos do realizado e do previsto e, sem `NOT MATERIALIZED`, é materializada com todos os títulos das caixas, de qualquer data.

## Resolução (executor)

Migration `database/migrations/0058_query_performance.sql` (com as tarefas 144 e 147); teste `database/tests/0058_query_performance.sql`.

- `title_ends AS NOT MATERIALIZED`: cada ramo inlina os títulos e aplica o próprio período.
  - O realizado parte das baixas do período e busca o título pela chave.
  - O previsto ganhou `e.status IN ('open', 'partial')`, que é indexável por `titles_caixa_id_status_due_date_idx` com caixa e vencimento; continua junto de `open_cents > 0`, que é equivalente pela tarefa 093.
- Testes:
  - O canvas de abril traz a baixa do mês, o aberto que vence nele e a transferência, e deixa de fora um título pago antigo e os de outros meses.
  - O título antigo aparece no mês da baixa dele.
  - `prosrc` com o `NOT MATERIALIZED`.
- `tests/0019_flow_graph.sql` passa sem mudar os valores. `make dump` rodado.
- Nada a fazer na aplicação: a assinatura e as colunas são as mesmas.
