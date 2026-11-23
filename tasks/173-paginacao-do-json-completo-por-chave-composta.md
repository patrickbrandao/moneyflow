---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Paginação do JSON completo compara a parte numérica da chave composta como texto, e nenhum teste passa de um lote

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** teste
- **Subcategoria:** keyset por chave composta sem tipo e sem cobertura
- **Arquivos afetados:** `apps/server/src/services/backup/export.ts:36,78-88,196-204`, `apps/server/src/services/backup/catalog.ts:201-216`, `database/schema.sql:13430-13438`, `apps/server/test/backup.test.ts:1275-1527`
- **Depende de / relacionado a:** tarefa 077 (mesmo laço de lotes)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O JSON completo lê cada tabela em lotes de 500 linhas. Numa tabela de chave composta com parte numérica (os degraus de valor das cobranças recorrentes no cartão), o segundo lote compara número com texto e o banco recusa: a exportação inteira falha. Hoje isso só acontece com mais de 500 degraus. O ponto maior é que o caminho dos lotes nunca é testado, e ele é o que roda em toda tabela grande.

### Evidência e análise técnica
A continuação do lote compara a tupla da chave com a última linha lida e converte cada parte em `uuid` (se for FK) ou em **texto**:

```ts
const uuidKeys = new Set(['id', ...meta.fks.map((fk) => fk.refColumn)]);
sql`(${columnList(keys)}) > (${... uuidKeys.has(k) ? sql`${String(after[k])}::uuid` : sql`${String(after[k])}::text`})`  // export.ts:81-86
```

`card_recurring_charge_amounts` tem a chave `(recurrence_rule_id, from_occurrence)` (`catalog.ts:212`), e `from_occurrence` é `smallint` (`schema.sql:13432`). O segundo lote gera `smallint > text`, que não existe no PostgreSQL (`operator does not exist`). Mesmo com uma conversão implícita, a ordem de texto ("10" < "9") não bate com o `ORDER BY` numérico.

A importação já sabe que essa parte é numérica (`import.ts:320-321`). A exportação não.

Sobre a cobertura: `BATCH = 500` é constante (`export.ts:36`) e o teste do JSON completo (`backup.test.ts:1276`) usa poucas linhas por tabela. Nenhum teste chega ao `after` nem às chaves compostas com mais de um lote (`entity_tag_links` e `ai_tool_kit_tools`, que passam fácil de 500 linhas numa instalação real).

### Verificação (tentativa de refutação)
- As outras chaves compostas têm só `uuid` e `text` (`ai_tool_kit_tools.tool_name`, `app_settings.key`, `ai_agent_inferences.capability`, que é `text` com CHECK), e a comparação funciona.
- 500 degraus de valor no cartão é improvável hoje. Por isso a severidade é baixa e o ganho principal é a cobertura do laço.

### Impacto
Latente: o JSON completo falha por inteiro (`500`) quando uma tabela de chave composta com parte não texto passa de 500 linhas. Sem teste, qualquer chave composta nova com `int`, `date` ou `enum` repete o problema sem aviso.

## Como reproduzir
1. Crie 501 degraus em `card_recurring_charge_amounts` (séries de cartão com várias mudanças de valor "dali em diante").
2. `GET /api/backup/full`: a consulta do segundo lote falha com `operator does not exist: smallint > text`.

## Solução proposta
1. No catálogo, guardar o tipo de cada coluna (`format_type(a.atttypid, a.atttypmod)`) e usar esse tipo no cast do parâmetro da continuação (`${after[k]}::<tipo>`), com `sql.raw` sobre um nome que vem do `pg_catalog`.
2. Deixar o tamanho do lote configurável em `exportFullZip` (parâmetro opcional, padrão 500), para os testes.

## Critérios de aceite
- [ ] A exportação completa com lote 2 produz o mesmo conteúdo que com lote 500, em todas as tabelas.
- [ ] Chave composta com parte `smallint` pagina na ordem numérica.

## Testes recomendados
`apps/server/test/backup.test.ts`, no `describe('backup: JSON completo num sistema novo')`: exportar com lote 2 um cenário com 3 ou mais linhas em `entity_tag_links`, `ai_tool_kit_tools` e `card_recurring_charge_amounts` (degraus 2, 3 e 10), e comparar com a exportação de lote 500.

## Limitações e suposições
Não executado contra o banco. O erro de operador foi deduzido da tipagem do PostgreSQL (não há `smallint > text`).

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: a continuação do lote convertia cada parte da chave em `uuid` (FK) ou em `text`; em `card_recurring_charge_amounts` (`from_occurrence smallint`), o segundo lote compararia `smallint > text`. Nenhum teste passava de um lote.

## Resolução (executor)

- `apps/server/src/services/backup/catalog.ts`: o catálogo guarda o tipo de cada coluna (`format_type(a.atttypid, a.atttypmod)`, em `ColumnMeta.type`).
- `apps/server/src/services/backup/export.ts`: a continuação da paginação converte cada parte da chave no tipo da coluna (`::smallint`, `::uuid`, `::text`…, com `sql.raw` sobre o nome vindo do `pg_catalog`). O laço dos lotes virou `tableBatches(tx, catálogo, tabela, ator, { maxRows })`, exportado; `exportFullZip` aceita `maxRows` (padrão 500).
- Teste em `apps/server/test/backup.test.ts`, "a paginação do JSON completo com lote 2 dá o mesmo conteúdo…": 3 ligações de tag, um kit com 3 tools e uma cobrança no cartão com degraus nas ocorrências 2, 3 e 10 (aditivos); `tableBatches` com lote 2 dá as mesmas linhas que com 500 em `entity_tag_links`, `ai_tool_kit_tools` e `card_recurring_charge_amounts`, e os degraus saem na ordem numérica.
- Verificação: `pnpm verify:quick` (banco `moneyflow_it_s1`).
