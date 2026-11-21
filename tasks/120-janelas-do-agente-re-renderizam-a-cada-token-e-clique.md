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

# Janelas do agente re-renderizam a conversa inteira a cada token e a página aberta a cada clique na janela

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** desempenho
- **Subcategoria:** re-render em cascata (estado novo sem mudança, contexto único, lista sem memo)
- **Arquivos afetados:** `apps/web/src/agents/AgentsProvider.tsx:204-206,315-323,363-385,476-523,547-560`, `apps/web/src/agents/AgentWindows.tsx:216`, `apps/web/src/agents/ConversationPane.tsx:80,181-269,271-332,354-427`, `apps/web/src/agents/AttachmentPreview.tsx:49-73`, `apps/web/src/agents/useConversation.ts:168-173`, `apps/web/src/lib/storage.ts:12-29`
- **Depende de / relacionado a:** tarefa 122
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Enquanto o agente "digita" a resposta, o navegador redesenha a conversa toda a cada pedacinho de texto, não só a última mensagem. E cada clique dentro de uma janela do agente faz a tela de trás (a caixa, a entidade, o relatório) ser redesenhada também. Em conversas longas, cheias de ferramentas, isso deixa tudo travando.

### Evidência e análise técnica
**Por token** (`text_delta` chega dezenas de vezes por segundo):
- `useConversation.ts:168-173` faz um `setLiveText` por evento, sem juntar por quadro.
- O estado mora no `ConversationPane`, então cada delta re-renderiza `Messages` e **todas** as `MessageView` (`ConversationPane.tsx:227-237`), que não têm `memo` e recebem `liveTools` (objeto novo a cada `tool_*`).
- Em cada `ToolView` renderizado (aberto ou fechado), `JSON.stringify(block.input, null, 2)` (`:399`), o `slice` do resultado (`:403`) e o `JSON.parse` de `toolFile` (`:419-427`) rodam de novo. Numa sessão de conciliação com centenas de chamadas (até 500 linhas por chamada, spec 011), isso é refeito a cada token.
- `useLayoutEffect` sem dependências (`:204-207`) lê `scrollHeight` a cada render: layout forçado por token.
- `MediaProvider` (`AttachmentPreview.tsx:58,68`) cria `Map` e objeto de contexto novos a cada render, re-renderizando todos os consumidores.

**Por clique na janela** (e por `updateMeta`):
- `update` (`AgentsProvider.tsx:206`) passa `normalizeUiState(current)` à função; `normalizeUiState` sempre devolve objeto novo. `focus` (`:315-323`) e `updateMeta` (`:363-385`) "não mudam nada" devolvendo esse `s` novo, então o `useStored` grava no `localStorage` e o React re-renderiza.
- `onPointerDownCapture={() => agents.focus(win.id)}` (`AgentWindows.tsx:216`) dispara isso em **todo** clique dentro de qualquer janela; `updateMeta` roda em cada carga do detalhe e em cada `title`.
- O contexto é um só (`:476-523`): mudou `state`, re-renderizam `Layout` (por `usePanelColumn`), todas as janelas (o `ConversationPane` lê `useAgents().state` em `:80`) e as páginas que chamam `useAgentScreenContext` (`:547-560` usa `useContext(AgentsContext)`): `CaixaPage`, `EntityPage`, `ContractPage`, `ReportsPage`, `CalendarPage`, `FinancialAccountPage`, `InvoicePage`, `NotesPage` e `TitleDrawer`.

### Verificação (tentativa de refutação)
- `Markdown` é `memo` por texto (`Markdown.tsx:52`), então o parse do markdown não se repete; o resto da árvore, sim.
- O `useStored.set` (`lib/storage.ts:16-26`) não compara valores: objeto novo sempre vira render e escrita.
- A página sob o `<Outlet/>` não re-renderiza só porque o `Layout` re-renderizou; ela re-renderiza porque assina o contexto via `useAgentScreenContext`.

### Impacto
Quedas de quadro durante o streaming em sessões longas e "engasgos" ao clicar no chat com uma tela pesada atrás (tabelas da caixa, relatórios). Cresce com o tamanho da sessão e o número de janelas abertas.

## Como reproduzir
1. React DevTools → Profiler com "Highlight updates".
2. Sessão longa (ex.: conciliação com muitas tools) e uma pergunta nova: todas as mensagens piscam a cada token.
3. Com a tela de uma caixa aberta atrás, clicar no texto de uma janela do agente: a página inteira pisca.

## Solução proposta
1. `update`: devolver `current` quando a função devolve a própria base (`const base = normalizeUiState(current); const next = fn(base); return next === base ? current : next;`) e fazer `normalizeUiState` devolver o mesmo objeto quando ele já é v2 e válido.
2. Separar o contexto: um contexto estável só com `registerScreen`/`screenContext` para `useAgentScreenContext`, outro com as ações (estáveis) e outro com `state`; o `ConversationPane` lê só o `audioMode` da sua janela (seletor ou prop).
3. `memo(MessageView)` com props estáveis (`liveTools[block.id]` por mensagem, `results`/`confirmations` memorizados) e o corpo do `ToolView` (JSON da entrada e do resultado) só renderizado quando o `<details>` estiver aberto.
4. Juntar os deltas por `requestAnimationFrame` (acumular num `ref` e aplicar uma vez por quadro).
5. `useLayoutEffect` do rolamento com dependências (`detail.messages.length`, `liveText`, `liveThinking`).

## Critérios de aceite
- [ ] Durante o streaming, só a bolha ao vivo re-renderiza (Profiler).
- [ ] Clique numa janela já na frente não grava no `localStorage` nem re-renderiza a página.
- [ ] Nenhuma mudança visível de comportamento (ordem das janelas, títulos, modo áudio).

## Testes recomendados
Medição manual com o Profiler (antes/depois) numa sessão com 200 chamadas de tool; em `e2e/tests/agentes.spec.ts`, um caso com o provedor falso emitindo muitos deltas e muitas tools, conferindo que a resposta termina dentro de um tempo fixo. Teste unitário de `normalizeUiState`/`update` devolvendo o mesmo objeto quando nada muda (exigiria um runner no `apps/web`).

## Limitações e suposições
Nada foi medido; o custo real depende do tamanho da sessão e da página atrás.

## Análise (triagem)

## Resolução (executor)
