---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
prioridade: alta
criada: 2026-11-21
commit:
---

# Regra aprendida da correção não casa nem com a descrição de onde nasceu

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** regra de classificação aprendida inútil (padrão normalizado × descrição crua)
- **Arquivos afetados:** `apps/server/src/services/reconciliation.ts:332-350`, `apps/server/src/services/reconciliation.ts:793`, `apps/server/src/services/statements.ts:441`, `apps/server/src/services/statements.ts:502-508`, `database/schema.sql:5179-5184` (`classification_rule_for`), `docs/009-extratos-e-conciliacao.md:18`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba e depois app (ou só app, na alternativa do passo 3)
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Ao lançar ou classificar uma linha do extrato, a caixa "Aprender regra" vem marcada e promete que "as próximas linhas parecidas já chegam classificadas". Na prática, a regra criada quase nunca pega a linha seguinte: basta a descrição ter acento, hífen, asterisco, `&`, um número de documento ou uma data no meio. No extrato do mês seguinte, a mesma "PIX RECEBIDO Cliente Ômega" chega sem classificação, e a lista de regras enche de regras com uso zero.

### Evidência e análise técnica
- `learnRule` grava o padrão `contains` com `rulePatternOf(line.description)` (`reconciliation.ts:345`), que é `normalizeDescription` (`reconciliation.ts:333-336`): minúsculas, **sem acentos, sem pontuação, sem números de 4+ dígitos, sem datas dd/mm e sem CNPJ** (`packages/shared/src/reconcile.ts:61-85`).
- A aplicação da regra compara esse padrão com a descrição **crua**: `ruleFor(tx, alvo, line.description, …)` na importação (`statements.ts:441`) e no "Aplicar regras" (`reconciliation.ts:793`), e o banco faz `strpos(lower(p_description), lower(btrim(r.pattern))) > 0` (`schema.sql:5182`; `exact` e `starts_with` também usam só `lower`).
- Resultado (script descartável com o `normalizeDescription` do shared e a mesma comparação do banco):

  | Descrição da linha | Padrão gravado | Casa com a própria linha? |
  |---|---|---|
  | `PIX RECEBIDO Cliente Ômega` (fixture `extrato-ofx2.ofx`) | `pix recebido cliente omega` | não |
  | `Rendimento poupança` (mesma fixture) | `rendimento poupanca` | não |
  | `PIX ENVIADO José & Filhos` (mesma fixture) | `pix enviado jose filhos` | não |
  | `PAG BOLETO 0001234 CIA ENERGIA` | `pag boleto cia energia` | não |
  | `COMPRA CARTAO - SUPERMERCADO X` | `compra cartao supermercado x` | não |
  | `INTERNET Provedor Fibra` | `internet provedor fibra` | sim |

- A spec diz que a regra aprendida é "descrição normalizada 'contém'" (`docs/009-extratos-e-conciliacao.md:18`): a intenção é comparar normalizado com normalizado, e o código compara normalizado com cru.

### Verificação (tentativa de refutação)
- Procurei outra normalização no caminho: `ruleFor` é o único chamador de `classification_rule_for` (`grep`), sempre com a descrição crua; a função do banco não normaliza (migrations `0014_statements.sql:435` e `0050_classification_rules_by_account.sql:283`). O defeito existe desde a F2b (`git log -S rulePatternOf` → `855e6bc`).
- Testes: `statements.test.ts:108-115`, `:299-301` e `:349-355` só conferem que a regra `correction` foi **criada** (origem, direção, entidade); nenhum importa de novo uma linha com a mesma descrição para ver a regra classificar. O `apply` da linha 365 dá `updated: 1` porque a `OFX2-0004` perde a regra manual arquivada, não por causa da aprendida (`rendimento poupanca`, que não casa com nada cru).
- A tela marca "Aprender regra" por padrão (`apps/web/src/components/reconciliation/LineModals.tsx:159`) e o lançar pela API também (`lineCreateInput.learnRule` default `true`, `packages/shared/src/schemas/operation.ts:324`).

