---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# Contrato encerrado sem renovar mantém as obrigações sem fim gerando ocorrências

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** fim da vigência sem renovação
- **Arquivos afetados:** `apps/server/src/services/contracts.ts:493-497`, `apps/server/src/services/contract-worker.ts:28-32`, `apps/server/src/services/series.ts:291`, `apps/server/src/services/series.ts:416-435`, `packages/shared/src/schemas/contracts.ts:63-64`, `docs/020-contratos.md:27`, `docs/034-contratos-sobre-series.md:42`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando um contrato chega ao fim sem renovação automática, ele aparece como "encerrado". Se uma obrigação dele não tinha data de fim, o que acontece com uma série solta ligada depois ou com uma obrigação cadastrada "sem fim", o worker continua criando títulos a pagar ou a receber todo mês. O calendário e a projeção mostram cobranças de um contrato que já acabou.

### Evidência e análise técnica
- No fim da vigência sem renovação, `syncLifecycle` só troca o status: `UPDATE contracts SET status = 'ended'` (`contracts.ts:494-496`). As séries ficam como estavam.
- O comentário do worker parte do pressuposto de que "as séries já terminam no fim da vigência" (`contract-worker.ts:30-31`). Isso nem sempre vale:
  - `insertObligation` aceita `endsOn: null` explícito, "sem fim" (`series.ts:291`; `schemas/contracts.ts:63-64`: "null = sem fim"), mesmo num contrato com fim;
  - `linkObligation`/`setSeriesContract` (`series.ts:416-435`) liga uma série solta sem fim, ou com fim depois da vigência, sem ajustar o `ends_on`;
  - `insertObligation` aceita um `endsOn` posterior ao fim do contrato.
- Já a rescisão encerra todas as séries do contrato, inclusive as sem fim (`planTermination`, `contracts.ts:847`; `terminateContract`, `contracts.ts:876-877`). Os dois caminhos de encerramento ficam incoerentes.

### Verificação (tentativa de refutação)
- A `docs/034:42` é explícita: "Encerrar (fim da vigência sem renovar): encerra as séries no fim."
- `renewableRules` (`contracts.ts:946`) ignora séries sem fim (`ends_on IS NOT NULL`), o que confirma que elas não acompanham a vigência em nenhum ponto.
- Nenhum teste cobre um contrato encerrado com obrigação sem fim. O caso de `contracts.test.ts:705-719` usa obrigações com o fim padrão.

### Impacto
Contratos com obrigação ligada depois (IPTU, condomínio) ou cadastrada sem fim. Depois do encerramento, o worker materializa ocorrências até 12 meses à frente, que aparecem como contas a pagar ou receber, entram nos avisos de vencimento e atraso e podem ser casadas no extrato como se o contrato estivesse vigente.

## Como reproduzir
1. Contrato com `endsOn` = ontem, `autoRenew: false` e uma obrigação com `endsOn: null` (ou ligue uma série solta sem fim por `POST /api/contracts/:id/obligations/link`).
2. Rodar `contractMaintenance`: o contrato fica `ended`.
3. `GET /api/series/:id`: `endsOn` continua nulo e o worker segue criando ocorrências.

## Solução proposta
- No ramo `ended` de `syncLifecycle`, para cada série do contrato com `ends_on` nulo ou depois de `contract.endsOn`, aplicar o "encerrar série" (`seriesEndPlanOf` + `applySeriesEnd`) no fim da vigência. As ocorrências com baixa depois do fim bloqueiam o `applySeriesEnd`. Nesse caso, terminar no vencimento da última com baixa, como faz a rescisão (`lastDue` em `planTermination`), em vez de falhar.
- Como alternativa ou complemento: ao criar ou ligar uma obrigação num contrato com fim, limitar o fim dela ao da vigência (ou pedir confirmação na tela).
- Revisar a frase de `contract-worker.ts:30-31` e da `docs/020:27`.

## Critérios de aceite
- [ ] Contrato encerrado pelo worker não deixa série dele com fim nulo ou posterior ao fim da vigência.
- [ ] As ocorrências abertas depois do fim ficam canceladas (sem apagar), e as com baixa ficam.

## Testes recomendados
`apps/server/test/contracts.test.ts`, no `describe` de renovação: contrato vencido sem renovação automática, com uma obrigação `endsOn: null` e uma série solta ligada. Depois do `contractMaintenance`, conferir o `ends_on` das duas séries e o status das ocorrências seguintes.

## Limitações e suposições
Nada foi executado. Supõe-se que a obrigação "sem fim" num contrato com fim não seja uma escolha consciente de manter a cobrança depois do contrato. Se for, a spec precisa dizer isso e a tela precisa avisar.

## Análise (triagem)

## Resolução (executor)
