---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 701195e
---

# Parada do processo sem prazo nem ordem, e healthcheck do worker que não diz nada

- **Severidade:** média
- **Confiança:** confirmado (healthcheck e parada do worker); provável (execuções que só voltam depois de 2 min, mensagem reenviada do Telegram e parada da API com SSE aberto)
- **Categoria:** ponto fraco
- **Subcategoria:** desligamento gracioso e saúde/sinais do processo na imagem
- **Arquivos afetados:** `Dockerfile:3-4`, `Dockerfile:46-48`, `apps/server/src/main.ts:12`, `apps/server/src/main.ts:17-44`, `apps/server/src/worker.ts:27-71`, `apps/server/src/agents/worker.ts:56`, `apps/server/src/agents/worker.ts:188-194`, `apps/server/src/agents/runner.ts:100-127`, `apps/server/src/routes/agents.ts:122-200`, `apps/server/src/app.ts:66`, `docker-compose.yml:96-113`
- **Depende de / relacionado a:** tarefa 053; tarefa 097; tarefa 108
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O Docker acha que o worker (quem manda mensagens, lembretes e roda os agentes) está sempre bem, mesmo travado ou sem banco; e, se ele for iniciado do jeito que o próprio Dockerfile sugere, acha que está sempre doente. Ao parar ou atualizar a pilha, o worker espera as conversas com a IA terminarem, o Docker perde a paciência em 10 segundos e mata o processo no meio. A cada atualização, quem estava conversando com um agente vê a resposta parar por uns 2 minutos e depois recomeçar do zero; se a parada pegou uma ação em andamento, o agente avisa que ela "foi interrompida" e pede para conferir. O worker também pode ser desligado no meio do envio de uma mensagem do Telegram: ela sai, o sistema não registra o envio e, cinco minutos depois, manda de novo. Já a API pode demorar a desligar enquanto alguém está com a janela de um agente aberta.

### Evidência e análise técnica
1. **Healthcheck do worker.** `Dockerfile:46-47`:
   ```
   CMD node -e "if (process.env.MODE === 'worker') process.exit(0); fetch('http://127.0.0.1:' + process.env.PORT + '/api/health')…"
   ```
   Com `MODE=worker` (como no `docker-compose.yml:101`), o teste é `exit 0` incondicional: um worker com o laço parado, o pool sem conexão ou a fila de agentes travada continua `healthy`, e o `docker compose up --wait` do CI (`ci.yml:63`) não prova nada sobre ele. Já o caminho documentado no próprio Dockerfile, "pelo argumento (`docker run … worker`)" (`Dockerfile:3-4`; `main.ts:12` lê `process.argv[2]` antes de `MODE`), não define `MODE`: o healthcheck tenta `http://127.0.0.1:3000/api/health`, onde nada escuta, e o container fica `unhealthy` para sempre.
2. **Parada do worker sem prazo.** O `SIGTERM` chega (o `node` é PID 1 e instala o handler em `main.ts:26-27`), mas `shutdown` espera `stop()` e `stop()` espera todas as execuções de agente em andamento: `stopped = true`, limpa os timers e `await Promise.allSettled([...active, ...transcribing])` (`agents/worker.ts:188-194`). Não há prazo nem sinal para as execuções: cada uma segue até o fim. Uma conciliação tem até 60 voltas, uma espera de transcrição até 120 s, e uma execução em streaming pode levar minutos. O compose (serviço `worker`, `:96-111`) não define `stop_grace_period` (padrão 10 s) nem `init: true`, e o processo é o PID 1 (`Dockerfile:48`), então o Docker manda `SIGKILL`; `pool.end()` (`main.ts:22-23`) quase nunca chega a rodar.
3. **Execução morta só volta 2 minutos depois.** Ela fica `running` com o `locked_at` renovado há menos de 3 s. O worker novo só a reserva quando a reserva fica velha: `staleAfter = '2 minutes'` (`agents/worker.ts:56`). Até lá o console mostra a execução parada. Na retomada, a chamada ao modelo que estava no meio é refeita do zero (custo repetido), e a escrita que estava no meio vira "interrompida… confira" (tarefa 053). A parada também não espera a manutenção, as tarefas agendadas nem a fila das receitas; as transações em curso são desfeitas pelo servidor quando a conexão cai, sem dano, mas sem log.
4. **Passadas em voo não esperadas.** O `stop` devolvido por `startWorker` limpa os `setInterval` e espera só os agentes (`worker.ts:67-71`); a passada em andamento do laço de mensagens (`messages`, `:51-61`) e a de hora em hora (`tick`, `:29-46`: séries, cartões, contratos) não são esperadas. `main.ts:21-25` chama `pool.end()` logo depois: a passada em voo morre com "Cannot use a pool after calling end" no log. O `pg-pool` resolve o `end()` quando não há cliente emprestado; entre o `fetch` da Bot API (fora de transação, sem cliente) e o `message_outbox_mark_sent` (`messages.ts:503-504`) não há cliente emprestado, então o `end()` pode resolver ali, e o `process.exit(0)` corta o processo depois de o Telegram ter recebido a mensagem e antes de ela ser marcada. Se o processo sobreviver um pouco, o `mark_sent` falha com a mesma mensagem. Nos dois casos, a mensagem fica em `sending` e a reserva vencida (5 min) a reenvia. O `shutdown` também pode rodar duas vezes (SIGINT e depois SIGTERM), e o segundo `pool.end()` rejeita sem `catch`.
5. **Sinal ignorado no boot da API.** Os handlers da API são registrados só depois de `buildApp` e `ensureInitialAdmin` (`main.ts:32-42`). Como PID 1, o Node ignora `SIGTERM` sem handler: um `docker stop` durante o boot espera os 10 s inteiros.
6. **API com SSE aberto (provável).** O stream de eventos faz `reply.hijack()` (`routes/agents.ts:123-200`) e só termina no `done` ou quando o cliente sai; uma execução esperando aprovação mantém o stream aberto indefinidamente (ping a cada 15 s). `app.close()` (`main.ts:37`) espera o `server.close()` do Node, que só fecha conexões ociosas. O `RunEventsHub.stop()` está num `onClose` (`app.ts:66`), que o Fastify roda depois do `server.close()`; nada encerra os streams antes, e não há `forceCloseConnections` nem `preClose`. Com uma janela de agente aberta, a parada da API também vai ao `SIGKILL`.

