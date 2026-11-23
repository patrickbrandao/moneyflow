---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: app
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

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado: `statement_csv_mappings` não guarda a convenção de sinal, e a importação do cartão inverte pela maioria das linhas de cada arquivo (`statements.ts:239-242`). Os valores importados são imutáveis.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0063_csv_mapping_amount_sign.sql`; teste `database/tests/0063_csv_mapping_amount_sign.sql`; teste de migração com dados `database/migration-tests/0063_csv_mapping_amount_sign/` (`make test-migration M=0063` passou na subida, descida e subida).

- Coluna nova: `statement_csv_mappings.amount_sign text NOT NULL DEFAULT 'as_is'`, com `CHECK (amount_sign IN ('as_is', 'invert'))` (`statement_csv_mappings_amount_sign_check`). Vale para cartão e para conta. O `moneyflow_app` tem SELECT, INSERT e UPDATE pela tabela.
- Decisão para os mapeamentos que já existiam: a primeira opção da tarefa (pelo que os lotes importados mostram), com uma regra que dá para conferir no banco.
  - O arquivo original só existe como anexo e não dá para reinterpretar o CSV em SQL. Por isso a conversão usa `statement_lines.raw` (a linha do arquivo): a célula com os mesmos dígitos do valor dá o sinal do arquivo, pelas regras do `parseAmount` (sufixo D/C, parênteses, "-" na frente ou atrás).
  - A linha gravada com o sinal oposto foi invertida. Linha com células de sinais diferentes (por exemplo, o saldo com os mesmos dígitos) não conta.
  - O lote foi invertido se a maioria das linhas conferíveis foi. O mapeamento de cartão fica `invert` com pelo menos metade dos lotes conferíveis invertida e `as_is` se a maioria não foi.
  - Sem lote conferível (nenhum lote, ou valores sem as casas decimais no arquivo), fica `invert`, porque a fatura em CSV costuma trazer as compras positivas (spec 009).
  - Mapeamento de conta fica `as_is`, porque a aplicação nunca inverteu conta.
  - O auxiliar da conversão sai no fim da migration.
- Fixture do teste de migração: Nubank invertido, Inter não invertido, cartão sem lote, conta, valores sem casas, empate entre dois lotes e três lotes com parênteses, sufixo D/C e "-" atrás. As linhas e os valores gravados não mudam.
- `tests/0014_statements.sql` passou a ter a coluna em `columns_are`. `docs/016` (Extratos) atualizada. `make dump` rodado.

### Pendente na aplicação

1. `pnpm db:pull`, para a coluna nova `amount_sign` em `statement_csv_mappings`.
2. Schemas do shared:
   - `packages/shared/src/schemas/operation.ts`: `csvMappingInput` e `csvMappingUpdateInput` ganham `amountSign: z.enum(['as_is', 'invert'])`, opcional na atualização.
   - O DTO do mapeamento (`toMapping` em `apps/server/src/services/reconciliation.ts:527`) devolve `amountSign`, e o INSERT/UPDATE do mapeamento o grava.
3. `apps/server/src/services/statements.ts:239-242` (`parseStatementFile`): trocar a inversão pela maioria por `if (mapping.amountSign === 'invert') lines = lines.map((l) => ({ ...l, amountCents: -l.amountCents }))`. Vale para cartão e para conta, nunca pela maioria.
4. Tela do mapeamento (`ImportModal.tsx`):
   - A opção "Compras vêm positivas (inverter o sinal)", pré-marcada pela heurística da maioria só na criação do mapeamento.
   - A prévia mostra o sinal final das linhas.
5. Backup (`apps/server/src/services/backup/import.ts`): arquivo anterior à 0063, com o mapeamento sem `amountSign`, deve gravar `invert` no de cartão (o padrão da migração sem evidência) e `as_is` no de conta. Sem esse ajuste, o padrão do banco (`as_is`) deixaria o cartão sem inverter.
6. Testes em `apps/server/test/statements.test.ts`:
   - fatura CSV de cartão com 1 compra + 1 pagamento, com `amountSign` `invert` e `as_is`;
   - o caso de mais créditos que compras com `as_is`, que não pode ser invertido.

### Aplicação (app)

- `pnpm db:pull` já estava feito no branch de integração (`amount_sign` no schema gerado).
- `packages/shared/src/schemas/operation.ts`: `CSV_AMOUNT_SIGNS`/`CsvAmountSign`; `amountSign` opcional em `csvMappingInput` e `csvMappingUpdateInput` (a tool `import_statement` herda pelo `csvMapping`, com a descrição do padrão). `types.ts`: `CsvMappingRow.amountSign`.
- Decisão: na criação, `amountSign` é opcional e, omitido, vale o padrão do alvo (`invert` no cartão, `as_is` na conta, o mesmo da migração sem evidência), em vez de obrigatório: os clientes da API e os agentes que já criam mapeamentos continuam valendo, e o cartão não passa a entrar com o sinal trocado por omissão.
- `packages/shared/src/parsers/csv.ts`: `applyCsvAmountSign` (aplica o sinal do mapeamento) e `suggestCsvAmountSign` (a maioria das linhas, só para pré-marcar a tela no mapeamento novo do cartão).
- `apps/server/src/services/statements.ts` (`parseStatementFile`): a inversão pela maioria saiu; vale o sinal do mapeamento (o salvo ou o informado na tool), para cartão e conta. `defaultCsvAmountSign` exportado.
- `apps/server/src/services/reconciliation.ts`: o DTO (`toMapping`) devolve `amountSign`; `createMapping` grava o informado ou o padrão; `updateMapping` grava o informado.
- `apps/server/src/agents/tool-handlers-operation.ts`: a prévia do `import_statement` com `csvMapping` mostra o sinal que o mapeamento salvo vai ter.
- `apps/server/src/services/backup/import.ts` (`normalizeRow`): mapeamento de arquivo anterior à 0063, sem `amount_sign`, entra `invert` no cartão e `as_is` na conta. Só essa linha, por causa da tarefa 077 no mesmo arquivo.
- `apps/web/src/components/reconciliation/ImportModal.tsx`: a opção "Compras vêm positivas (inverter o sinal)" ("Débitos vêm positivos" na conta), pré-marcada pela sugestão só no mapeamento novo (o salvo traz o dele), e a prévia "Como as linhas vão entrar" com as primeiras linhas e o sinal final; textos em `i18n/areas/statements.ts`.
- `docs/009-extratos-e-conciliacao.md` e a linha da 009 no `docs/INDEX.md`.
- Testes: `apps/server/test/statements.test.ts`, "o sinal da fatura em CSV é o do mapeamento, nunca a maioria das linhas" (1 compra + 1 pagamento com `invert`, mais créditos que compras com `as_is`, o padrão do cartão e da conta, a troca pelo PATCH e o valor inválido); `apps/server/test/backup.test.ts`, "mapeamento de CSV de arquivo antigo, sem o sinal, entra invertido no cartão e como vem na conta"; `packages/shared/test/csv.test.ts`, o sinal aplicado e a sugestão.
- Verificação: `pnpm verify:quick` (nível rápido).

