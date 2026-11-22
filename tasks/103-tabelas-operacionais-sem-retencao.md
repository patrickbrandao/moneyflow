---
status: em-andamento
tipo: banco
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit:
---

# Fila, sino, logs operacionais e anexos órfãos crescem sem nenhuma purga

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** desempenho
- **Subcategoria:** retenção de dados operacionais
- **Arquivos afetados:** `database/schema.sql:6864-6890` (`message_outbox`), `database/schema.sql:15203-15221` (`notifications`), `database/schema.sql:15024-15039` (`note_reminder_firings`), `database/schema.sql:15859` (`telegram_pairing_codes`), `database/schema.sql:11612-11627` (`ai_scheduled_task_runs`), `database/schema.sql:11063` (`ai_reconcile_recipe_runs`), `apps/server/src/services/chat-media.ts:192-207`, `apps/server/src/services/attachments.ts:151-158`, `apps/server/src/auth/session.ts:57-59`, `apps/server/src/agents/worker.ts:145-158`, `apps/server/src/services/messages.ts:108-113`, `docs/008-categorias-auditoria-e-exclusao.md:13`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Algumas tabelas guardam para sempre coisas que só servem por pouco tempo: mensagens do Telegram já enviadas, avisos do sino já lidos, códigos de pareamento vencidos e arquivos enviados ao chat que nunca viraram mensagem. O banco e os backups crescem sem parar, e telas como a lista de destinos ficam mais lentas com o tempo.

### Evidência e análise técnica
O único código de limpeza do sistema está em `agents/worker.ts:145-158` (eventos de streaming, confirmações esquecidas, embeddings órfãos, dedup do Telegram, requisições ao provedor e índices de embeddings parados) e em `auth/session.ts:57-59` (sessões vencidas). Fora disso, `rg "DELETE FROM"` em `apps/server/src` não acha purga para:

| Tabela | O que acumula | Ordem de grandeza |
|---|---|---|
| `attachments` sem vínculo | upload do chat antes da mensagem (`chat-media.ts:192-207`) e `upload_file` do `/mcp` (`attachments.ts:151-158`) que nunca foram usados | até 20 MB cada, em `bytea` |
| `message_outbox` | `sent`, `canceled` e `failed`, com o `payload` (resumo diário/semanal em texto) | uma linha por destino e evento, todo dia |
| `notifications` | lidas | uma por evento e usuário |
| `note_reminder_firings` | disparos lidos (`moneyflow_app` nem tem DELETE) | 365 por lembrete diário por ano |
| `telegram_pairing_codes` | vencidos ou usados (vida útil de 10 min) | um por pareamento |
| `ai_scheduled_task_runs`, `ai_reconcile_recipe_runs` | histórico de disparos | um por disparo |
| `sessions` | sessões vencidas por ociosidade (`SESSION_IDLE_HOURS`, tarefa 066) | ficam até `expires_at` (30 dias), porque a purga olha só a validade |

O crescimento da outbox já pesa numa consulta de tela: `listDestinations` (`messages.ts:111-113`) faz, por destino, `max(o.sent_at)` e `count(*) … status = 'failed'` sobre todo o histórico do destino. O índice `message_outbox_destination_id_idx (destination_id, created_at)` não cobre `sent_at` nem `status`, então cada abertura da tela lê o histórico inteiro de cada destino.

O anexo órfão é o item mais pesado: entra no dump e no JSON do backup e nunca sai, porque `deleteConversation` (`conversations.ts:256-265`) só apaga os anexos ligados às mensagens da conversa.

`audit_log`, `ai_messages`, `ai_runs` e `ai_usage` também só crescem, mas por decisão: "Sem retenção por enquanto" (`docs/008:13`), e o histórico das conversas e o uso alimentam telas e orçamentos. Para essas, o pedido é só preparar a medição (tamanho por tabela no painel do admin ou num `make` de diagnóstico) e registrar o plano: particionar `audit_log` por mês quando passar de alguns milhões de linhas.

### Verificação (tentativa de refutação)
- Procurei purga no banco (`*_purge`, `DELETE` em funções) e na aplicação: só as citadas acima.
- As specs 013, 025, 029, 030 e 035 não definem retenção para essas tabelas, nem dizem que o histórico é eterno. A 023 define a das requisições, e a 029 a dos `update_id` (7 dias), o que mostra que o padrão do projeto é ter prazo.
- A dedup não impede purgar, mas limita o prazo: a chave da outbox e do sino precisa sobreviver à janela em que o produtor pode gerar o mesmo evento de novo. Hoje o maior olhar para trás é o `contract_charge_missing`, de 120 dias (`contract-worker.ts:43`); os lembretes de vencimento e os resumos levam a data na chave.

