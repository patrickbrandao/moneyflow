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

# Ajustes de reconhecimento da série têm dois editores e dois resumos que se comportam diferente

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** duplicação com validação divergente (multa "2%" descartada sem aviso)
- **Arquivos afetados:** `apps/web/src/components/contracts/ObligationFormModal.tsx:46-98,101-175,481,726`, `apps/web/src/components/titles/SeriesTermsFields.tsx:15-65,67-141`, `apps/web/src/components/contracts/ContractActionModals.tsx:65-69`, `apps/web/src/pages/ContractPage.tsx:430-432`, `apps/web/src/components/titles/TitleDrawer.tsx:36`
- **Depende de / relacionado a:** tarefa 182
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Os mesmos campos (janela da conciliação, multa, juros, desconto, tolerância) aparecem no contrato e no título, mas são duas implementações. No contrato, digitar "2%" na multa grava "sem multa" sem avisar; no título o campo nem aceita "%". E o resumo dos ajustes sai escrito de um jeito na tela do contrato e de outro na gaveta do título.

### Evidência e análise técnica
- Contratos: `TermsDraft`/`termsDraftOf`/`termsBody`/`termsText`/`TermsFields` (`ObligationFormModal.tsx:46-175`), usados no cadastro da obrigação (`:481`) e no `SeriesEditModal` (`:726`, também aberto pela gaveta do título).
- Títulos: `SeriesTermsDraft`/`termsDraft`/`termsFromDraft`/`termsSummary`/`SeriesTermsFields` (`SeriesTermsFields.tsx:15-141`), usados no `TitleFormModal` e no resumo da gaveta (`TitleDrawer.tsx:36`).
- Diferenças:
  - percentuais: `TermsFields` usa `<input inputMode="decimal">` e `pctOf` (`:56-60`): `Number("2%")` é `NaN` → `null`, a multa some sem erro. `SeriesTermsFields` usa `type="number"` com `min`/`max` do schema (20/10/50) e `percentOf` (`:35-39`);
  - janela: `SeriesTermsFields` limita a 0–45 no `onChange` (`:92`); `TermsFields` manda o que foi digitado (`:127`) e 60 volta como erro de validação genérico do Zod (`packages/shared/src/schemas/contracts.ts:33`);
  - resumo: `termsText` (`ObligationFormModal.tsx:81-90`, usado em `ContractPage.tsx:430-432`) escreve "Multa por atraso (%): 2 · janela 15 d" e, sem ajustes, "Valor exato; janela de 15 dia(s)"; `termsSummary` (`SeriesTermsFields.tsx:54-65`) escreve "multa 2% · janela 15 d" e "Sem ajustes: valor exato no mês do vencimento ou na janela.". A mesma série aparece com textos diferentes nas duas telas.
- Um terceiro `pctOf` em `ContractActionModals.tsx:65-69` (reajuste do aditivo), com o mesmo problema do "%".

### Verificação (tentativa de refutação)
- O servidor valida faixa (`percent(20)` etc. e a CHECK `recurrence_rules_late_fee_percent_check` em `database/schema.sql:15337`) e normaliza 0 → null; não tem como saber que "2%" era 2. O descarte acontece no cliente.
- A spec 034 define um conjunto único de ajustes da série; nada pede editores diferentes por tela.

### Impacto
Multa/juros/desconto perdidos sem aviso ao cadastrar a obrigação (a conciliação deixa de reconhecer o pagamento com encargos); mensagens de erro genéricas na janela; resumos inconsistentes. Manutenção em dobro a cada ajuste novo.

## Como reproduzir
1. Novo contrato → obrigação → Ajustes → Multa por atraso: `2%`; salvar.
2. Abrir a obrigação: sem multa. No título da mesma série o campo não aceita `%`.

## Solução proposta
1. Ficar com um só módulo (ex.: `components/series/SeriesTermsFields.tsx`): o `type="number"` com `min`/`max`/`step` e o `clamp` da janela do `SeriesTermsFields`; um só `termsSummary`.
2. Apagar `TermsDraft`, `termsDraftOf`, `termsBody`, `termsText` e `TermsFields` do `ObligationFormModal` e usar o módulo único no cadastro da obrigação, no `SeriesEditModal` e no `ContractPage`.
3. `pctOf` do aditivo: aceitar "2%"/"2,5" (remover `%` e espaços) ou usar `type="number"`, e mostrar erro quando não for número.

## Critérios de aceite
- [ ] Um único editor e um único resumo dos ajustes, usados no contrato, na série e no título.
- [ ] Valor de percentual inválido mostra erro em vez de virar "sem".

## Testes recomendados
`e2e/tests/contratos.spec.ts`: criar a obrigação com multa e conferir o resumo igual na guia Obrigações e na gaveta do título. Se o resumo for para o `packages/shared`, teste unitário em `packages/shared/test/contracts.test.ts` para o texto do resumo.

## Limitações e suposições
Nada foi executado.

## Análise (triagem)

## Resolução (executor)
