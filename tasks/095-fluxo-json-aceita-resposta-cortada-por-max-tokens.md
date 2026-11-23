---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: d0514fa
---

# Os fluxos de documento aceitam como completa a resposta cortada por `max_tokens`

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** resposta truncada tratada como sucesso
- **Arquivos afetados:** `apps/server/src/agents/runner.ts:206-211`, `apps/server/src/agents/runner.ts:288-321`, `apps/server/src/services/contract-documents.ts:436-457`, `apps/server/src/services/ai-flows.ts:86-91`, `apps/server/src/agents/flows.ts:105-117`, `apps/server/src/agents/llm/anthropic.ts:25,167`, `docs/011-agentes-de-ia.md:46`
- **Depende de / relacionado a:** tarefa 150
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
"Converter o PDF do contrato em markdown" num contrato longo grava um documento que termina no meio de uma cláusula, sem nenhum aviso. Na leitura de boleto ou de contrato, uma resposta cortada vira um formulário vazio, como se o documento fosse ilegível.

### Evidência e análise técnica
- Fluxo JSON (`purpose` em `FLOW_PURPOSES`) tem uma volta só (`runner.ts:206-207`). Depois da chamada, o laço sai em qualquer `stopReason` que não seja `tool_use` (`runner.ts:289-309`). Só `refusal` vira `failed`. `max_tokens` segue para `applyFlowResult` e `finish('completed')` (`runner.ts:312-321`).
- O teto é o `max_tokens` do agente dos fluxos: 16.000 por padrão (`anthropic.ts:25,167`; `docs/011:46`). Nos modelos atuais da Anthropic, o raciocínio adaptativo está sempre ligado e consome o mesmo teto. No OpenAI, `max_completion_tokens` inclui os tokens de raciocínio.
- `convertPdfToMarkdown` (`contract-documents.ts:436-457`) grava o texto como a versão 1 do documento markdown, com o autor agente, sem saber que foi cortado. Um contrato de 20 a 30 páginas em português passa facilmente de 16 mil tokens de saída.
- `document_reading`, `contract_reading`, `classify_lines` e `supersede_pairs`: o JSON cortado não fecha, e `extractJson` (`flows.ts:105-117`) devolve `null`. A leitura vira tudo nulo (`ai-flows.ts:91`), a classificação e os pares não gravam nada, e a execução sai `completed`.

### Verificação (tentativa de refutação)
- O `stopReason` não é gravado em `ai_messages` nem em `ai_runs`, então quem consome o fluxo (`runFlow`, `readDocumentWithAi`) não tem como saber do corte.
- O provedor falso (`e2e/fakes/fake-llm.ts:284`) só emite `tool_use` ou `end_turn`, e nenhum teste cobre `max_tokens`.
- `CONTRACT_MARKDOWN_MAX_BYTES` (`contract-documents.ts:450-451`) é outro corte, do lado do banco, e não detecta o corte do modelo.

### Impacto
- Documento de contrato incompleto gravado como fiel ("fiel ao texto original", diz o prompt em `flows.ts:72-75`). O usuário pode confiar nele.
- Leitura de documento e sugestões perdidas em silêncio, com o custo da chamada pago.

## Como reproduzir
1. No provedor falso, uma opção para responder `stop_reason: 'max_tokens'` com um texto parcial.
2. `POST /api/contract-documents/:id/convert` de um PDF de contrato: a versão 1 é criada com o texto parcial.
3. `POST /api/title-entry/document`, a leitura de documento: volta `200` com todos os campos nulos.

## Solução proposta
1. No runner, para fluxo JSON com `response.stopReason === 'max_tokens'`, encerrar `failed` com uma mensagem clara (`t.agents.errors.flowTruncated`: "a resposta passou do limite de tokens do agente dos fluxos; aumente max_tokens").
2. Para `contract_markdown`, opcionalmente continuar: chamar de novo com "continue exatamente de onde parou" até N vezes e concatenar, ou pedir a conversão por partes (páginas).
3. Gravar o `stopReason` no evento `message`, ou como coluna com o dba, para o chat também mostrar "resposta cortada".

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/agents/runner.ts
+++ b/apps/server/src/agents/runner.ts
@@
       const toolUses = content.filter((b) => b.type === 'tool_use');
+      if (purpose && response.stopReason === 'max_tokens') {
+        await finish(db, runId, token, 'failed', t.agents.errors.flowTruncated);
+        return;
+      }
       if (toolUses.length === 0 || response.stopReason !== 'tool_use') {
```

## Critérios de aceite
- [ ] Fluxo JSON com `max_tokens` termina `failed` com a mensagem nova. A conversão não cria documento, e a leitura responde 422 com o motivo.
- [ ] O caminho normal (`end_turn`) não muda.

## Testes recomendados
- Em `e2e/fakes/fake-llm.ts`, uma opção `stopReason` na resposta da fila.
- Em `apps/server/test/contracts.test.ts`, "conversão cortada por max_tokens não grava o markdown".
- Em `apps/server/test/agents.test.ts`, "leitura de documento cortada devolve 422".

## Limitações e suposições
Nada foi executado. O tamanho a partir do qual o corte acontece depende do modelo, do esforço de raciocínio e do `max_tokens` do agente escolhido para os fluxos.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: o fluxo JSON tem uma volta e saía com `completed` em qualquer `stopReason` que não fosse `tool_use`/`refusal`; `convertPdfToMarkdown` gravava o texto cortado e a leitura virava campos nulos.

## Resolução (executor)

- `apps/server/src/agents/runner.ts`: fluxo JSON com `stopReason === 'max_tokens'` termina `failed` com `t.agents.errors.flowTruncated` (o uso da chamada fica gravado). A leitura de documento e a leitura/conversão de contrato já respondem 422 com o erro da execução, e a conversão não grava documento.
- `e2e/fakes/fake-llm.ts`: opção `stopReason` na resposta enfileirada (no OpenAI vira `finish_reason: length`).
- Decisão: sem continuação automática da conversão nem o `stopReason` gravado no chat (opcionais); a mensagem manda aumentar o `max_tokens` do agente dos fluxos.
- Specs: `docs/011` (leitura de documento) e `docs/020` (conversão).
- Teste: `agents.test.ts` "resposta cortada por max_tokens: a leitura responde 422 com o motivo e a conversão não grava o markdown" (e o caminho normal segue gravando a versão 1).
- Verificação: `pnpm verify:quick` (rápida), com `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_s2`.
