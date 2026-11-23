---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit:
---

# Diff de texto guarda o vetor inteiro a cada passo: documento grande trava o worker e o navegador

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** desempenho
- **Subcategoria:** memória O(D·(N+M)) no Myers
- **Arquivos afetados:** `packages/shared/src/text-diff.ts:8-29`, `apps/server/src/agents/tool-handlers-operation.ts:478-484`, `apps/web/src/components/contracts/DocumentView.tsx:292`, `apps/web/src/components/admin-ai/AgentPrompt.tsx:159`, `packages/shared/src/contracts.ts:29`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Comparar duas versões muito diferentes de um contrato em markdown (por exemplo, depois de a IA reformatar o texto) faz a tela congelar por segundos ou fechar a aba. Quando é o agente que salva a nova versão, a mesma conta roda no servidor e para o worker de agentes enquanto calcula, podendo derrubá-lo por falta de memória.

### Evidência e análise técnica
`diffLines` implementa o Myers guardando, a cada valor de `d`, uma cópia do vetor inteiro de tamanho `2·(N+M)+3`:

```ts
const v = new Int32Array(2 * max + 3);
outer: for (let d = 0; d <= max; d += 1) {
  trace.push(v.slice());   // text-diff.ts:18
```

Memória e tempo ficam O(D·(N+M)), onde D é o número de linhas diferentes. Em versões quase todas diferentes, D ≈ N+M, ou seja, quadrático no tamanho do documento. O markdown de contrato aceita até 1 MiB (`CONTRACT_MARKDOWN_MAX_BYTES`, `contracts.ts:29`), algo como 10 mil linhas de texto corrido.

Medido nesta revisão com um script descartável, importando o fonte, no Node 26 desta máquina, para N linhas contra N linhas todas diferentes:

| N | tempo | memória de ArrayBuffers |
|---|---|---|
| 1.000 | 0,14 s | 32 MB |
| 2.000 | 1,0 s | 96 MB |
| 4.000 | 8,0 s | 384 MB |
| 8.000 | 33,6 s | 1,5 GB |

O resultado do diff está correto: 2.000 casos aleatórios conferidos contra uma LCS ingênua, sem divergência. O problema é só o custo.

Há três chamadores:
- **Servidor:** a prévia da tool `save_contract_markdown` (`tool-handlers-operation.ts:484`) faz `diffStats(diffLines(doc.content, i.content))` no worker, de forma síncrona, quando a tool está em `ask` (`runner.ts:456`). O laço de eventos do worker fica parado durante a conta.
- **Navegador:** a comparação de versões do documento (`DocumentView.tsx:292`) e do prompt do agente (`AgentPrompt.tsx:159`) roda num `useMemo`, na thread principal.

### Verificação (tentativa de refutação)
- Não há limite de linhas nem de tamanho antes do diff: só o teto de 1 MiB do conteúdo.
- O teste unitário (`packages/shared/test/contracts.test.ts:117-129`) usa textos de 4 linhas.
- O comentário do arquivo promete "O((N+M)·D)" de tempo, mas não fala da memória. A cópia de `v` a cada passo é o que a faz crescer junto.

### Impacto
Documentos de contrato longos (dezenas de páginas) reformatados pela IA ou reenviados: a aba congela ou fecha. No worker, alguns segundos de bloqueio já atrasam heartbeats e laços das outras execuções. Um markdown de ~1 MiB com linhas curtas pode passar de alguns GB e derrubar o processo. Qualquer usuário com escrita num contrato consegue disparar isso pelo agente ou pelo `/mcp`.

## Como reproduzir
1. Crie um documento markdown de contrato com 4.000 linhas (`linha antiga i`).
2. Peça ao agente, com `save_contract_markdown` em `ask` no kit, para salvar uma versão com 4.000 linhas diferentes (`linha nova i`). A prévia leva cerca de 8 s e ~400 MB no worker.
3. Na tela do contrato, compare as duas versões: a aba congela pelo mesmo tempo.

