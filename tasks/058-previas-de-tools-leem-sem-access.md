---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit:
---

# Prévias das tools leem movimento e nomes de conta por id sem passar pelo `Access`

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** segurança
- **Subcategoria:** IDOR (vazamento de informação na prévia)
- **Arquivos afetados:** `apps/server/src/agents/tool-handlers.ts:176-197,694-704`, `apps/server/src/agents/tool-handlers-recipes.ts:25-38,52-62,86-93`
- **Depende de / relacionado a:** nenhum
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
O cartão de aprovação de uma tool mostra "casar com: movimento de tal data, descrição e valor" sem conferir se o usuário pode ver aquele movimento. Nas receitas, mostra o nome de contas e cartões de outras caixas.

### Evidência e análise técnica
- `matchTargetLabel` (`tool-handlers.ts:189-194`): `SELECT description, amount_cents, occurred_on FROM movements WHERE id = ${ref.movementId}`, sem conferir a caixa. Em `match_statement_line` (`:694-704`), só a linha passa por `lineCaixa`/`assertWrite`.
- `targetNames` (`tool-handlers-recipes.ts:32-38`) lê nomes de `financial_accounts`/`caixas` por id sem `canRead`, enquanto o `ownerName` ao lado (`:25-30`) confere.

### Verificação (tentativa de refutação)
- Refutado para o título: o `settlementPreview` roda antes do rótulo e exige o título na caixa da linha mais `assertWrite` (`:140-146`).
- O `run` provavelmente falha depois, no serviço, mas a prévia já foi gravada em `ai_tool_confirmations.preview` e mostrada no cartão. A prévia só existe com a tool em `ask` e é vista pelo dono da conversa e pelo admin; o modelo não a vê.
- É preciso conhecer o UUID do alvo, que não é enumerável. A regra do AGENTS.md é "toda permissão passa por Access".

### Impacto
Vazamento pontual de data, descrição e valor de um movimento, ou do nome de uma conta, de uma caixa sem leitura, para quem já conhece o id.

## Como reproduzir
Usuário editor só da caixa A, com `match_statement_line` em `ask`: pedir ao agente para casar uma linha de A com o `movementId` de um movimento da caixa B. O cartão mostra os dados do movimento de B.

## Solução proposta
- Juntar a conta no `SELECT` e só rotular se `ctx.access.canRead(caixa_id)`; senão `notFound()` (a prévia vira erro).
- Filtrar `targetNames` pelo `canRead`.
- Sem mudança de spec.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/agents/tool-handlers.ts
+++ b/apps/server/src/agents/tool-handlers.ts
@@
   if (ref.movementId) {
-    const r = await ctx.db.execute<{ description: string | null; amount_cents: number; occurred_on: string }>(
-      sql`SELECT description, amount_cents, occurred_on FROM movements WHERE id = ${ref.movementId}`,
-    );
+    const r = await ctx.db.execute<{ description: string | null; amount_cents: number; occurred_on: string; caixa_id: string }>(
+      sql`SELECT m.description, m.amount_cents, m.occurred_on, a.caixa_id
+            FROM movements m JOIN financial_accounts a ON a.id = m.financial_account_id WHERE m.id = ${ref.movementId}`,
+    );
     const row = r.rows[0];
+    if (row && !ctx.access.canRead(row.caixa_id)) throw notFound();
```
**Suposição:** a coluna `movements.financial_account_id` não foi conferida no schema. Confirme o nome real antes de aplicar.

## Critérios de aceite
- [ ] A prévia com `movementId` de uma caixa sem leitura não mostra descrição nem valor.
- [ ] `targetNames` não devolve nomes de contas ou caixas sem leitura.

## Testes recomendados
`test/agent-tools.test.ts`: prévia de `match_statement_line` com movimento de outra caixa, com o usuário editor só da caixa da linha. Idem `create_reconcile_recipe` com `accountIds` de uma caixa sem leitura. Nada disso foi executado nesta auditoria.

## Limitações e suposições
Ver a suposição sobre a coluna no diff.

## Análise (triagem)

Sem triage (auditoria verificada; a sessão principal designou o app). Confirmado: `matchTargetLabel` (`agents/tool-handlers.ts`) lia o movimento (e o título) por id sem `Access`, e `targetNames` (`agents/tool-handlers-recipes.ts`) lia nomes de contas e cartões sem `canRead`. A coluna real é `movements.financial_account_id` (conferida em `database/schema.sql`). Executor: app.

## Resolução (executor)

- `matchTargetLabel` junta a conta (`movements.financial_account_id` → `financial_accounts.caixa_id`) e o `caixa_id` do título, e só descreve o alvo se `ctx.access.canRead`; senão o rótulo é só o id (`Movimento <id>`/`Título <id>`), sem data, descrição nem valor. Optei pelo rótulo opaco em vez de `notFound()` porque a mesma função serve a prévia do `unmatch_statement_line`; o `run` continua recusando pelo serviço.
- `targetNames` filtra pelo `canRead` da caixa da conta (ou do próprio cartão) e mostra o id para as demais, na ordem pedida.
- Teste: `test/agent-tools.test.ts` ("prévias pelo Access (tarefa 058)") — editor só da caixa A: prévia de `match_statement_line` com o movimento da caixa B sem descrição nem valor (o da própria caixa aparece) e `create_reconcile_recipe` com a conta da caixa B sem o nome.
- Sem mudança de spec.
