---
status: aberta
tipo: melhoria
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
---

# O histórico da sessão nunca entra no cache do prompt da Anthropic

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** desempenho
- **Subcategoria:** custo de tokens no laço de tools
- **Arquivos afetados:** `apps/server/src/agents/llm/anthropic.ts:7-12`, `apps/server/src/agents/llm/anthropic.ts:42-119`, `apps/server/src/agents/llm/anthropic.ts:156-165`, `apps/server/src/agents/prompt.ts:109-117`, `apps/server/src/agents/runner.ts:206-211`, `apps/server/src/agents/runner.ts:249-273`, `packages/shared/src/i18n/areas/agents.ts:188-193`, `docs/022-prompts-e-instrucoes.md:14-23`
- **Depende de / relacionado a:** tarefa 098
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
A cada passo do agente, o histórico inteiro da conversa vai ao provedor pelo preço cheio, mesmo sem ter mudado desde o passo anterior. Numa conciliação de lote, com dezenas de passos, a conta da IA fica várias vezes maior do que precisaria.

### Evidência e análise técnica
- O adaptador usa 3 dos 4 pontos de cache da API: a última tool, o fim da parte estável e o fim da parte por usuário (`anthropic.ts:156-165`). `toParams` (`anthropic.ts:42-119`) não põe `cache_control` em nenhuma mensagem.
- A ordem do prefixo é tools → system → messages. O cache cobre só tools e sistema. Tudo depois do 2º ponto (a parte volátil e o histórico) é cobrado como entrada sem cache em todas as chamadas.
- O laço chama o modelo até `max_tool_iterations` vezes (20 por padrão, no mínimo 60 na conciliação, `runner.ts:206-211`). A cada volta reenvia o histórico inteiro, que só cresce: os resultados de tool vão até 60 mil caracteres cada, e os PDFs e as imagens vão em base64 na visão direta. O custo de entrada sem cache cresce com o quadrado do número de voltas.
- A parte volátil é estável dentro de uma execução: a data do dia e a tela, carregadas uma vez em `loadContext`. Na receita, ela ainda leva a lista completa dos UUIDs das linhas do escopo (`prompt.ts:116`, `agents.ts:191`). Num lote de 1.000 linhas, isso são uns 36 mil caracteres pagos sem cache a cada volta.
- O padrão recomendado pela Anthropic para conversas e laços de agente é um ponto de cache no último bloco da última mensagem. Cada chamada lê o prefixo gravado pela anterior, a busca retroativa é de até 20 posições e uma volta típica acrescenta 2 a 4. Sobra exatamente o 4º ponto livre.

### Verificação (tentativa de refutação)
- `docs/022:14-23` define só os pontos 1 e 2 e não decide contra o cache do histórico. A lacuna é de omissão, não de desenho.
- `agent-prompts.test.ts:151-154,232` só confere os blocos de sistema e a última tool. Um ponto na última mensagem não quebra esses testes.
- O SDK instalado (`@anthropic-ai/sdk` 0.133.0) aceita `cache_control` nos blocos `text`, `image`, `document` e `tool_result` (`messages.d.ts:4165`).
- O provedor compatível com o cache desligado (`credentials.promptCache === false`) continua sem marca nenhuma, pela mesma condição `cacheOn`.
- No OpenAI o cache é automático, e nada muda.

### Impacto
Estimativa, não medida: numa conciliação de 60 voltas em que o histórico cresce uns 3 mil tokens por volta, a soma da entrada sem cache passa de 5 milhões de tokens por execução. Com o ponto no histórico, quase tudo viraria leitura de cache (10% do preço de entrada) mais a escrita do incremento (125%). A economia fica perto de uma ordem de grandeza na entrada, e cai também a latência até o primeiro token. Vale para o chat com várias voltas de tool, as tarefas agendadas e as receitas.

## Como reproduzir
1. Com um agente Anthropic e `log_bodies` ligado, peça algo que use 5 ou mais voltas de tool (por exemplo, conciliar um lote com o provedor falso respondendo `tool_use`).
2. Em Requisições, confira `cache_read_tokens` de cada chamada: fica parado no tamanho de tools mais sistema, e `input_tokens` cresce a cada volta.

## Solução proposta
1. Em `toParams`, depois de montar `out`, pôr `cache_control: { type: 'ephemeral' }` no último bloco elegível da última mensagem (`text`, `tool_result`, `document` ou `image`; o `thinking` não aceita), só quando `cacheOn`.
2. Garantir no máximo 4 marcas. Se um dia houver mais pontos no sistema, o da última tool pode sair, porque o do fim da parte estável já cobre tools e sistema juntos.
3. Opcional: na receita, trocar a lista inteira de UUIDs da parte volátil por um resumo (quantas linhas e o critério), já que o escopo é garantido no servidor (`assertRecipeScope`).
4. Registrar a decisão na `docs/022` (o "ponto 3" no fim do histórico).

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/agents/llm/anthropic.ts
+++ b/apps/server/src/agents/llm/anthropic.ts
@@ async function toParams(request: LlmRequest): Promise<Anthropic.MessageParam[]> {
-  return out;
+  return out;
+}
+
+/** Ponto de cache 3 (histórico): o último bloco elegível da última mensagem. */
+function markHistoryCache(messages: Anthropic.MessageParam[]) {
+  const last = messages.at(-1);
+  if (!last || !Array.isArray(last.content)) return;
+  for (let i = last.content.length - 1; i >= 0; i -= 1) {
+    const block = last.content[i] as { type: string; cache_control?: unknown };
+    if (['text', 'tool_result', 'document', 'image'].includes(block.type)) {
+      block.cache_control = { type: 'ephemeral' };
+      return;
+    }
+  }
 }
@@
-        messages: await toParams(request),
+        messages: await toParams(request).then((m) => (cacheOn ? (markHistoryCache(m), m) : m)),
```

## Critérios de aceite
- [ ] Com o cache ligado, a requisição leva `cache_control` no último bloco da última mensagem e no máximo 4 marcas no total.
- [ ] Com o cache desligado no provedor, nenhuma marca (o teste de `capabilities.test.ts:360-368` continua passando).
- [ ] Numa execução de várias voltas com a API real, `cache_read_tokens` cresce a cada volta.

## Testes recomendados
`apps/server/test/agent-prompts.test.ts`: numa conversa com duas voltas de tool pelo provedor falso, conferir no corpo da 2ª chamada a marca no último `tool_result` e a contagem total de `cache_control` igual a 4. Em `capabilities.test.ts`, o caso do cache desligado continua sem nenhuma marca.

## Limitações e suposições
Nada foi executado. Os números do Impacto são estimativas com premissas declaradas. O comportamento do cache (ordem do prefixo, 4 pontos, busca retroativa de 20 posições) foi conferido na documentação da Claude API, não medido. O ganho depende de as chamadas da mesma execução caírem dentro do TTL de 5 minutos, o que é o caso normal no laço.

## Análise (triagem)

## Resolução (executor)