## Solução proposta
1. Tirar do Myers o prefixo e o sufixo comuns (é o caso típico de uma edição).
2. Guardar no `trace` só a faixa usada, `v.slice(offset - d, offset + d + 1)`, ajustando os índices na volta. Isso dá O(D²) em vez de O(D·(N+M)).
3. Pôr um teto de edições (`maxEdits`, por exemplo 3.000). Acima dele, devolver para o miolo "removidas todas as antigas e incluídas todas as novas" e marcar `truncated: true`. A tela mostra o aviso "documentos muito diferentes; diff resumido". A prévia continua com `+x / −y`, como limites superiores.
4. Alternativa mais completa: Myers em espaço linear (dividir e conquistar), mantendo o teto de tempo.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/packages/shared/src/text-diff.ts
+++ b/packages/shared/src/text-diff.ts
@@
-export function diffLines(before: string, after: string): DiffLine[] {
+export function diffLines(before: string, after: string, maxEdits = 3000): DiffLine[] {
   const a = before === '' ? [] : before.split(/\r?\n/);
   const b = after === '' ? [] : after.split(/\r?\n/);
+  // prefixo/sufixo comuns ficam fora do Myers; acima de maxEdits, o miolo vira del+add
+  ...
   outer: for (let d = 0; d <= max; d += 1) {
-    trace.push(v.slice());
+    if (d > maxEdits) return coarse(a, b, start, endA, endB); // del de a[start..endA) + add de b[start..endB)
+    trace.push(v.slice(offset - d, offset + d + 1));
```

## Critérios de aceite
- [ ] 8.000 × 8.000 linhas diferentes resolvem em menos de 1 s e com menos de 50 MB.
- [ ] Edições pequenas em documentos grandes continuam com o diff exato.
- [ ] A tela e a prévia da tool avisam quando o diff foi resumido.

## Testes recomendados
- `packages/shared/test/contracts.test.ts`: (a) 10.000 linhas com uma alterada no meio dá 1 add e 1 del; (b) 8.000 × 8.000 diferentes terminam abaixo de um limite de tempo, com `truncated` e as contagens; (c) a propriedade de reconstrução (o lado antigo e o novo saem do diff) com textos aleatórios.
- `apps/server/test/agent-tools.test.ts`: prévia de `save_contract_markdown` com dois markdowns de 5.000 linhas diferentes responde rápido.

## Limitações e suposições
Medições feitas num script descartável no Node 26 desta máquina (o navegador deve ficar na mesma ordem de grandeza). O impacto no worker (heartbeats, outras execuções) foi deduzido do código, sem execução.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: `diffLines` guardava a cada passo `d` uma cópia inteira do vetor (`2·(N+M)+3`), memória e tempo O(D·(N+M)), sem teto. Usado na prévia de `save_contract_markdown` (worker) e nas telas de versões do documento e do prompt.

## Resolução (executor)

- `packages/shared/src/text-diff.ts`, só o algoritmo, com a assinatura de `diffLines(antes, depois): DiffLine[]` e de `diffStats` mantidas (a tarefa 182 unificou os usos no web): o prefixo e o sufixo comuns ficam fora do Myers; as linhas viram números (`Map` de texto para id); o caminho guarda só a faixa usada a cada passo (`v.slice(offset − d, offset + d + 1)`), memória O(D²); acima de `DIFF_MAX_EDITS = 3000` linhas diferentes (ou com |N − M| acima disso), o miolo sai resumido (todas as antigas removidas e todas as novas incluídas), um diff ainda válido. `diffText(antes, depois, maxEdits?)` devolve `{ lines, truncated }`.
- `apps/server/src/agents/tool-handlers-operation.ts`: a prévia de `save_contract_markdown` usa `diffText` e, resumida, acrescenta o aviso `t.contracts.documents.diffTruncated` (as contagens viram limites superiores).
- Medido (máquina carregada): 8.000 × 8.000 linhas diferentes em ~0,3 s e ~36 MB de ArrayBuffers (antes, 33,6 s e 1,5 GB).
- Pendente fora desta frente: o aviso "diff resumido" nas telas de comparação (documento e prompt) depende do componente unificado da tarefa 182; o `diffText` e o texto `t.contracts.documents.diffTruncated` já estão no shared.
- Testes: `packages/shared/test/contracts.test.ts` (500 pares aleatórios reconstruindo os dois lados e com o tamanho mínimo pela LCS; 10.000 linhas com uma trocada dão 1 inclusão e 1 remoção; 8.000 × 8.000 diferentes abaixo de 1 s, resumido e válido, com prefixo e sufixo preservados; exato até o teto) e `apps/server/test/agent-tools.test.ts` (prévia de `save_contract_markdown` com 4.000 × 4.000 linhas diferentes: `+4000 / −4000` e o aviso).
- Verificação: `pnpm verify:quick` (banco `moneyflow_it_s1`).
