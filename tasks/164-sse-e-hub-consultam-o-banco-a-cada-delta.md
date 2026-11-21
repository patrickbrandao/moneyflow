---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# SSE e hub de eventos consultam o banco a cada delta de texto (e o aviso do banco não diz o tipo do evento)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** desempenho
- **Subcategoria:** consultas por evento de streaming / LISTEN-NOTIFY dos agentes
- **Arquivos afetados:** `apps/server/src/routes/agents.ts:151-206`, `apps/server/src/agents/events-hub.ts:100-148`, `apps/server/src/agents/runner.ts:385-416`, `apps/server/src/services/conversations.ts:604-613`, `database/schema.sql:2526-2547` (`ai_run_event_append`)
- **Depende de / relacionado a:** tarefa 004 (aviso de conclusão com várias réplicas)
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Enquanto o agente escreve a resposta, o servidor faz dezenas de consultas por segundo ao banco só para repassar os pedaços de texto ou para descobrir que não precisa avisar ninguém. Isso vale tanto com a janela aberta (o stream) quanto sem ninguém olhando (tarefa agendada, conversa pelo Telegram, leitura de documento, ou o usuário fechou a janela), e se multiplica pelo número de réplicas da API. Com poucos usuários não se nota; com várias conversas ao mesmo tempo, vira carga desnecessária.

### Evidência e análise técnica
São dois lugares do mesmo padrão (consulta por evento de streaming):

**No SSE (com a janela aberta).**
- O runner grava um evento por flush de 120 ms, às vezes dois (raciocínio e texto, `runner.ts:385-400`); uma resposta de 30 s gera centenas de eventos `text_delta`/`thinking_delta`. Cada um é um `ai_run_event_append` com NOTIFY próprio.
- Cada aviso chama `pump()` (`agents.ts:195`). Cada volta do `pump` faz `runEvents` e, mesmo quando acabou de ler eventos, `conversations.getRun(r.ctx, runId)` (`agents.ts:176`). `getRun` faz `loadRun` e `loadConversation`, que junta 4 tabelas (`conversations.ts:604-613`, `:84-91`). Isso dá cerca de 3 consultas por delta e por stream aberto, só para conferir um estado final que o próprio evento `done` já informa.

**No hub (sem ninguém com a janela aberta).**
- `ai_run_event_append` (`schema.sql:2537`) avisa com `pg_notify('ai_run_events', json_build_object('run_id', …, 'seq', …))`: o payload só tem `run_id` e `seq`, sem o `event_type`.
- Em `RunEventsHub.dispatch` (`events-hub.ts:100-107`), sem stream aberto daquela execução nesta réplica, todo aviso chama `notifyIfFinished`, que faz `SELECT … FROM ai_run_events e JOIN ai_runs r … JOIN ai_conversations c … WHERE e.run_id = … AND e.seq = …` (`events-hub.ts:111-121`) para descobrir o tipo e só depois descarta o que não é `done` nem `status`/`awaiting_confirmation` (`events-hub.ts:124-127`). São 8 a 16 consultas por segundo por execução sem tela aberta (tarefas, receitas, Telegram, fluxos). Toda réplica da API escuta o canal; com N réplicas, N consultas por evento.
- No fim da execução, `notifyIfFinished` lê a sessão inteira (`loadMessages`, `events-hub.ts:130`) para pegar o texto da última resposta. Numa sessão longa são megabytes de JSONB para 2 mil caracteres.

### Verificação (tentativa de refutação)
- O `running/again` do `pump` agrupa os avisos, mas cada volta continua com as 3 consultas.
- A releitura a cada 5 s já cobre a perda de NOTIFY e o estado final sem `done` (eventos expurgados). Conferir o status a cada delta não é necessário para a correção.
- Cada consulta do hub é barata (índices `ai_run_events_seq_key` e as PKs), por isso a severidade é baixa.
- O payload com o tipo continua muito abaixo do limite de 8000 bytes do NOTIFY, e o tipo não é dado sensível (o canal só é ouvido pela própria aplicação). O `error` não precisa ir no aviso: a consulta continua para os eventos terminais.
- Nenhum teste mede o número de consultas do SSE nem do hub. O comportamento foi lido no código.

### Impacto
Carga no Postgres e na API proporcional a (streams abertos + execuções sem tela) × deltas por segundo × réplicas. Cresce com o uso de tarefas agendadas e do Telegram, que nunca têm stream aberto, e com `AGENT_CONCURRENCY` maior. Não quebra nada.

## Como reproduzir
1. Com `log_statement = 'all'` no Postgres de desenvolvimento, abra uma conversa e peça uma resposta longa. Conte as consultas `SELECT … FROM ai_runs r WHERE r.id = …` e as de `ai_conversations` durante o stream: são da ordem do número de deltas.
2. Dispare uma tarefa agendada ("Rodar agora") e não abra a janela do agente. Conte no log as consultas `SELECT e.event_type, e.payload, r.user_id …` durante a resposta: uma por `text_delta`.

## Solução proposta
1. dba (migration nova): `ai_run_event_append` inclui `'type', p_event_type` no JSON do `pg_notify` (`json_build_object('run_id', …, 'seq', s, 'type', p_event_type)` e, se quiser, `'status', p_payload ->> 'status'` nos eventos `status` e `done`). Atualizar o comentário da função e a `docs/016`.
2. app: `dispatch` lê `type` do aviso e só chama `notifyIfFinished` para `done` e `status`, ignorando `text_delta`/`thinking_delta` sem consultar; avisos antigos sem `type` seguem o caminho de hoje (compatível durante o deploy). Sem mudar o banco, há um paliativo: guardar em memória, por `runId`, o último `seq` já conferido e conferir no máximo uma vez por segundo.
3. No `pump` do SSE, chamar `getRun` só quando a leitura veio vazia e nas voltas do timer de 5 s, nunca logo depois de enviar eventos.
4. Em `notifyIfFinished`, buscar só a última mensagem do assistente com texto (`ORDER BY seq DESC LIMIT 5`), em vez de `loadMessages`.

## Critérios de aceite
- [ ] O aviso de `ai_run_events` traz o tipo do evento.
- [ ] Durante o streaming, cada aviso gera no máximo uma consulta no SSE (`runEvents`).
- [ ] Sem stream aberto, `text_delta` e `thinking_delta` não geram consulta no hub.
- [ ] O aviso "agente concluiu" e o de espera de confirmação continuam saindo como hoje.
- [ ] Os testes de SSE e de aviso de conclusão (`agents.test.ts`, e2e `e2e/tests/agentes.spec.ts`) continuam passando, inclusive a reconexão com `Last-Event-ID`.

## Testes recomendados
- `apps/server/test/agents.test.ts`: um cliente `pg` com `LISTEN ai_run_events` recebe `{"run_id", "seq", "type"}` depois de um `ai_run_event_append` (o pgTAP roda numa transação e não recebe o NOTIFY, por isso o teste fica na integração).
- No mesmo arquivo: espiar `conversations.getRun` (ou contar as consultas por um `db` instrumentado) durante um SSE com várias deltas e conferir que não cresce com o número de deltas; espiar `db.execute` do hub numa execução sem stream e conferir que só os eventos terminais consultam o banco.

## Limitações e suposições
Nada foi executado. As contagens são da leitura do código; o ganho real depende do volume de uso, do custo por consulta e do número de réplicas de produção, que não medi.

## Análise (triagem)

## Resolução (executor)