### Verificação (tentativa de refutação)
- Procurei outro sinal de vida do worker (arquivo de heartbeat, tabela, rota): não há; o único heartbeat é por execução de agente (`ai_runs`).
- A retomada da execução existe (spec 011, `ai_run_claim` com `staleAfter`), e a reserva vencida da outbox e o lease das execuções evitam perda; o `SIGKILL` não perde dados. O efeito é atraso, chamada ao modelo refeita (e paga de novo) e mensagem duplicada.
- O `docker-compose.yml` não sobrescreve o `healthcheck` do worker nem define `init: true`/`stop_grace_period`. A configuração de produção fica num projeto externo e não foi vista. Se ela tiver um `stop_grace_period` grande, o SIGKILL some, mas a espera sem prazo continua, e uma conciliação longa segura o deploy.
- A tarefa 053 resolveu a repetição da escrita na retomada, não a demora nem o corte. Nenhum teste cobre a parada do worker com uma execução ativa.
- A parte do worker foi confirmada pela leitura; a da API depende do comportamento do Fastify 5 com reply sequestrado (`fastify.js:383-420`) e do `server.close()` do Node com conexões `hijack`, que li na documentação (`forceCloseConnections: 'idle'`) mas não executei.

### Impacto
Worker travado passa despercebido (lembretes, mensagens do Telegram e agentes param sem alarme). A cada deploy ou reinício as execuções em andamento são mortas e refeitas cerca de 2 minutos depois, com uma chamada repetida por execução ativa e avisos de "interrompida" que confundem o usuário. Mensagem duplicada no Telegram em parte dos deploys do worker (quando o SIGTERM cai no meio de um envio). Deploy da API mais lento, terminado à força, sempre que houver uma janela de agente aberta. Quem seguir o `docker run … worker` do comentário tem um container sempre `unhealthy`.

## Como reproduzir
1. `docker run --rm -e DATABASE_URL=postgres://x@nada/x tmsoftbrasil/moneyflow:dev worker` → em 1 min, `docker ps` mostra `unhealthy` (o healthcheck chama a porta 3000).
2. Na pilha: `docker compose exec postgres pg_ctl stop` (ou derrube a rede do worker) → `docker compose ps` continua mostrando o worker `healthy`.
3. Com um agente respondendo em streaming (uma tarefa de várias voltas), `docker compose stop worker` ou `restart worker` → leva 10 s e o log mostra o `SIGKILL`; o console fica parado em "rodando" por cerca de 2 minutos e a execução volta à fila só depois, com `attempts = 2` em `ai_runs`.
4. Worker e mensagens: Bot API falsa com atraso de 3 s no `sendMessage`; enfileire uma mensagem, mande SIGTERM durante o envio e confira que ela fica `sending` e é enviada de novo depois da reserva vencer.
5. API: abra o SSE de uma execução em `awaiting_confirmation` (`curl -N /api/runs/<id>/events` com o cookie) e mande SIGTERM ao processo: ele não termina sozinho.

