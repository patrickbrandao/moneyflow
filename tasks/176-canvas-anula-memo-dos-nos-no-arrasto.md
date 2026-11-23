---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 827ca7c
---

# Canvas de fluxo recria `data` de todos os nós e arestas a cada quadro do arrasto e anula o `memo` dos nós

- **Severidade:** baixa
- **Confiança:** provável
- **Categoria:** desempenho
- **Subcategoria:** re-render em cascata no React Flow
- **Arquivos afetados:** `apps/web/src/components/canvas/MoneyFlowCanvas.tsx:53-61,89-108,124-191`, `apps/web/src/components/canvas/nodes.tsx:9-11,125-130`, `apps/web/src/components/canvas/graph.ts:153-159,286-307`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Ao arrastar uma caixa ou entidade no canvas, o navegador redesenha todos os nós e todas as arestas a cada movimento do mouse, não só o que está sendo arrastado. Com muitos nós, por exemplo com os grupos expandidos, o arrasto fica travado.

### Evidência e análise técnica
- `nodes.tsx:9-11` diz: "`memo` é obrigatório (arrastar um nó não re-renderiza os outros)".
- No arrasto, `onNodesChange` atualiza o estado `nodes` a cada quadro (`MoneyFlowCanvas.tsx:89-108`). Isso recalcula, a cada quadro:
  - `highlightIds(data, nodes, edges, match)` (`:124`), que percorre todos os nós e arestas;
  - `selected` (`:132-144`) com `nodes.find`/`edges.find`;
  - `viewNodes` (`:161-169`), que cria **um objeto novo e um `data` novo para cada nó** (`data: { ...n.data, dim }`). Com o `data` sempre novo, o `memo` dos três tipos de nó (`nodes.tsx:126-129`) nunca evita o render;
  - `viewEdges` (`:170-191`), que monta um `Map` das posições e cria um objeto novo e um `data` novo para cada aresta (`EdgeLabelRenderer` inclusive).
- O custo por quadro é O(nós + arestas) em objetos e renders de componente. Com `GROUP_THRESHOLD = 12` (`graph.ts:33`) os grupos fecham, mas cada "Expandir" (`MoneyFlowCanvas.tsx:204-207`) volta a soltar as folhas, e o canvas com várias caixas e cartões cresce rápido.
- Detalhe do mesmo arquivo: os `buckets` de `buildGraph` são remontados com cópia do array a cada entidade (`graph.ts:158`, `[...(buckets.get(bucket) ?? []), key]`), o que é quadrático no tamanho do grupo.

### Verificação (tentativa de refutação)
- O React Flow re-renderiza o `NodeWrapper` quando o objeto do nó muda de identidade, e o componente do nó recebe o `data` novo: o `memo` raso não segura.
- Não medi quadros por segundo. A trava visível depende do tamanho do grafo, por isso a confiança é "provável". Que todos os nós re-renderizam está confirmado pelo código.

### Impacto
Só desempenho: arrasto pesado com grafos grandes (dezenas a centenas de nós) e mais bateria gasta no notebook.

## Como reproduzir
Canvas com mais de 12 entidades por lado, expandir dois grupos, ligar o React DevTools Profiler ("Highlight updates") e arrastar uma caixa: todos os nós piscam a cada movimento.

## Solução proposta
1. Tirar o `dim` e o `selected` do `data`: passar `focusIds`/`highlight` por um contexto (como já é feito com `EdgeHoverContext`) e ler dentro do nó com `useContext`. Assim `viewNodes` pode ser o próprio `nodes`.
2. Se `dim` continuar no `data`, memorizar por nó: reaproveitar o objeto anterior quando `dim` e `selected` não mudaram (um `useRef<Map<id, FlowNode>>`).
3. Calcular `highlight` a partir de `built` (ids e tipos), não de `nodes`: as posições não mudam o destaque.
4. Em `viewEdges`, só as arestas caixa→caixa precisam das posições. Reaproveitar as demais e recalcular só quando a posição de uma caixa muda (no `onNodeDragStop`).
5. `buckets`: `push` no array existente.

## Critérios de aceite
- [x] Arrastar um nó re-renderiza só esse nó e as arestas ligadas a ele (Profiler). (pelo código e pelo teste do cache; sem medir no Profiler)
- [x] Destaque por tag, seleção e esmaecimento continuam iguais.

## Testes recomendados
Unitário de `highlightIds` (tags e favoritas) num `graph.test.ts` (o `apps/web` não tem vitest; dá para mover `graph.ts`, que é puro, para um teste no `packages/shared` ou criar o vitest do web). O e2e de canvas existente continua cobrindo a interação.

## Limitações e suposições
Nada foi executado nem medido.

## Análise (triagem)
Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado em `MoneyFlowCanvas.tsx`: a cada mudança do estado `nodes` (cada quadro do arrasto), `highlightIds`, `selected`, `focusIds`, `viewNodes` e `viewEdges` eram refeitos, e `viewNodes`/`viewEdges` criavam objeto e `data` novos para todos os nós e arestas, anulando o `memo` dos tipos de nó; e os `buckets` de `buildGraph` copiavam o array a cada entidade.

## Resolução (executor)
`apps/web/src/components/canvas/MoneyFlowCanvas.tsx`: o destaque sai do grafo montado (`built`), não do estado com as posições; o esmaecido (`focusIds`) sai da seleção e das arestas (com o nó sumido do grafo, nada esmaece, como antes); a seleção só refaz quando o próprio nó selecionado muda, com os nomes das pontas vindos do grafo montado. As visões dos nós e das arestas passam por `createViewCache` (novo em `packages/shared/src/view-cache.ts`): o objeto de cada item é reaproveitado enquanto o item tem a mesma identidade e a chave do que muda a visão (selecionado, esmaecido e, nas arestas, as alças caixa → caixa) é a mesma. No arrasto, o React Flow troca só o objeto do nó arrastado, então só ele (e as arestas caixa → caixa cujas alças mudam) ganha objeto novo e o `memo` dos demais segura o render. Em `graph.ts`, os `buckets` usam `push` no array existente. O comentário de `nodes.tsx` diz por que o `memo` vale. Destaque por tag, seleção e esmaecimento seguem as mesmas regras.

Decisão: a solução 2 da tarefa (reaproveitar por nó), sem mexer nos componentes dos nós nem criar contexto novo; não medi com o Profiler (sem servidor de dev nesta frente).

Testes: unitário `packages/shared/test/view-cache.test.ts` (arrasto refaz só o item trocado; esmaecer um refaz só ele; quem sai da lista é esquecido). O e2e do canvas existente (`visao.spec.ts`) continua cobrindo a interação. Verificação: `pnpm verify:quick`.
