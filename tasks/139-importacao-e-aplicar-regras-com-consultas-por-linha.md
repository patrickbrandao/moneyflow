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

# Importação, casamento e "Aplicar regras" fazem consultas por linha (N+1) numa transação longa

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** desempenho
- **Subcategoria:** N+1 em lote grande
- **Arquivos afetados:** `apps/server/src/services/statements.ts:440-465`, `apps/server/src/services/statements.ts:699-741`, `apps/server/src/services/statements.ts:527-599`, `apps/server/src/services/statements.ts:607-625`, `apps/server/src/services/statements.ts:272-273`, `apps/server/src/services/statements.ts:704-707`, `apps/server/src/services/reconciliation.ts:774-812`, `apps/server/src/services/statement-supersede.ts:228-255`
- **Depende de / relacionado a:** tarefa 076 (a alternativa só de app dobra a consulta de regra por linha)
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Importar um extrato grande (um ano de conta, 2 mil linhas) faz o servidor conversar com o banco umas dez mil vezes, uma linha por vez, dentro de uma transação só. A tela fica esperando, e a transação segura as linhas e o lote durante todo esse tempo.

### Evidência e análise técnica
Para um lote de conta com N linhas novas, dentro do `withTx` de `importStatement`:
- `ruleFor` por linha (`statements.ts:440-441`): N chamadas de `classification_rule_for`, cada uma varrendo as regras da conta (inclusive `regex`).
- `autoMatch` por linha (`:712-713`): `candidatesFor` faz 2 consultas (`Promise.all` no mesmo cliente, que as serializa; `:556-578`) mais `seriesCandidates` (`:579`, `:612-625`), e depois 1 `UPDATE` por linha casada ou sugerida (`:735`, `:738`). No cartão, cada linha chama `expectedCardOccurrences` (`:543`), que consulta as regras e as compras já cobradas e recalcula o calendário de cada série desde a ocorrência 1.
- Antes do laço, a consulta de `pending` filtra por `coalesce(financial_account_id, card_caixa_id) = …` (`:704-707`), expressão que não usa índice: varredura de `statement_lines` inteira a cada import e a cada "Casar de novo".
- A dedup usa `NOT EXISTS (… statement_imports … provisional)` (`:272-273`) em vez da coluna `statement_lines.provisional`, que o banco mantém justamente para o índice parcial `statement_lines_account_dedup_key`.
- "Aplicar regras" na conta (`reconciliation.ts:774-812`): `SELECT … FOR UPDATE` de todas as linhas novas da conta, depois `ruleFor` e um `UPDATE` por linha.
- A troca do provisório (`statement-supersede.ts:228-255`): um `UPDATE` por linha do provisório e outro por linha do consolidado.

Total para N = 2.000: cerca de 4 consultas por linha no import (≈ 8.000 idas e voltas) e 2 por linha no "Aplicar regras". Com latência de 0,5–1 ms por ida e volta, são de 4 a 8 s de transação aberta só em rede, fora o custo das consultas.

### Verificação (tentativa de refutação)
- O `INSERT` das linhas já é em blocos de 500 (`statements.ts:460`), e a soma de uso das regras é agregada (`:461-465`): o resto não é.
- Não há limite de linhas por arquivo além dos 20 MB do upload (um OFX de 20 MB tem dezenas de milhares de transações) e não há `statement_timeout` nessas rotas (não encontrado em `apps/server/src`).
- Nenhum teste mede o tempo do import de um lote grande.

### Impacto
Imports de extratos longos (o primeiro ano de uma conta, um OFX anual) lentos e com a transação aberta, disputando a trava dos lotes (`ai_reconcile_import_lock`) e as linhas com a conciliação com IA e as receitas. Sem perda de dado.

## Como reproduzir
Gerar um OFX com 2.000 `STMTTRN` (datas e valores variados), importar numa conta com algumas regras e séries e medir o tempo do `POST /api/statement-imports`; com `log_min_duration_statement = 0` no Postgres de desenvolvimento, contar as consultas.

## Solução proposta
1. Regras em lote: uma consulta `SELECT x.i, classification_rule_for(conta, cartão, x.d, x.v) FROM unnest($descrições, $valores) WITH ORDINALITY AS x(d, v, i)` no lugar do laço (import e "Aplicar regras"); o `UPDATE` do "Aplicar regras" por `UPDATE … FROM unnest(...)`.
2. Candidatos em lote: buscar de uma vez os movimentos livres da conta, os títulos em aberto e as ocorrências de série no intervalo `[menor data − 76, maior data + 76]`, e casar em memória com `pickMatch` (que já é puro). No cartão, `expectedCardOccurrences` uma vez por lote, como já faz `cardChargeSuggestions` (`statements.ts:808-829`).
3. `UPDATE` das linhas casadas e sugeridas em lote (`UPDATE statement_lines SET … FROM (VALUES …)`), mantendo o savepoint só para a baixa automática.
4. `pending` por `financial_account_id = …` ou `card_caixa_id = …` conforme o alvo; dedup por `NOT statement_lines.provisional`.

## Critérios de aceite
- [ ] O número de consultas do import não cresce com o número de linhas (fora a baixa automática, uma por linha baixada).
- [ ] Os testes atuais de `statements.test.ts` e `statement-supersede.test.ts` passam sem mudança de resultado.

## Testes recomendados
`apps/server/test/statements.test.ts`: um import de 2.000 linhas geradas no teste, conferindo o resultado do casamento e um teto de tempo folgado (como o teste da tarefa 052 em `:185-200`).

## Limitações e suposições
Nada foi medido; os números vêm da contagem das consultas no código e de uma latência suposta.

## Análise (triagem)

## Resolução (executor)
