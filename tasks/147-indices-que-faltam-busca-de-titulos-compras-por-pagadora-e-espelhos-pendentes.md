---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# Índices que faltam: busca na descrição dos títulos, compras por pagadora e data, espelhos pendentes

- **Severidade:** baixa
- **Confiança:** confirmado (os índices não existem e as consultas os pediriam); o ganho não foi medido
- **Categoria:** desempenho
- **Subcategoria:** índice ausente para consulta quente
- **Arquivos afetados:** `database/schema.sql:18998-19103` (índices de `titles`), `database/schema.sql:18018` (`card_purchases_payer_caixa_id_idx`), `database/schema.sql:8418-8431,8551-8561` (relatórios), `apps/server/src/agents/search.ts:117-121`, `apps/server/src/services/titles.ts:106,121-123`, `apps/server/src/services/overview.ts:15,45`
- **Depende de / relacionado a:** tarefa 093
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Três buscas comuns leem mais do que precisam. A busca de títulos pela descrição (na paleta ⌘K e na busca dos agentes) percorre todos os títulos. Os relatórios de um mês leem todas as compras de cartão da caixa pagadora desde sempre. A visão geral procura espelhos pendentes de aceite em todos os títulos.

### Evidência e análise técnica
1. **Trigram em `titles.description`.** Linhas de extrato, compras de cartão, entidades e anotações têm índice `gin_trgm_ops` (`migrations/0014:242`, `0013:78`, `0003:27-28`, `0053:47-48`); `titles` não tem (`schema.sql:18998-19103`). A busca dos agentes usa o operador de similaridade em títulos, `t.description % ${query} OR t.description ILIKE ...` (`agents/search.ts:121`), que sem o índice calcula `similarity` linha a linha em todos os títulos das caixas. `listTitles` com `q` (`titles.ts:106`), usado pela paleta (`overview.ts:45`) a cada busca, faz `t.description ILIKE '%q%' OR e.name ILIKE '%q%'`, sem limite de período.
2. **`card_purchases (payer_caixa_id, purchased_on)`.** Os relatórios por competência filtram `(p.payer_caixa_id = ANY (caixas) OR p.card_caixa_id = ANY (caixas)) AND p.purchased_on BETWEEN de AND até` (`schema.sql:8429-8430` e `:8559-8560`). O lado do cartão tem `card_purchases_card_caixa_id_purchased_on_idx`. O lado da pagadora só tem `card_purchases_payer_caixa_id_idx (payer_caixa_id)` (`schema.sql:18018`), então esse ramo do BitmapOr traz todas as compras da pagadora desde o início e filtra a data depois.
3. **Espelho pendente.** `listTitles` com `pending_acceptance` filtra `t.mirror_status = 'pending'` (`titles.ts:121-123`), sem índice. A visão geral chama isso a cada abertura (`overview.ts:15`), e para o admin o filtro de caixa é vazio: a tabela inteira é lida.

### Verificação (tentativa de refutação)
- `entities_name_trgm_idx` ajuda o lado `e.name ILIKE`. O lado de `titles` continua sem índice, e o `OR` entre tabelas só usaria os dois índices se a consulta fosse reescrita.
- `card_purchases_payer_caixa_id_idx` também serve à FK. Um índice composto com `payer_caixa_id` na frente cobre a FK e a consulta, então o antigo pode sair.
- Os pendentes de aceite são poucos. Um índice parcial custa quase nada na escrita.

### Impacto
O custo cresce com o histórico total de títulos (busca e visão geral) e com o histórico de compras da pagadora (relatórios). Quem tem pouco histórico mal nota; caixas de empresa e o admin, que lê tudo, sentem primeiro.

## Como reproduzir
- `EXPLAIN ANALYZE` da parte `title` de `agents/search.ts` com uma palavra comum, numa caixa com 20 mil títulos: `Seq Scan` (ou varredura pela caixa) com `similarity` em cada linha.
- `EXPLAIN ANALYZE SELECT * FROM report_category_totals(ARRAY[<pagadora>], '2026-10-01', '2026-10-31')`: o ramo `card_purchases_payer_caixa_id_idx` devolve as compras de todos os anos.