### Impacto
Crescimento contínuo do volume e do tempo de backup e restauração, e lentidão progressiva da lista de destinos. Afeta todas as instalações, aos poucos.

## Como reproduzir
1. Envie um áudio ou PDF ao chat e feche a janela sem mandar a mensagem. `SELECT count(*) FROM attachments a WHERE NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id)` cresce e não volta.
2. Com um destino assinando `daily_summary`, espere alguns dias: `SELECT status, count(*) FROM message_outbox GROUP BY 1` só cresce.
3. `EXPLAIN ANALYZE` da consulta de `listDestinations`: o custo acompanha o tamanho de `message_outbox`.

## Solução proposta
1. dba: uma função `operational_purge(…)` (ou uma por tabela, no padrão de `ai_requests_purge`: `SECURITY DEFINER` quando o app não tem DELETE, lote com `LIMIT` e `FOR UPDATE SKIP LOCKED`, devolve quantas linhas apagou), com prazos mínimos conferidos:
   - anexos sem vínculo em `attachment_links` criados há mais de 7 dias;
   - `message_outbox` em `sent`/`canceled`/`failed` com mais de 180 dias (acima dos 120 do `contract_charge_missing`);
   - `notifications` lidas com mais de 180 dias;
   - `note_reminder_firings` lidas com mais de 180 dias;
   - `telegram_pairing_codes` vencidos ou usados há mais de 1 dia;
   - `ai_scheduled_task_runs` e `ai_reconcile_recipe_runs` finais com mais de 1 ano.
2. dba: índice parcial `message_outbox (destination_id, sent_at DESC) WHERE status = 'sent'` e `(destination_id) WHERE status = 'failed'` para a lista de destinos (ou a aplicação muda a consulta, ver abaixo).
3. app: chamar as purgas no laço de manutenção, em transações separadas das já existentes; prazos em `app_settings` se o produto quiser ajustá-los. `purgeExpiredSessions` também apaga as ociosas além de `SESSION_IDLE_HOURS`.
4. Atualizar `docs/016` (seção de cada tabela) e as specs 013, 025 e 035 com os prazos.

## Critérios de aceite
- [ ] Cada tabela da lista tem prazo documentado e é purgada pelo worker, em lotes.
- [ ] Anexo sem vínculo com mais de 7 dias é apagado; anexo ligado (inclusive por `statement_imports`, `nfe_documents`, `contract_documents` e pelo áudio gerado) nunca é.
- [ ] A dedup da outbox e do sino continua valendo dentro dos prazos (nenhum evento repetido em 120 dias).
- [ ] `listDestinations` não lê o histórico inteiro da outbox.

## Testes recomendados
- pgTAP novo (`database/tests/00NN_operational_purge.sql`): cada purga apaga só o que passou do prazo e do estado certo, respeita o limite e devolve a contagem; anexo ligado por cada tipo de vínculo de `attachment_links` fica.
- `apps/server/test/agents.test.ts` (ou um `test/maintenance.test.ts`): o laço de manutenção chama as purgas e um anexo de chat não enviado some depois do prazo (com o relógio do banco ajustado na fixture).

## Limitações e suposições
Nada foi executado. Os prazos propostos são sugestões e precisam da decisão do usuário. Não medi o tamanho real das tabelas em produção.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado no banco:
- nenhuma função de purga para `attachments` sem vínculo, `message_outbox`, `notifications`, `note_reminder_firings`, `telegram_pairing_codes`, `ai_scheduled_task_runs` e `ai_reconcile_recipe_runs`;
- `moneyflow_app` não tem DELETE em `note_reminder_firings` nem em `ai_reconcile_recipe_runs`;
- nenhuma FK aponta para essas tabelas;
- `message_outbox_destination_id_idx (destination_id, created_at)` não serve ao `max(sent_at)` nem à contagem de `failed` da lista de destinos.

