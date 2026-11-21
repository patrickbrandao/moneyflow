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

# Rescisão com data em mês fechado falha inteira (última ocorrência proporcional e multa)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** fechamento de mês na rescisão
- **Arquivos afetados:** `apps/server/src/services/contracts.ts:813-846`, `apps/server/src/services/contracts.ts:871-875`, `apps/server/src/services/contracts.ts:893-911`, `database/schema.sql:9765-9785`, `apps/web/src/components/contracts/ContractActionModals.tsx:325-336`, `docs/020-contratos.md:28,77`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Rescindir um contrato com data num mês já fechado, depois da conciliação, dá erro de "mês fechado" e nada é gravado. A tela já preenche o valor proporcional da última parcela, e a multa entra sempre com a competência na data da rescisão. Sem reabrir o mês não há como concluir.

### Evidência e análise técnica
- `planTermination` trata o mês fechado só nas ocorrências DEPOIS da data (`blockedClosed`, `contracts.ts:830-835`). A "última" ocorrência, a que cobre a data, entra em `preview.last` sem olhar `closed` (`contracts.ts:837-845`).
- A tela preenche `lastAmounts` com o proporcional de toda "última" sem baixa (`ContractActionModals.tsx:328`, enviado em 334-336). `terminateContract` aplica `patchOccurrence(... { amountCents })` nesse título e no espelho (`contracts.ts:871-875`).
- A multa nasce com `competenceDate: input.terminatedOn` (`contracts.ts:901`), sem escolha.
- `titles_period_lock` (`schema.sql:9765-9785`) recusa a mudança de `amount_cents` e o INSERT num mês fechado (23514 `period_closings_locked_check`). A transação inteira volta.

### Verificação (tentativa de refutação)
- `closedMonths` já é consultado em `planTermination` (`contracts.ts:813-817`), inclusive para as caixas do espelho, mas só para as canceladas.
- A spec define o tratamento do mês fechado só para as canceladas ("as com baixa ou em mês fechado ficam (a prévia avisa)", `docs/020:28`). Para a última ocorrência e a multa, nada.
- Não há teste de rescisão com mês fechado.

### Impacto
Rescisões registradas depois do fato, quando o mês da data já foi fechado na caixa do contrato, na da série ou na do espelho. O usuário recebe um erro genérico de mês fechado e precisa descobrir que deve apagar o proporcional e tirar a multa, ou então reabrir o mês.

## Como reproduzir
1. Contrato mensal vigente, com o mês de janeiro fechado na caixa da obrigação.
2. `POST /api/contracts/:id/terminate?dryRun=1` com `terminatedOn` em 15/01: a prévia sugere o proporcional da ocorrência de janeiro.
3. Enviar sem `dryRun`, com esse `lastAmounts` ou com `penalty`: 422 de mês fechado, nada gravado.

## Solução proposta
- Na prévia, marcar a "última" em mês fechado (no lado original ou no espelho) como não editável (`closed: true`, como `settled`). Na tela, não preencher o proporcional nesse caso. No servidor, ignorar o `lastAmounts` dela, como já se faz com a liquidada.
- Para a multa: aceitar `penalty.competenceDate` opcional (padrão a data da rescisão) e, se o mês dela estiver fechado, avisar na prévia (ou usar o primeiro mês aberto).

## Critérios de aceite
- [ ] Rescisão com data em mês fechado conclui: canceladas e fim das séries aplicados, a última ocorrência sem mudança e a prévia avisando.
- [ ] A multa com competência num mês fechado é recusada na prévia, com mensagem clara, ou vai para uma competência aberta.

## Testes recomendados
`apps/server/test/contracts.test.ts`, no caso de rescisão: fechar o mês da data (`period_closings`) e conferir a prévia (`last[].closed`) e a rescisão concluída sem o ajuste.

## Limitações e suposições
Nada foi executado. Supõe-se que a tela mande o `lastAmounts` preenchido por padrão, como mostra `ContractActionModals.tsx:328`.

## Análise (triagem)

## Resolução (executor)