## Solução proposta
1. Heartbeat do worker: a cada passada de cada laço (`worker.ts`, `agents/worker.ts`), gravar `Date.now()` em `/tmp/worker-heartbeat` (ou numa tabela `worker_heartbeats` pelo dba, útil também para a tela de admin). O healthcheck do worker passa a checar a idade do arquivo (ex.: < 3 × `MESSAGE_INTERVAL_MS`).
2. Decidir o modo do healthcheck pelo mesmo critério do `main.ts` (argumento ou `MODE`), por exemplo com um script `healthcheck.mjs` no bundle que recebe o modo.
3. Parada com prazo e devolução na hora: um `AbortController` de desligamento passado ao `processRun`. No `stop()`, abortar com um motivo próprio (`Shutdown`), com prazo (`SHUTDOWN_GRACE_MS`, padrão 8 s, abaixo dos 10 s do Docker; passado o prazo, sair mesmo assim). O runner, no `checkpoint` e no abort do stream, devolve a execução à fila com a cerca do token, `UPDATE ai_runs SET status = 'queued' WHERE id = … AND lock_token = …`, sem gravar erro; o worker seguinte a reserva na hora. As que não voltaram à fila caem na reserva velha, como hoje. Entre tools, depende do checkpoint proposto em tarefa 097.
4. Esperar também os laços em andamento (`tick`, `messages`, manutenção, tarefas, receitas) dentro do mesmo prazo: guardar a promessa da passada de cada laço (`current = messageTick(...)`) e, no `stop`, esperar `Promise.allSettled([currentMessages, currentTick, stopAgents()])` antes de devolver; um `stopping` impede começar passada nova.
5. `shutdown` idempotente (uma flag) e com teto de tempo (por exemplo, 8 s e então `process.exit(1)`); registrar `SIGTERM`/`SIGINT` no início do `main()`.
6. API: um `preClose` que manda `done` (ou só `res.end()` com um evento `retry`) aos SSE abertos, por exemplo com o `RunEventsHub` guardando os `close` registrados, já que o cliente reconecta com `Last-Event-ID`; ou `forceCloseConnections: true` no `Fastify(...)`.
7. No compose, `stop_grace_period: 30s` no serviço `worker`, e uma nota na `docs/018`.

### Diff/patch proposto — NÃO APLICADO
```js
// apps/server/healthcheck.mjs (copiado para a imagem)
const mode = process.argv[2] ?? process.env.MODE ?? 'api';
if (mode === 'worker') {
  const { statSync } = await import('node:fs');
  const age = Date.now() - statSync('/tmp/worker-heartbeat').mtimeMs;
  process.exit(age < 3 * Number(process.env.MESSAGE_INTERVAL_MS || 30000) ? 0 : 1);
}
const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).catch(() => null);
process.exit(r?.ok ? 0 : 1);
```

## Critérios de aceite
- [ ] O worker fica `unhealthy` quando o laço de mensagens não passa há mais de 3 intervalos.
- [ ] `docker run … worker` (sem `MODE`) fica `healthy` quando está bem.
- [ ] SIGTERM com uma execução no meio de uma chamada ao modelo: ela volta a `queued` em menos de 10 s, e outro worker a conclui sem esperar a reserva velha (2 min).
- [ ] A parada do worker termina em até o prazo configurado, mesmo com execuções longas, e `docker compose stop worker` termina dentro do prazo.
- [ ] SIGTERM no worker durante um envio termina depois de o envio ser marcado `sent`; nada é reenviado.
- [ ] Nenhum "Cannot use a pool after calling end" no log da parada.
- [ ] SIGTERM na API com um SSE aberto termina em menos de 2 s, fechando o stream (o `EventSource` do console reconecta em outra réplica).

## Testes recomendados
- `apps/server/test/agents.test.ts`: iniciar `startAgentWorker` com o provedor falso lento ("responda devagar", `dropAfter`/atraso), chamar a função de parada no meio e conferir que a execução volta a `queued` com `lock_token` nulo (sai de `running`), em menos de N ms, e que a parada terminou dentro do prazo.
- `apps/server/test/vision.test.ts`: `startWorker` com a Bot API falsa atrasando 1 s; chamar o `stop()` logo depois de a mensagem entrar em `sending` e conferir, depois do `await`, que ela está `sent`.
- Teste de API: `buildApp` + `listen` numa porta livre, abrir o SSE com `fetch` e conferir que `app.close()` resolve em menos de 2 s.
- O healthcheck se confere à mão na pilha.

## Limitações e suposições
Nada foi executado. O tempo de 2 minutos vem do `staleAfter` padrão, e o SIGKILL em 10 s do comportamento padrão do Docker. Não vi a configuração de parada da produção (`stop_grace_period`), que fica num projeto externo.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app).

