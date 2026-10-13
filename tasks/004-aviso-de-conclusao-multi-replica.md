---
status: concluida
tipo: debito-tecnico
origem: agente
autor: app
responsavel: app
prioridade: baixa
criada: 2026-10-11
commit: 5140e59
---

# Aviso de conclusão do agente com várias réplicas da API

## Descrição
O aviso `agent_completed` é decidido pela presença no SSE dentro de cada processo da API (`events-hub.ts`). Com mais de uma réplica, cada uma só enxerga os próprios streams; o sino deduplica, mas a outbox do `emitAgentEvent` usa `Date.now()` na `dedup_key` e pode mandar o aviso duplicado no Telegram. Pedido: presença no banco ("visto até" por execução, ou heartbeat de presença) e `dedup_key` determinística por execução. Só é necessário quando houver mais de uma réplica; a triagem decide a prioridade.

## Como reproduzir
Subir duas réplicas da API, abrir a conversa numa e terminar a execução.

## Análise (triagem)
**Procede em parte** (conferido em 2026-10-13).

São dois problemas diferentes:

1. **`dedup_key` não determinística na outbox: bug real, barato de corrigir.** Em `apps/server/src/services/message-worker.ts` → `emitAgentEvent`, a chave da outbox é `${kind}:${agentRunId}:${sub.id}:${Date.now()}`, então o `ON CONFLICT (destination_id, dedup_key) DO NOTHING` nunca deduplica. A chave do sino (`${kind}:${runId}:${text.length}:${text.slice(0,40)}`) é determinística, mas junta dois "aguardando confirmação" com o mesmo texto na mesma execução.
   - Chamadores: `agents/events-hub.ts` (`notifyIfFinished`, que tem o `seq` do evento) e a tool `notify_user` (`agents/tool-handlers.ts`, que tem `meta.toolUseId`). Na tool, uma execução retomada depois de queda do worker que repete a tool também duplicaria o Telegram.
   - Correção (app): `emitAgentEvent` recebe uma chave do evento — `run:<runId>:seq:<seq>` no hub e `run:<runId>:tool:<toolUseId>` na tool — e usa essa chave no sino e na outbox (`${kind}:${eventKey}:${sub.id}`). Isso já elimina o Telegram duplicado com várias réplicas.
2. **Presença no SSE por processo: só importa com mais de uma réplica.** `RunEventsHub.dispatch` só considera os streams do próprio processo. Com duas réplicas, a que não tem o stream avisa "ninguém olhando" mesmo com o usuário vendo a conversa na outra: o aviso fica errado, não só duplicado. Corrigir isso pede presença no banco (dba + app). Hoje o compose da raiz sobe uma API, e a produção roda num projeto externo (spec 018) sem réplicas documentadas, então **fica fora do escopo** desta tarefa. Se for adotada mais de uma réplica, abrir uma tarefa de banco (presença por execução, ex.: `ai_runs.viewed_at` atualizado pelo SSE com heartbeat) e a da app em seguida.

Executor: app, só o item 1. Atualizar a frase da spec 011 (aviso de conclusão), dizendo que a outbox e o sino deduplicam por evento e que a decisão de presença ainda supõe uma réplica.

Risco: baixo. Verificação (integração, `apps/server/test/agents.test.ts` ou um teste de mensagens): chamar `emitAgentEvent` duas vezes com o mesmo evento (simulando duas réplicas) cria uma notificação e uma linha na outbox por destino. Dois "aguardando confirmação" da mesma execução (seq diferentes) criam duas.

Ordem: independente. Prioridade baixa. Esforço: pequeno (~1 h).

## Resolução (executor)
Item 1 corrigido (2026-10-13). `emitAgentEvent` (`apps/server/src/services/message-worker.ts`) recebe `eventKey`, uma chave determinística do evento, e a usa no sino (`${kind}:${eventKey}`) e na outbox (`${kind}:${eventKey}:${sub.id}`), no lugar de `Date.now()` e do recorte do texto. Chamadores: `agents/events-hub.ts` (`notifyIfFinished`) passa `run:<runId>:seq:<seq>`; a tool `notify_user` (`agents/tool-handlers.ts`) passa `run:<runId>:tool:<toolUseId>` e, pelo `/mcp` (sem execução), `mcp:tool:<toolUseId>`. Assim o mesmo evento avisado por outra réplica ou repetido numa retomada não duplica o sino nem o Telegram, e dois "aguardando confirmação" da mesma execução com o mesmo texto viram dois avisos.

Teste: `apps/server/test/vision.test.ts` → "evento de agente: o mesmo evento emitido duas vezes (duas réplicas) gera um aviso por destino; outro seq gera outro" (um aviso e uma linha de outbox por destino para o mesmo seq; dois para seqs diferentes). Spec 011 (aviso de conclusão) atualizada: deduplica por evento; a decisão de presença ainda supõe uma réplica.

Item 2 (presença no banco) fica fora do escopo, como decidido na triagem.
