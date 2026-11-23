---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: b24cae1
---

# Prévia do `import_statement` lê lotes de `supersedeImportIds` sem `Access` e sem validar o alvo

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** id vindo do corpo sem `Access` (prévia diverge da execução)
- **Arquivos afetados:** `apps/server/src/services/statements.ts:305-311`, `apps/server/src/services/statement-supersede.ts:166-173`, `apps/server/src/services/statement-supersede.ts:297-311`, `apps/server/src/agents/tool-handlers-operation.ts:541-566`
- **Depende de / relacionado a:** tarefa 058 (prévias das tools sem `Access`; este caso não foi coberto)
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando o agente propõe importar um extrato substituindo um lote provisório, o cartão de aprovação calcula a troca com os lotes que o agente informou, sem conferir se são provisórios da mesma conta nem se o usuário pode vê-los. O cartão pode mostrar uma troca que a importação de verdade vai recusar, e as contagens saem de um lote de outra caixa.

### Evidência e análise técnica
- A prévia monta `supersedeIds` direto de `opts.supersede` (o `supersedeImportIds` da tool) e chama `previewSupersedeForFile(ctx.db, supersedeIds, fresh)` (`statements.ts:310-311`).
- `previewSupersedeForFile` lê as linhas com `provisionalLines(db, ids)` (`statement-supersede.ts:166-173`): `WHERE statement_import_id = ANY(ids)`, sem conta, sem `provisional`, sem `superseded_by_import_id` e sem `canRead`.
- O cartão mostra as contagens do resultado (transferidas, casadas, descartadas, pendentes, sobras) (`tool-handlers-operation.ts:566`, `supersedeRows`).
- Na execução, `importStatement` → `supersedeInTx` → `resolveProvisionals` (`statement-supersede.ts:192-204`) aceita só provisórios ativos da conta e recusa o resto com 422 `supersede_invalid_target`. A prévia aprovada pelo usuário descreve uma operação que não acontece.

### Verificação (tentativa de refutação)
- A tarefa 058 corrigiu `matchTargetLabel` e `targetNames`; o caminho do `import_statement` não estava nela.
- O vazamento é só de contagens de linhas (por data e valor iguais aos do arquivo), de um lote cujo UUID é preciso conhecer; o `run` recusa. Por isso a severidade é baixa.
- A rota da tela (`POST /api/statement-imports`) não usa esta prévia, e a importação real valida.

### Impacto
Cartão de aprovação enganoso (a prévia mostra "N transferidas" e a execução falha) e uma leitura indireta de lote sem permissão, para quem conhece o id.

## Como reproduzir
Usuário editor só da caixa A, `import_statement` em `ask` num kit: pedir ao agente para importar um OFX na conta de A com `supersedeImportIds` = o id de um lote da caixa B (ou de um lote não provisório de A). O cartão mostra as contagens da troca; aprovar resulta em 422 `supersede_invalid_target`.

## Solução proposta
Validar os ids na prévia com a mesma regra da execução: exportar de `statement-supersede.ts` uma `validateProvisionalIds(db, accountId, ids)` (os provisórios ativos da conta, como `resolveProvisionals`) e chamá-la em `previewStatementImport` antes de `previewSupersedeForFile`, recusando com o mesmo 422. Sem mudança de spec.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/statements.ts
+++ b/apps/server/src/services/statements.ts
@@ export async function previewStatementImport(
   const supersedeIds = opts.provisional ? [...new Set([...overlap.map((p) => p.id), ...(opts.supersede ?? [])])] : (opts.supersede ?? []);
+  if (opts.supersede?.length) {
+    if (target.kind !== 'account') throw unprocessable(t.errors.statementProvisionalAccountOnly, 'statement_provisional_account_only');
+    const active = new Set((await activeProvisionals(ctx.db, target.accountId)).map((p) => p.id));
+    if (opts.supersede.some((id) => !active.has(id))) throw unprocessable(t.errors.supersedeInvalidTarget, 'supersede_invalid_target');
+  }
   const superseded = supersedeIds.length ? await previewSupersedeForFile(ctx.db, supersedeIds, fresh) : null;
```

## Critérios de aceite
- [ ] A prévia do `import_statement` com `supersedeImportIds` de outra conta (ou de lote não provisório, ou de outra caixa) responde 422 `supersede_invalid_target`, como a execução.
- [ ] A prévia com provisórios válidos continua mostrando as contagens.

## Testes recomendados
`apps/server/test/statement-supersede.test.ts`, caso "as tools…": prévia com o id de um lote de outra caixa e com um lote não provisório da mesma conta.

## Limitações e suposições
Nada foi executado.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: `previewStatementImport` passava `opts.supersede` direto para `previewSupersedeForFile`, que lê as linhas por `statement_import_id = ANY(ids)` sem conta, sem `provisional` e sem `Access`; a execução recusava com 422 `supersede_invalid_target`.

## Resolução (executor)

- `apps/server/src/services/statement-supersede.ts`: `assertActiveProvisionals(db, conta, ids)` exporta a regra da execução (`resolveProvisionals` passou a usar o mesmo `assertAmong`): só provisórios ativos da conta.
- `apps/server/src/services/statements.ts`: `previewStatementImport` recusa a troca fora de lote de conta (`statement_provisional_account_only`, como o import) e chama `assertActiveProvisionals` antes de ler o arquivo, com o mesmo 422 `supersede_invalid_target`. Como os lotes válidos são da conta de destino, em que o usuário escreve, a leitura fica coberta pelo `Access`. `tool-handlers-operation.ts` não precisou mudar para isto.
- Sem mudança de spec.
- Teste: `apps/server/test/statement-supersede.test.ts`, "a prévia do import_statement só troca provisórios ativos da conta…": editor só da caixa A, com o lote provisório de outra caixa, um lote não provisório da conta e a mistura (422), e o provisório válido com as contagens.
- Verificação: `pnpm verify:quick` (banco `moneyflow_it_s1`).
