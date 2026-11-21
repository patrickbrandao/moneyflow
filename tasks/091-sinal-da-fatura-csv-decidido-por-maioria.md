---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# Sinal da fatura do cartão em CSV decidido pela maioria das linhas de cada arquivo

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** sinal (débito × crédito) da fatura em CSV
- **Arquivos afetados:** `apps/server/src/services/statements.ts:239-242`, `apps/server/src/services/reconciliation.ts:385-388`, `apps/server/src/services/statements.ts:531-541`, `packages/shared/src/schemas/operation.ts:171-195`, `database/schema.sql:15492-15515` (`statement_csv_mappings`), `database/schema.sql:9296-9305` (imutabilidade da linha)
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Na fatura do cartão importada em CSV, o sistema adivinha se o banco escreve as compras como valor positivo olhando se mais da metade das linhas daquele arquivo é positiva. Num mês com poucas compras (uma compra e o pagamento da fatura, ou uma compra e um estorno) a adivinhação vira, e as compras entram como crédito. Essas linhas não casam com as compras, não podem ser lançadas como compra e não podem ser corrigidas: os valores importados são imutáveis.

### Evidência e análise técnica
`statements.ts:239-242`:
```ts
if (target.kind === 'card' && lines.filter((l) => l.amountCents > 0).length > lines.length / 2) {
  lines = lines.map((l) => ({ ...l, amountCents: -l.amountCents }));
}
```
- Formato "compras positivas" (o caso que a spec quer inverter), mês com 1 compra `+150,00` e o pagamento `-150,00`: 1 positiva não é `> 2/2` → não inverte → a compra fica `+150,00` (crédito) e o pagamento `-150,00` (compra).
- Formato "compras negativas" (o do app), mês com 1 compra `-50,00`, o pagamento `+200,00` e um estorno `+30,00`: 2 positivas `> 1,5` → inverte → a compra vira `+50,00`.
- Com o sinal trocado: a linha positiva não vira compra (`lineCreditOnCard`, `reconciliation.ts:387`), não casa com a parcela (`-i.amount_cents = line.amount_cents`, `statements.ts:539`) e o `amount_cents` não muda depois (`statement_lines_immutable_check`, trigger `statement_lines_validate`, `schema.sql:9296-9305`). O hash de dedup inclui o valor, então reimportar o arquivo corrigido à mão entra em dobro se o lote errado não for excluído antes.
- O mapeamento é salvo por cartão (`statement_csv_mappings`), mas não guarda a convenção de sinal; a escolha é refeita a cada arquivo.

### Verificação (tentativa de refutação)
- A spec só diz "Na fatura de cartão em CSV com compras positivas, o sinal é invertido" (`docs/009-extratos-e-conciliacao.md:4`); não define a heurística por maioria nem prevê o mês com poucas compras.
- Não há teste da inversão: nenhum caso em `apps/server/test/statements.test.ts` importa CSV de cartão, e o CSV de fatura não tem fixture (`apps/server/test/fixtures/`).
- O mapeamento não tem campo de sinal (`csvMappingInput`, `operation.ts:171-183`; colunas do banco em `schema.sql:15492-15515`), e a tela do mapeamento (`ImportModal.tsx`) não oferece a opção.
- O OFX não passa por aqui (usa o sinal do `TRNAMT`), então o defeito é só do CSV.

### Impacto
Cartões com pouco uso, ou meses com estorno e pagamento na mesma fatura, importados em CSV: linhas com o sinal invertido que não conciliam e não se corrigem sem editar o arquivo. Frequência baixa por usuário, mas sem saída na tela quando acontece.

## Como reproduzir
1. Cartão com um mapeamento CSV (`Data;Descrição;Valor`).
2. Importar uma fatura com duas linhas: `05/10/2026;LOJA X;150,00` e `10/10/2026;PAGAMENTO RECEBIDO;-150,00`.
3. A linha da loja fica `amountCents = 15000`; "Lançar como compra" responde 422 (`lineCreditOnCard`).

## Solução proposta
1. (dba) `statement_csv_mappings.amount_sign text NOT NULL DEFAULT 'as_is'` com `CHECK (amount_sign IN ('as_is', 'invert'))`; só faz sentido no mapeamento de cartão, mas pode valer para conta também (banco que escreve débito positivo).
2. (app) `csvMappingInput`/`csvMappingUpdateInput` com `amountSign`; `parseStatementFile` aplica a inversão pelo mapeamento, nunca pela maioria.
3. (app) Na tela do mapeamento, a opção "Compras vêm positivas (inverter o sinal)", pré-marcada pela heurística atual só na criação do mapeamento, com a prévia mostrando o sinal resultante. Mapeamentos existentes de cartão recebem `invert` na migração se a maioria das linhas dos lotes CSV já importados com eles for positiva no arquivo original (ou ficam `as_is` e o usuário confere).
4. Sem mudar o banco, dá para guardar a escolha no `columns` (jsonb; a checagem `statement_csv_mappings_columns_check` só exige as chaves de data, descrição e valor), mas mistura opção com referência de coluna; a coluna própria é melhor.

## Critérios de aceite
- [ ] Com o mapeamento "inverter", uma fatura com uma compra e o pagamento entra com a compra negativa e o pagamento positivo.
- [ ] Com "como está", uma fatura com mais créditos que compras não é invertida.
- [ ] A prévia do mapeamento mostra o sinal final das linhas.

## Testes recomendados
`apps/server/test/statements.test.ts`: fatura CSV de cartão com 1 compra + 1 pagamento, nos dois valores de `amountSign`; e o caso de mais créditos que compras. Teste unitário da regra se ela for para o shared.

## Limitações e suposições
Nada foi executado; a conta foi feita lendo o código. Não verifiquei quais bancos exportam a fatura em CSV com compras positivas (sem rede).

## Análise (triagem)

## Resolução (executor)