### Impacto
Todo usuário que concilia por correção: a classificação automática por regra aprendida, uma das promessas da 009, não acontece para a maior parte das descrições reais de banco (quase todas têm número, data, hífen ou acento). Nada é gravado errado, mas o trabalho de classificar volta todo mês, e as regras inúteis se acumulam (com uso zero) e poluem a lista que os agentes leem para decidir cópias (spec 032).

## Como reproduzir
1. Importar `apps/server/test/fixtures/extrato-ofx2.ofx` numa conta; lançar a linha `OFX2-0002` ("PIX RECEBIDO Cliente Ômega") como avulso com entidade e categoria, com "Aprender regra".
2. Conferir em `GET /api/classification-rules?accountId=…` a regra `correction` com padrão `pix recebido cliente omega`.
3. Importar outro OFX na mesma conta com a mesma `NAME`/`MEMO` e outro `FITID`: a linha chega com `classificationSource = null`. "Aplicar regras" também não a classifica.

## Solução proposta
1. (dba) `classification_rule_for` ganha um parâmetro opcional `p_description_normalized text DEFAULT NULL`; `exact`, `starts_with` e `contains` casam com a descrição crua **ou** com a normalizada (o padrão normalizado só pelo `lower(btrim())`), sem mudar a ordem (prioridade, tipo, comprimento). `regex` continua só na crua. pgTAP: padrão normalizado casa com a descrição com acento/pontuação quando o normalizado é passado.
2. (app) `ruleFor` passa `normalizeDescription(description)` nos dois chamadores (`statements.ts:441`, `reconciliation.ts:793`).
3. Alternativa só de app, se o dba não quiser mexer na assinatura: em `ruleFor`, quando a chamada com a descrição crua não achar regra, chamar de novo com `normalizeDescription(description)`. Custa uma consulta a mais por linha sem regra (ver a tarefa de desempenho desta revisão) e dá prioridade às regras que casam com a crua.
4. Sem migração de dados: as regras `correction` já gravadas passam a valer; o usuário usa "Aplicar regras" para as linhas novas antigas.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/statements.ts
+++ b/apps/server/src/services/statements.ts
@@ export async function ruleFor(tx: Executor, target: RuleTarget, description: string, amountCents: number)
   const result = await tx.execute<{ id: string; entity_id: string | null; category_id: string | null }>(sql`
     SELECT r.id, r.entity_id, r.category_id FROM classification_rules r
-     WHERE r.id = classification_rule_for(${target.accountId}::uuid, ${target.cardCaixaId}::uuid, ${description}, ${amountCents}::bigint)`);
+     WHERE r.id = classification_rule_for(${target.accountId}::uuid, ${target.cardCaixaId}::uuid, ${description}, ${amountCents}::bigint,
+                                          ${normalizeDescription(description)})`);
```
**Suposição:** a assinatura nova da função (5º parâmetro) é a do passo 1; confira com o dba.

## Critérios de aceite
- [ ] A regra aprendida da linha "PIX RECEBIDO Cliente Ômega" classifica a mesma descrição na importação seguinte e no "Aplicar regras".
- [ ] Regras manuais com acento ("Farmácia") continuam casando com a descrição crua.
- [ ] A ordem de escolha entre regras (prioridade, tipo, comprimento) não muda.

## Testes recomendados
- `apps/server/test/statements.test.ts`, no caso "importa OFX, deduplica…": depois do `create` da `OFX2-0002`, importar um segundo OFX (outro mês, outro FITID) com a mesma descrição e esperar `classificationSource: 'rule'` com o id da regra `correction`; idem uma descrição com número de documento no meio.
- pgTAP do dba para o parâmetro novo de `classification_rule_for`.

## Limitações e suposições
Nada foi executado contra o banco; a comparação do banco foi reproduzida em JS (`toLowerCase().includes`), equivalente ao `strpos(lower(…))` para esses textos. O script descartável ficou em `<RASCUNHO>/scripts/rule.ts`.

## Análise (triagem)

## Resolução (executor)
