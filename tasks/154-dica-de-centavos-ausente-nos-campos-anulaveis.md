---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 5d66b57
---

# Campos de centavos anuláveis vão ao modelo sem a dica "centavos" (aditivo, multa, limite do cartão)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** JSON Schema das tools (unidade do dinheiro)
- **Arquivos afetados:** `packages/shared/src/agents/json-schema.ts:33-37`, `packages/shared/test/agents.test.ts:254-263`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O sistema guarda dinheiro em centavos e avisa o modelo disso em cada campo de valor. Em alguns campos opcionais o aviso não sai, e o modelo pode mandar "1500" querendo dizer R$ 1.500,00 quando o sistema entende R$ 15,00. O caso mais sensível é o novo valor de um aditivo de contrato.

### Evidência e análise técnica
`polish` (`json-schema.ts:33-37`) completa a descrição de `*Cents` só quando `types.includes('integer')`, com `types` vindo de `out.type`. Um campo `nullish()`/`nullable()` vira `anyOf: [{ type: 'integer' }, { type: 'null' }]`, sem `type` no nível do campo, e fica sem a dica. A regra das datas, logo abaixo, já trata o `anyOf` (`types.includes('string') || out.anyOf`); a dos centavos não.

Rodando o registro inteiro por `zodToToolSchema` (script descartável com `tsx` sobre `AGENT_TOOLS`), os campos `*Cents` sem "centavos" na descrição são:
- `add_contract_amendment.amendment.amountCents` (o valor novo das obrigações);
- `create_contract.terminationPenaltyCents` e `update_contract.changes.terminationPenaltyCents`;
- `create_caixa.creditLimitCents` (limite do cartão).

Também saem sem formato `set_statement_import_balance.bankBalanceOn` (tem descrição própria, sem "AAAA-MM-DD") e `reminder.endsOn` de `create_note`/`update_note`.

### Verificação (tentativa de refutação)
- O teste (`agents.test.ts:254-263`) só confere `create_title.amountCents`, que não é anulável.
- O nome termina em `Cents`, o que ajuda, mas a regra do projeto é dizer a unidade, e a descrição da tool do aditivo fala só em "novo valor (amountCents)".
- A prévia do aditivo mostra o valor formatado em R$, então o erro de unidade aparece no cartão em `ask`; em `allow` (ou sem kit, ou no `/mcp`), não há cartão.

### Impacto
Valor 100 vezes menor gravado nas ocorrências futuras de um contrato, no limite do cartão ou na multa, quando o modelo erra a unidade e ninguém aprova antes.

## Como reproduzir
`node`/`tsx`: `toolJsonSchema(agentTool('add_contract_amendment')).properties.amendment.properties.amountCents` → `{ anyOf: [...] }` sem `description`.

## Solução proposta
Na regra dos centavos, considerar os tipos de `anyOf` (como a das datas) e pôr a descrição no nível do campo; idem para as datas com descrição própria (acrescentar o formato quando a descrição não o tem).

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/packages/shared/src/agents/json-schema.ts
+++ b/packages/shared/src/agents/json-schema.ts
@@
   if (key && !out.description) {
-    const types = Array.isArray(out.type) ? out.type : [out.type];
+    const types = [
+      ...(Array.isArray(out.type) ? out.type : [out.type]),
+      ...((out.anyOf as JsonSchema[] | undefined) ?? []).map((alt) => alt.type),
+    ];
     if (/Cents$/.test(key) && types.includes('integer')) out.description = CENTS_HINT;
```

## Critérios de aceite
- [ ] Todo campo `*Cents` do registro tem "centavos" na descrição do JSON Schema.
- [ ] Todo campo de data (`*Date`, `*On`, `from`, `to`) tem "AAAA-MM-DD".

## Testes recomendados
`packages/shared/test/agents.test.ts`: percorrer o JSON Schema de todas as tools e exigir a dica em todo `*Cents` e em toda data (o mesmo laço do script desta revisão).

## Limitações e suposições
A lista vem do script desta revisão, com o registro do commit `7f0984f`.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado com um percurso do JSON Schema de todo o registro: `add_contract_amendment.amendment.amountCents`, `terminationPenaltyCents` (criar e editar contrato) e `create_caixa.creditLimitCents` sem "centavos"; `bankBalanceOn` e `reminder.endsOn` sem o formato da data.

## Resolução (executor)

- `packages/shared/src/agents/json-schema.ts`: a regra olha os tipos das alternativas do `anyOf` (campo anulável) e completa também a descrição própria que não diz a unidade ou o formato (o mês `AAAA-MM` já diz o seu).
- Teste: `packages/shared/test/agents.test.ts` percorre o JSON Schema de todas as tools e exige "centavos" em todo `*Cents` e "AAAA-MM" em toda data (`*Date`, `*On`, `from`, `to`).
- Verificação: `pnpm verify:quick` (Biome, typecheck, os testes do shared relacionados e, passados depois de `--`, os de integração `agents`, `agent-tools`, `agent-tools-admin`, `titles`, `cards`, `contracts`, `statements`, `vision`, `reconcile-recipes`, `statement-supersede`, `autonomous` e `budgets` no Postgres local). Não rodei `verify:full` nem o e2e.