Confirmado na leitura: o healthcheck do `Dockerfile` saía 0 para `MODE=worker` e chamava a porta 3000 com `docker run … worker` (sem `MODE`); `stop()` dos agentes esperava todas as execuções sem prazo nem sinal; o `stop` do worker não esperava as passadas em andamento antes do `pool.end()`; o `shutdown` podia rodar duas vezes; a API registrava os sinais depois do `buildApp`; e o SSE (`reply.hijack()`) não era fechado antes do `server.close()`. A transição `running → queued` já existe no banco (o gatilho limpa a reserva e zera `attempts`), então a devolução à fila não precisa do dba.

## Resolução (executor)

- Healthcheck: `apps/server/src/health.ts` (batimento em arquivo — `WORKER_HEARTBEAT_FILE`, padrão na pasta temporária —, saudável até 3 × `MESSAGE_INTERVAL_MS` com mínimo de 90 s; o modo pelo mesmo critério do `main.ts`, lendo o argumento do processo principal em `/proc/1/cmdline`, senão `MODE`, senão api) e `apps/server/src/healthcheck.ts`, empacotado em `dist/healthcheck.mjs` (`build.mjs` com duas entradas). O `Dockerfile` usa `node /app/healthcheck.mjs` (start-period 30 s). O laço de mensagens grava o batimento a cada passada que chega ao banco (`SELECT 1` depois do `messageTick`, porque as etapas isoladas da tarefa 104 não lançam com o banco fora).
- Parada com prazo (`SHUTDOWN_GRACE_MS`, padrão 8 s, 1–600 s, em `config.ts`): `apps/server/src/shutdown.ts` (`settleWithin`, `tracked`). `agents/worker.ts`: o `stop(graceMs)` aborta um sinal de desligamento, para de reservar e espera execuções, transcrições e os laços (reserva, manutenção, tarefas, receitas) até o prazo. `agents/runner.ts`: `WorkerDeps.shutdown`; a chamada ao modelo, a espera das transcrições e a da volta à fila param no sinal (as tools não: terminam antes); no próximo ponto seguro (antes de cada volta e de cada tool) ou no corte da chamada, `requeue` devolve a execução à fila com a cerca do `lock_token` e o evento `error` `worker_shutdown` (não conta como erro do provedor; o console o trata como o `provider_retry`, descartando o texto parcial). `worker.ts`: `startHourlyLoop` e `startMessageLoop` (exportado) não começam passada nova na parada e esperam a em andamento — o envio do Telegram termina marcado `sent` — junto com os agentes, no mesmo prazo.
- `main.ts`: sinais registrados no início (também durante o boot da API), parada uma vez só, `pool.end()` uma vez, e saída forçada em `SHUTDOWN_GRACE_MS` + 1,5 s; o modo por `resolveMode`.
- API: `routes/agents.ts` guarda os streams SSE abertos e os fecha num `preClose` (antes do `server.close()`); o `EventSource` reconecta com `Last-Event-ID`.
- `docker-compose.yml`: `stop_grace_period: 30s` e `SHUTDOWN_GRACE_MS` no worker; `.env.example` com as duas variáveis.
- Decisões: batimento em arquivo (sem tabela nova no banco); a API não ganhou `forceCloseConnections` (só os SSE são fechados; as demais requisições terminam, com a saída forçada como teto).
- Spec: `docs/018` (parada e saúde; nota para o compose do projeto externo) e a linha dela no `docs/INDEX.md`; `AGENTS.md` (uma frase no `src/worker.ts`).
- Testes: `apps/server/test/health.test.ts` (novo, sem banco: o modo por `/proc/1/cmdline`/`MODE`, inclusive com o init na frente; a idade do batimento; `settleWithin` no prazo); `apps/server/test/agents.test.ts` ("parada do worker: a execução no meio da chamada volta à fila na hora…": em menos de 2 s, `queued`, sem `lock_token`, `attempts` 0 e o evento `worker_shutdown`, e o `drain` seguinte conclui com uma resposta só; "…termina dentro do prazo mesmo com uma execução longa": `stop(3000)` do `startAgentWorker` em menos de 3 s; "a API fecha os streams SSE abertos ao parar": o `close()` com um SSE aberto em menos de 2 s e o stream encerrado); `apps/server/test/vision.test.ts` ("parada do laço de mensagens…": com a Bot API demorando 1 s, a parada no meio do envio volta com a mensagem `sent`, e o batimento gravado). O healthcheck empacotado foi conferido à mão (`node dist/healthcheck.mjs`: worker sem batimento 1, com batimento 0, API sem servidor 1); o `docker build` e o `docker stop` da pilha ficam para a verificação completa.
- Verificação: `pnpm verify:quick`.
