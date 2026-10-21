---
status: em-andamento
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
