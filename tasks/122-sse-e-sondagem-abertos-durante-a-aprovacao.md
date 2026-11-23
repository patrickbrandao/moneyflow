---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: e035b34
---

# SSE do chat fica aberto enquanto a execução espera aprovação, uma conexão por janela e por aba

- **Severidade:** média
- **Confiança:** provável
- **Categoria:** desempenho
- **Subcategoria:** conexões longas e sondagem sem necessidade (limite de 6 por origem no HTTP/1.1)
- **Arquivos afetados:** `apps/web/src/agents/useConversation.ts:218-240`, `apps/web/src/agents/format.ts:51-52`, `apps/web/src/agents/stream.ts:42-84`, `apps/web/src/agents/AgentsProvider.tsx:194`, `apps/web/src/components/reconciliation/RecipesPanel.tsx:76-82`, `apps/web/src/components/reconciliation/ReconcileAiPanel.tsx:31`, `apps/server/src/routes/agents.ts:61,122-203`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando o agente para e espera você aprovar uma ação, a janela continua com uma conexão aberta com o servidor, às vezes por horas. Com duas ou três janelas de agente esperando e o MoneyFlow aberto em mais de uma aba, o navegador esgota as conexões que ele permite para o mesmo site e o sistema inteiro fica "carregando" sem responder.

### Evidência e análise técnica
- `useConversation.ts:219`: `runId = run && isActiveStatus(run.status) ? run.id : null`, e `isActiveStatus` (`format.ts:51-52`) inclui `awaiting_confirmation`. O efeito (`:220-240`) mantém `followRun` aberto enquanto o status não for final.
- O servidor só fecha o SSE no `done` ou num status final (`routes/agents.ts:61`: `FINAL = completed, failed, canceled`); em `awaiting_confirmation` a conexão fica viva com `: ping` a cada 15 s e, por conexão, uma releitura de `runEvents` + `getRun` a cada 5 s (`:196-203`).
- `followRun` (`stream.ts:45-83`) reconecta para sempre (backoff até 30 s) enquanto não vier `done`.
- Cada aba monta as mesmas janelas: o estado vem do `localStorage` (`AgentsProvider.tsx:194`, sem ouvir o evento `storage`), então N abas × janelas abertas com execução ativa = N × conexões. Ao montar (abrir aba, restaurar da doca, ancorar/desancorar, que remonta o `ConversationPane`), o stream começa sem `after` e o servidor reenvia **todos** os eventos da execução desde o seq 0 (`routes/agents.ts:127`).
- Na tela do lote, `RecipesPanel.tsx:77-82` sonda `/recipes` a cada 4 s enquanto existir execução `started`, o que inclui a que espera aprovação, e também com a aba em segundo plano (`setInterval` direto, sem `visibilityState`).
- Contraste: `ReconcileAiPanel.tsx:31` já exclui `awaiting_confirmation` do SSE (relê ao decidir). O padrão certo existe no próprio código.
- Somam-se os SSE da tela do lote (`ImportDetail.tsx:258-268`, `SupersedePanel.tsx:166-175`).

### Verificação (tentativa de refutação)
- Com HTTP/2 entre o navegador e o proxy o limite de 6 conexões não se aplica. Mas o `docker-compose.yml` expõe a API em `http://localhost:3000` (HTTP/1.1), o `pnpm dev` passa pelo proxy do Vite (HTTP/1.1) e não há nada em `docs/001` ou `docs/018` sobre HTTP/2 na produção. Por isso "provável".
- Não há fechamento por `visibilitychange` em lugar nenhum do `apps/web` (`rg visibilitychange` vazio).
- A spec 011 (linha 88) só diz que o SSE "fecha no `done`"; não exige mantê-lo durante a espera.

### Impacto
Em HTTP/1.1, a partir de ~6 conexões longas por origem (somando abas), todas as outras requisições do console ficam na fila: telas sem carregar, ações sem resposta. Mesmo sem chegar ao limite, cada SSE em espera custa ao servidor duas consultas a cada 5 s, por aba.

## Como reproduzir
1. Servir a pilha em HTTP/1.1 (`docker compose up`, porta 3000).
2. Dois agentes com um kit em `ask`; em cada janela pedir uma escrita e deixar o cartão "Aplicar?" aberto.
3. Abrir mais duas abas do console (as janelas reabrem sozinhas) e abrir uma tela qualquer: as chamadas `/api/...` ficam "pending" no DevTools.

