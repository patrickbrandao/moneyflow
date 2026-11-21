---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Gaveta do título mostra a NF-e emitida à noite com a data do dia seguinte

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** fuso (`America/Sao_Paulo`) em data de exibição
- **Arquivos afetados:** `apps/web/src/components/entry/TitleEntryInfo.tsx:95`, `apps/server/src/services/title-entry.ts:206-211`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Uma nota fiscal emitida depois das 21h aparece na gaveta do título com a data de emissão do dia seguinte. A de 31/10 às 22h aparece como 01/11, em outro mês.

### Evidência e análise técnica
- `getNfe` devolve `issuedAt: new Date(detail.issuedAt).toISOString()` (`title-entry.ts:209`). `nfe_documents.issued_at` é `timestamptz`, então o valor sai em UTC: a emissão `2026-10-31T22:30:00-03:00` vira `"2026-11-01T01:30:00.000Z"`.
- `NfeInfo` mostra `formatDate(nfe.issuedAt.slice(0, 10))` (`TitleEntryInfo.tsx:95`): corta a data UTC e exibe 01/11/2026.
- Na importação o problema não aparece: `EntrySources` usa o `dhEmi` cru do XML, com o fuso do emitente (`EntrySources.tsx:311,365`). A mesma NF-e mostra uma data no formulário e outra na gaveta depois de salva.

### Verificação (tentativa de refutação)
- `formatDate` (`packages/shared/src/dates.ts:75-79`) só reordena `YYYY-MM-DD` e não converte fuso. Quem converte é `formatDateTime`.
- O título não é afetado: `competenceDate` foi gravada a partir do XML cru, na importação. O erro fica só na exibição.

### Impacto
Informação errada na ficha. Em virada de mês, confunde a conferência da competência contra a nota.

## Como reproduzir
Importe uma NF-e de teste com `dhEmi` = `2026-10-31T22:30:00-03:00` (fixture de `apps/server/test/fixtures`, editando a hora), salve o título e abra a gaveta: "Emissão 01/11/2026".

## Solução proposta
Exibir o instante no fuso de São Paulo: `formatDateTime(nfe.issuedAt)`, ou a data local por um auxiliar do shared (`todayIso(new Date(nfe.issuedAt))` já faz a data em SP). Alternativa no servidor: devolver também `issuedOn` (data local) no `NfeDetail`.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/web/src/components/entry/TitleEntryInfo.tsx
+++ b/apps/web/src/components/entry/TitleEntryInfo.tsx
@@
-            <dd className="mono">{formatDate(nfe.issuedAt.slice(0, 10))}</dd>
+            <dd className="mono">{formatDate(todayIso(new Date(nfe.issuedAt)))}</dd>
```

## Critérios de aceite
- [ ] A NF-e emitida às 22h30 de 31/10 (−03:00) aparece como 31/10/2026 na gaveta.

## Testes recomendados
`packages/shared/test/dates.test.ts`: `todayIso(new Date('2026-11-01T01:30:00Z'))` devolve `2026-10-31` (garante o auxiliar). e2e da NF-e (`titles` com o fixture alterado) conferindo a data na gaveta.

## Limitações e suposições
Nada foi executado. Supus que o pg devolve `issued_at` como `Date`, que vira UTC no `toISOString`, como mostra o código.

## Análise (triagem)

## Resolução (executor)
