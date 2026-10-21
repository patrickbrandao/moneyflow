---
status: concluida
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: alta
criada: 2026-10-21
commit:
---

# Anotações e lembretes no banco (F21)

## Descrição
As seções "Banco", "Anotação", "Lembrete" e "Disparo no servidor" da spec [035](../docs/035-anotacoes.md): `notes` (autor, tipo, escopo privada/global, título, corpo markdown, data, `object_type` + `object_id` com a checagem de existência — hoje só `entity` —, arquivada), `note_reminders` (1:1 com a nota do tipo lembrete: horário, repetição `once`/`daily`/`every_n_days`/`monthly_day`, início e fim, som, segundos, Telegram, ativo, `next_fire_at` e a função que calcula o próximo disparo no fuso de São Paulo, dia N inexistente no mês = último dia), `note_reminder_firings` (dedup por lembrete + horário previsto, `read_at`, `snoozed_until`, adiamentos, disparado em), as preferências do usuário (som e segundos padrão) e o que o worker precisa para disparar com dedup (claim dos vencidos; o disparo perdido uma vez só; os adiados vencidos). Tipos novos de notificação (`note_reminder`) e de evento de mensagem, se houver lista fechada no banco. Auditoria nas tabelas novas, permissões do `moneyflow_app`, `schema.sql`, a [016](../docs/016-banco-de-dados.md) e o resumo no `docs/INDEX.md`.

Ordem: primeira da F21; a [047](047-anotacoes-na-aplicacao.md) depende desta.

## Como reproduzir
Não se aplica (recurso novo). Pronto: pgTAP passando.

## Análise (triagem)
Designada direto pela sessão principal (spec aprovada pelo usuário em 2026-10-21).

**Executor designado: dba.**

## Resolução (executor)
Migration `database/migrations/0053_notes_and_reminders.sql`, pgTAP `database/tests/0053_notes_and_reminders.sql` (e a lista de tabelas fora da auditoria em `database/tests/0015_audit_log.sql`, com `note_reminder_firings`), `schema.sql` regravado, [016](../docs/016-banco-de-dados.md) e o resumo no `docs/INDEX.md` atualizados. Migration aplicada no banco de desenvolvimento (5432).

**Decisões do banco** (o usuário autorizou decidir sem perguntar):

- **Objeto da nota**: `object_type` (hoje só `entity`) + `object_id`, e a existência é uma **FK real** pela coluna gerada armazenada `entity_id` (`CASE WHEN object_type = 'entity' THEN object_id END`). Entidade inexistente dá `23503 notes_entity_id_fkey`, e a entidade com notas não é excluída (o `deleteOrArchive` arquiva). Um tipo novo = um valor no CHECK e outra coluna gerada com a FK. A coluna gerada não se grava (o catálogo do backup já pula colunas geradas).
- **Excluir = arquivar**: `notes` e `note_reminder_firings` sem DELETE para a aplicação; `note_reminders` com DELETE (mudar o tipo da nota exclui o lembrete, e os disparos vão em CASCADE).
- **No COMMIT**: o lembrete só em nota `reminder` e `notes.note_date` = `note_reminders.starts_on` (a spec diz que a data da nota é o início). O inverso (nota `reminder` sem lembrete) é aceito; o calendário usa a `note_date` dela.
- **`ends_on`** sempre nulo em `once`; horário sem segundos; `sound` como chave `^[a-z0-9][a-z0-9_-]{0,62}$`; corpo até 100 mil, em branco gravado como nulo.
- **Próximo disparo**: funções puras `note_reminder_next_fire`/`note_reminder_prev_fire` (fuso de SP, dia N inexistente = último dia, `once` só no início, nada depois do fim); o trigger recalcula a partir de agora ao criar e ao mudar a regra, a vigência ou o ativo, e ao desarquivar; nulo se desligado, com a nota arquivada ou sem ocorrência futura. Ocorrências perdidas entre o último claim e uma edição não disparam (a edição recalcula a partir de agora).
- **Disparos**: `last_fired_at` além de `fired_at` (o re-disparo do adiamento atualiza só o último; o front toca o som pelos últimos 10 min dele). `snooze_count` mantido pelo banco (+1 a cada `snoozed_until` novo). Lido e adiado não convivem (marcar lido limpa o adiamento). Sem `dedup_key` na tabela: a dedup é o único (`note_id`, `scheduled_for`); para o sino e o Telegram, `note_reminder:<firing_id>:<snooze_count>`.
- **Claim**: `note_reminder_claim(limite)` com `FOR UPDATE SKIP LOCKED` (sem advisory lock próprio, como as tarefas agendadas; o worker pode tomar o dele em volta). Autor inativo ou nota arquivada: avança sem disparar. Adiado de lembrete desligado, nota arquivada ou autor inativo não toca.
- **Calendário no banco, visibilidade pelo parâmetro**: `note_occurrences`/`note_calendar` recebem `p_visible_to` (nulo = todas, o admin; senão o autor informado e as globais), que a aplicação escolhe pelo `Access`, como as caixas dos relatórios. Lembrete pausado continua no calendário (a nota existe; só os disparos param).
- **Preferências**: tabela `user_reminder_settings` (não toca em `users`), som nulo = padrão do sistema, 30 s por padrão; sem linha = os padrões.
- **Notificação e evento**: `note_reminder` em `notifications.kind` e em `message_outbox.event_kind`; **não** em `message_subscriptions` (o Telegram do lembrete vai ao destino pessoal do autor pelo interruptor do lembrete, sem assinatura).
- **Auditoria**: `notes` por `audit_row()`; `note_reminders` no histórico da nota (`record_id = note_id`) sem o avanço do `next_fire_at`; `user_reminder_settings` com `record_id = user_id`; disparos fora (log operacional).

**Verificação**: `make -C database test T=/tests/0053_notes_and_reminders.sql` (203 testes) e o `make -C database test` completo passaram (49 arquivos, 3921 testes), com o down e o up da 0053.

A aplicação (tarefa [047](047-anotacoes-na-aplicacao.md)) precisa regenerar o schema Drizzle (`pnpm db:pull`; `notes.entity_id` é gerada) e pôr `notes`, `note_reminders` (chave `note_id`) e `user_reminder_settings` (chave `user_id`) no catálogo do backup, com `notes` + `note_reminders` no mesmo cluster de checagens no COMMIT.
