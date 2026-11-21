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

# Leitura e conversão de documento desistem em 120 s, mas a execução continua e é paga

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** espera síncrona sem cancelamento
- **Arquivos afetados:** `apps/server/src/services/ai-flows.ts:49-58`, `apps/server/src/services/ai-flows.ts:85-88`, `apps/server/src/services/contract-documents.ts:358-361`, `apps/server/src/config.ts:132`, `apps/server/src/agents/events-hub.ts:123`, `apps/server/src/agents/flows.ts:17`
- **Depende de / relacionado a:** tarefa 074; tarefa 095
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Ao converter um contrato longo em markdown, a tela responde "a conversão falhou" depois de 2 minutos. O agente, porém, continua trabalhando por trás, termina, é cobrado, e o resultado é jogado fora. O usuário tenta de novo e paga outra vez.

### Evidência e análise técnica
- `waitRun` (`ai-flows.ts:49-58`) consulta a execução a cada 400 ms até `AI_DOCUMENT_TIMEOUT_MS` (120 s, `config.ts:132`) e devolve a execução como estiver.
- `readDocumentWithAi` (`ai-flows.ts:85-88`) e `runFlow` (`contract-documents.ts:358-361`) lançam 422 quando o status não é `completed`, inclusive quando ainda está `running`. Nenhum dos dois cancela a execução (`stopRun`).
- A conversa do fluxo é arquivada e fica fora da lista. Os fluxos síncronos não avisam no sino (`SYNC_FLOW_PURPOSES`, `flows.ts:17`; `events-hub.ts:123`). Quando a execução termina, ninguém fica sabendo, e o resultado não é usado.
- A conversão em markdown é o caso típico: até 16 mil tokens de saída, mais o raciocínio, a 50–100 tokens/s, levam de 3 a 5 minutos, acima dos 120 s.

### Verificação (tentativa de refutação)
- Não há outro ponto que cancele: a manutenção só expira `awaiting_confirmation`. Com tarefa 074, a execução abandonada pode até nunca terminar.
- Nenhum teste cobre o tempo esgotado do `waitRun`.

### Impacto
Custo dobrado a cada nova tentativa do usuário, e uma vaga do worker ocupada à toa. Afeta a leitura de boleto/nota (rara, porque é rápida) e sobretudo a leitura e a conversão de contratos.

## Como reproduzir
`AI_DOCUMENT_TIMEOUT_MS=2000` e o provedor falso com uma resposta lenta (`delayMs` 5000). `POST /api/contract-documents/:id/convert` responde 422 em cerca de 2 s. `ai_runs` mostra a execução `running` e depois `completed`, com `ai_usage` gravado e nenhum documento criado.

## Solução proposta
1. No tempo esgotado, cancelar a execução: `withTx(ctx, (tx) => stopRun(tx, runId, conversationId))` antes de lançar o 422, com a mensagem "demorou demais".
2. Para a conversão de contrato, que é longa por natureza: torná-la assíncrona. A rota enfileira e devolve o `runId`, o console acompanha pelo SSE (ou pelo sino), e o documento é gravado quando a execução termina, em `applyFlowResult`. Se preferir manter síncrona, um prazo próprio maior que o da leitura de boleto.

## Critérios de aceite
- [ ] Ao esgotar a espera, a execução fica `canceled` (ou com o parar pedido) e o provedor não é chamado de novo.
- [ ] A resposta 422 diz que o tempo esgotou, e não que o documento é ilegível.

## Testes recomendados
`apps/server/test/agents.test.ts` (leitura de documento) e `apps/server/test/contracts.test.ts` (conversão): o cenário de "Como reproduzir" com o worker drenando em paralelo, conferindo o status `canceled` da execução.

## Limitações e suposições
Nada foi executado. A estimativa de duração da conversão depende do modelo e do provedor.

## Análise (triagem)

## Resolução (executor)