## Solução proposta
1. Em `useConversation`, seguir o SSE só em `queued`/`running`: ao receber `status: awaiting_confirmation`, abortar o stream (guardando o último seq) e reabrir com `after` quando `decide()` devolver `queued`/`running` (o `runStatus` já volta na resposta). Na carga com execução em espera, não abrir o SSE.
2. Fechar o SSE com a aba oculta (`document.visibilityState === 'hidden'`) e reabrir com `Last-Event-ID` ao voltar (o servidor já suporta).
3. Reabrir a partir do último evento já refletido no detalhe (o `seq` da última mensagem), não do 0, quando o texto parcial não for necessário.
4. `RecipesPanel`: sondar só com `runStatus` `queued`/`running` e por `usePolling` (que respeita a aba oculta).
5. Opcional: um único SSE por aba multiplexando execuções, ou o servidor encerrar o stream ao entrar em espera.

## Critérios de aceite
- [ ] Com o cartão "Aplicar?" na tela, não há requisição pendente para `/api/runs/:id/events`.
- [ ] Ao aprovar, o stream reabre e a resposta chega sem recarregar.
- [ ] Aba em segundo plano não mantém SSE nem sondagem de receitas.

## Testes recomendados
`e2e/tests/agentes.spec.ts`, no caso "aprova uma escrita" (linha 178): com `page.on('request')`/`requestfinished`, conferir que nenhum `/events` fica aberto enquanto o cartão está visível e que um novo abre depois de aprovar. Não há e2e das receitas (`rg -l recipe e2e/tests` vazio): um caso novo com uma receita cuja execução fica em `awaiting_confirmation` deve conferir que `/api/statement-imports/:id/recipes` não é chamado a cada 4 s.

## Limitações e suposições
Não sei se a produção usa HTTP/2 no proxy. Nada foi executado.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado: `useConversation` seguia o SSE com `isActiveStatus` (inclui `awaiting_confirmation`), então a conexão ficava aberta durante a espera por aprovação; nenhum `visibilitychange` no `apps/web`; o `RecipesPanel` sondava a cada 4 s com `setInterval` enquanto houvesse execução `started` (inclusive a que espera aprovação) e com a aba oculta. O `ReconcileAiPanel` já excluía a espera. Sem HTTP/2 documentado na produção (a confiança "provável" da tarefa vale).

## Resolução (executor)

- `agents/stream.ts`: com a aba escondida, o `followRun` fecha a conexão e espera ela aparecer; volta do último id visto (Last-Event-ID), sem contar como queda nem mostrar "reconectando". Vale para todo SSE de execução (conversa, conciliação com IA, sugestões do lote e da troca do provisório). O `onEvent` recebe também o seq do evento.
- `agents/useConversation.ts`: o SSE só fica aberto com a execução `queued`/`running`; ao chegar o `status: awaiting_confirmation` (o servidor grava a confirmação antes dele, na mesma transação), a conexão fecha e o último seq fica guardado (`seen`); ao decidir, o `runStatus` devolvido reabre o SSE de onde parou (e, se a execução já terminou, relê o detalhe). Na carga com execução em espera, nenhum SSE. Durante a espera, uma consulta `GET /api/runs/:id` a cada 10 s pelo `usePolling` (só com a aba visível) percebe a decisão tomada noutra aba ou no Telegram e relê o detalhe.
- `components/reconciliation/RecipesPanel.tsx`: sonda pelo `usePolling` (respeita a aba oculta) e só com execução na fila ou rodando; a que espera aprovação não é sondada (o painel da IA avisa ao terminar, pelo `version`).

Decisões: o item 3 (reabrir do seq da última mensagem já na carga) ficou de fora: na primeira conexão o histórico desde o 0 reconstrói o texto parcial da resposta em andamento; a retomada do último evento vale dentro da mesma tela (espera e aba oculta). O item 5 (um SSE multiplexado por aba) não foi feito. Spec 011 atualizada.

Testes: e2e novo (não rodado aqui) em `e2e/tests/agentes.spec.ts` → "SSE (tarefa 122): nada aberto enquanto espera aprovação nem com a aba escondida; aprovar e voltar retomam" (com o cartão na tela, nenhum `/events` pendente; aprovar abre um novo com `Last-Event-ID`; a aba escondida no meio da resposta lenta fecha e, de volta, a resposta termina). Sem e2e das receitas (o caso exigiria uma receita com execução em espera; fica para a sessão principal se quiser). Verificação: `pnpm verify:quick`.