Toda FK para `attachments` aparece em `attachment_links`, menos `ai_attachment_derivatives.attachment_id`, que é a origem de um cache. O pgTAP novo confere isso.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0070_operational_purge.sql`; teste `database/tests/0070_operational_purge.sql`.

Função nova `operational_purge(p_limit integer DEFAULT 1000) RETURNS TABLE (target text, deleted integer)`:
- `SECURITY DEFINER`, com `EXECUTE` para a aplicação;
- limite de 1 a 100000; fora disso, `22023`;
- para cada tabela, apaga até o limite, as mais velhas primeiro, pulando as travadas;
- devolve uma linha por tabela, nesta ordem: `attachments`, `message_outbox`, `notifications`, `note_reminder_firings`, `telegram_pairing_codes`, `ai_scheduled_task_runs`, `ai_reconcile_recipe_runs`.

Prazos (decisão: os sugeridos pela tarefa, fixos no banco e acima da janela de dedup de 120 dias):

| Tabela | Sai |
|---|---|
| `attachments` | sem vínculo em `attachment_links`, criado há mais de 7 dias |
| `message_outbox` | `sent`/`canceled`/`failed` criada há mais de 180 dias |
| `notifications` | lida, criada há mais de 180 dias (não lida fica) |
| `note_reminder_firings` | lido, com o último disparo há mais de 180 dias |
| `telegram_pairing_codes` | usado ou vencido há mais de 1 dia |
| `ai_scheduled_task_runs` | criado há mais de 1 ano |
| `ai_reconcile_recipe_runs` | `completed`/`skipped`/`failed` terminado há mais de 1 ano |

Mudar um prazo é uma migration. Não há `app_settings`, porque a dedup depende deles.

- Anexo órfão:
  - os candidatos são travados (`FOR UPDATE OF a SKIP LOCKED`) e apagados num segundo comando, com snapshot novo, só se continuarem sem vínculo. Um vínculo criado ao mesmo tempo espera a trava e falha na FK, e o anexo nunca sai em CASCADE;
  - a transcrição de um áudio órfão sai junto;
  - a exclusão é auditada.
- Índices parciais novos para a lista de destinos:
  - `message_outbox_destination_sent_idx (destination_id, sent_at) WHERE sent_at IS NOT NULL`;
  - `message_outbox_destination_failed_idx (destination_id) WHERE status = 'failed'`.

  A consulta atual de `listDestinations` já os usa sem mudança: o `max(sent_at)` vira, no planner, uma busca com `sent_at IS NOT NULL`. O pgTAP confere os dois planos.
- Medição: `make -C database sizes` (`DB=<banco>` mede outro) mostra as 30 maiores tabelas, com o total, o heap, os índices e o TOAST, e as linhas estimadas.
  - `audit_log`, `ai_messages`, `ai_runs` e `ai_usage` seguem sem retenção (docs/008).
  - O plano registrado na `docs/016`: particionar `audit_log` por mês quando passar de alguns milhões de linhas.

Testes:
- a função e os índices, e os parâmetros;
- `attachment_links` cobre todas as FKs para `attachments`;
- a aplicação sem DELETE nos disparos, e a purga como a aplicação:
  - com limite 1, uma linha por tabela;
  - depois, o resto;
  - depois, zero;
- o que fica em cada tabela:
  - os anexos ligados por título, baixa, movimento, entidade, compra e mensagem;
  - o anexo órfão recente;
  - a outbox pendente e a enviada recente;
  - a notificação não lida e a lida recente;
  - o disparo não lido;
  - o código vencido recente e o válido;
  - o disparo de tarefa recente;
  - a receita em andamento e a recente;
- a auditoria da exclusão dos anexos como `system`;
- o plano das duas subconsultas da lista de destinos.

Verificação:
- `make test T=/tests/0070_operational_purge.sql` passou, com o down da 0070.
- `docs/016` (Retenção operacional) e `database/AGENTS.md` (`make sizes`) atualizados. `make dump` rodado.

### Pendente na aplicação

1. `pnpm db:pull`. Só função e índices.
2. `apps/server/src/agents/worker.ts`, no laço de manutenção, numa transação própria sem `app.user_id` (a exclusão dos anexos sai como `system`):
   - `SELECT target, deleted FROM operational_purge(1000)`;
   - repetir enquanto alguma linha devolver `deleted = 1000`, com um teto de rodadas por passada;
   - registrar no log as contagens diferentes de zero.

   Basta uma vez por hora, porque os prazos são de dias.
3. `apps/server/src/auth/session.ts` (`purgeExpiredSessions`): apagar também as sessões ociosas além de `SESSION_IDLE_HOURS`, `last_seen_at < now() - make_interval(hours => idleHours)` quando `idleHours > 0`. A aplicação já tem DELETE em `sessions`, então não precisa do banco.
4. `listDestinations` (`services/messages.ts`): nada obrigatório, porque os índices novos já servem à consulta de hoje. Não troque `max(o.sent_at)` por outra forma sem conferir o plano.
5. Testes: um `test/maintenance.test.ts`, ou o `describe` da manutenção em `agents.test.ts`, com um anexo de chat não enviado e `created_at` ajustado para 8 dias atrás, que some depois da manutenção, e um ligado a uma mensagem, que fica.
6. Specs: registrar os prazos na 013 (outbox e sino), na 025 (o upload do chat não enviado some em 7 dias), na 029 (códigos de pareamento e disparos das tarefas), na 030 (histórico das receitas por 1 ano) e na 035 (log dos disparos lidos por 180 dias).