## Solução proposta
1. (dba) `CREATE INDEX titles_description_trgm_idx ON titles USING gin (description gin_trgm_ops);`
2. (dba) `CREATE INDEX card_purchases_payer_caixa_id_purchased_on_idx ON card_purchases (payer_caixa_id, purchased_on);` e excluir `card_purchases_payer_caixa_id_idx`.
3. (dba) `CREATE INDEX titles_mirror_pending_idx ON titles (caixa_id) WHERE mirror_status = 'pending';`
4. (app) Em `listTitles`, reescrever a busca para os dois índices trigram serem usados: `(t.description ILIKE $q OR t.entity_id IN (SELECT id FROM entities WHERE name ILIKE $q))`. Rodar `pnpm db:pull` depois da migration.

## Critérios de aceite
- [ ] Os três índices existem e aparecem no `EXPLAIN` das consultas citadas.
- [ ] A busca da paleta, a busca dos agentes e os relatórios devolvem os mesmos resultados.

## Testes recomendados
- `database/tests/0008_titles.sql` e `0013_credit_cards.sql`: `has_index` dos índices novos e o `hasnt_index` do substituído.
- `apps/server/test/titles.test.ts`: a busca por `q` acha pelo trecho da descrição e pelo nome da entidade, depois da reescrita.

## Limitações e suposições
Nada foi executado. O índice GIN aumenta um pouco o custo de inserir e editar títulos, o mesmo que já se paga em `statement_lines` e `card_purchases`.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado no `schema.sql`:
- `titles` não tinha índice trigram;
- `card_purchases` só tinha `(payer_caixa_id)` do lado da pagadora;
- não havia índice para `mirror_status = 'pending'`.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0058_query_performance.sql` (com as tarefas 144 e 146); teste `database/tests/0058_query_performance.sql`.

- `titles_description_trgm_idx`: `gin (description gin_trgm_ops)`.
- `titles_mirror_pending_idx`: `(caixa_id) WHERE mirror_status = 'pending'`.
- `card_purchases_payer_caixa_id_purchased_on_idx`: `(payer_caixa_id, purchased_on)`. Substitui `card_purchases_payer_caixa_id_idx`, que foi excluído; o composto serve à FK.
- Testes: os índices existem com a definição esperada, o substituído não existe mais e a FK continua indexada. Os planos usam os índices novos em:
  - `ILIKE '%…%'` e `%` na descrição dos títulos;
  - compras da pagadora no período;
  - espelhos pendentes com e sem caixa.
- `tests/0013_credit_cards.sql` passou a esperar o índice novo. `docs/016` (Títulos e Cartão) atualizada. `make dump` rodado.

### Pendente na aplicação

1. `pnpm db:pull`: os índices novos e o removido entram no schema gerado.
2. Em `apps/server/src/services/titles.ts:106` (`listTitles` com `q`), trocar `t.description ILIKE $q OR e.name ILIKE $q` por `(t.description ILIKE $q OR t.entity_id IN (SELECT id FROM entities WHERE name ILIKE $q))`. Assim o planejador usa os dois índices trigram, `titles_description_trgm_idx` e `entities_name_trgm_idx`, num BitmapOr.
3. A busca dos agentes (`agents/search.ts:121`) já usa `t.description % … OR t.description ILIKE …`: com o índice ela fica indexada, sem mudar o código.
4. Teste em `apps/server/test/titles.test.ts`: a busca por `q` acha pelo trecho da descrição e pelo nome da entidade, depois da reescrita.

### Aplicação (app)

- `pnpm db:pull` já estava feito no branch de integração.
- `apps/server/src/services/titles.ts` (`listTitles`/`titleTotals` com `q`, também a busca da paleta): `(t.description ILIKE $q OR t.entity_id IN (SELECT id FROM entities WHERE name ILIKE $q))`, para o planejador usar `titles_description_trgm_idx` e `entities_name_trgm_idx`. O resultado não muda.
- `agents/search.ts` ficou como estava (o índice novo já o atende).
- Teste: `apps/server/test/titles.test.ts`, "acha pelo trecho da descrição e pelo nome da entidade" (sem diferenciar maiúsculas, o mesmo texto na descrição de um e na entidade de outro, nenhum resultado e os totais do filtro).
- Verificação: `pnpm verify:quick` (nível rápido).

