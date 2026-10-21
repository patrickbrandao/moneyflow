---
status: em-andamento
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: alta
criada: 2026-10-21
commit:
---

# Anotações e lembretes na aplicação (F21)

## Descrição
Todo o resto da spec [035](../docs/035-anotacoes.md): serviço e rotas (`Access` com a visibilidade privada/global/admin, edição só do autor e do admin, `withTx`), laço do worker que dispara os lembretes (log, sino `note_reminder`, Telegram opcional pelo destino pessoal do autor, adiar), tools dos agentes (categoria "Anotações", expostas no `/mcp`, prévia nas escritas, sem entrar em kit nenhum), backup, tela `/notes` (menu abaixo de Contratos, calendário anual e mensal com bolinhas, tabela com `DateRangeFilter` e filtros de tipo, entidade, escopo/autor e texto, janela com as guias Anotação, Lembrete e Escopo), aba Anotações e selo na entidade, Minha conta → Lembretes, ícone do alarme entre o tema e os agentes com o popover (dispensar, adiar, marcar todos como lidos), sons em `apps/web/public/sounds` com manifest, uma aba toca (`BroadcastChannel`) e o aviso de autoplay; testes de integração, das tools e e2e.

Ordem: depois da [046](046-anotacoes-no-banco.md).

## Como reproduzir
Não se aplica (recurso novo).

## Análise (triagem)
Designada direto pela sessão principal (spec aprovada pelo usuário em 2026-10-21).

**Executor designado: app.**

## Resolução (executor)

### Parte servidor (concluída; falta a parte web e o e2e)

**O que entrou**
- `pnpm db:pull` com a 0053; o `postpull.mjs` passou a recompor o default "hoje em São Paulo" (`((now() AT TIME ZONE 'America/Sao_Paulo'))::date`), que o drizzle-kit cortava. `notes.entity_id` (gerada) nunca é gravada.
- Shared: `packages/shared/src/notes.ts` (tipos, escopos, repetições, `REMINDER_SOUNDS` = bell/beep/chime/digital e `DEFAULT_REMINDER_SOUND` = bell, `DEFAULT_RING_SECONDS`, `SNOOZE_PRESETS`, `NOTE_RING_WINDOW_MS`, entradas Zod, DTOs, `describeReminder`, `normalizeReminder`, `noteBadge`), textos em `t.notes` (`i18n/areas/notes.ts`), `noteReminderMessage` em `messages.ts`, `note_reminder` em `NotificationKind` e no rótulo do sino, mensagens das constraints novas em `i18n/errors.ts`, `noteBadge` no `EntitySummary`.
- Servidor: `Access.canReadNote/canWriteNote/assertReadNote/assertWriteNote/noteVisibleTo`; serviço `services/notes.ts`; worker `services/note-worker.ts` chamado no `messageTick`; rotas `routes/notes.ts`; tools `agents/tool-handlers-notes.ts` + `packages/shared/src/agents/tools-notes.ts` (categoria nova `notes`, "Anotações"); backup (`notes`/`note_reminders` no cluster do COMMIT, chaves `note_reminders.note_id` e `user_reminder_settings.user_id`, disparos fora, preferências também no recurso Usuários).
- Testes: `apps/server/test/notes.test.ts` (10 casos), o caso de anotações em `test/backup.test.ts`, `packages/shared/test/notes.test.ts`.

**Decisões**
- Rotas adaptadas ao padrão do projeto: desarquivar é `POST /api/notes/:id/unarchive`; as preferências ficam em `/api/account/reminder-settings` (como as outras de Minha conta), não em `/api/me`.
- Listagem: com `from`/`to`, uma linha por ocorrência (`note_occurrences`); sem período, uma linha por nota na data dela. `archived=1` = só as arquivadas. Cursor (dia, id) na ordem pedida (`desc` padrão). O item não traz o corpo inteiro (`bodyExcerpt`, 300 caracteres); o `GET /api/notes/:id` traz.
- Calendário pelo `note_calendar` com `p_visible_to` do Access; filtra `entityId` e `kinds` (escopo e autor não entram nas bolinhas).
- Selo da entidade no próprio DTO da listagem (e do detalhe) de entidades: `noteBadge` `{ kind, counts, total }` ou nulo, só não arquivadas visíveis.
- Som: a validação confere o formato da chave (o mesmo do banco), não a lista `REMINDER_SOUNDS`, para que um som novo seja só o arquivo e a linha no manifest (spec); a constante fica para o front e as tools.
- Front sabe o que tocar por `shouldRing` em `GET /api/note-reminders/firings` (não lido, não adiado, nota não arquivada e último toque < 10 min), com `serverTime`; não há SSE de notificações (o sino sonda a cada 60 s).
- Telegram: todos os destinos Telegram pessoais ativos do autor (normalmente um), dedup `note_reminder:<disparo>:<adiamentos>`; sem destino, só o sino. O link usa `APP_URL` (`config.publicUrl`), como as outras mensagens.
- Dispensar e marcar como lido também marcam lidas as notificações do sino daquele disparo (`data.firingId`). Adiar deixa o disparo não lido; antecipar `snoozed_until` à mão conta como novo adiamento (o contador é do banco).
- Trocar o tipo para lembrete cria o lembrete com os padrões (uma vez, 09:00, início = data da nota); de lembrete para outro tipo, remove (os disparos somem junto, pelo CASCADE).
- Única mudança em `apps/web`: o ícone `note_reminder` no mapa do sino (`components/shell/Notifications.tsx`), exigido pelo typecheck do `Record<NotificationKind, …>`. O e2e não precisou mudar (a contagem do kit é só da Conciliação).

**Verificação**: `pnpm --filter @moneyflow/server test:local` (suíte de integração toda, 253 testes) e `pnpm verify:quick -- test/notes.test.ts` com typecheck, testes do shared, integração e pgTAP ok; o lint do `verify:quick` falha só pelo `tmp/` não rastreado (configuração Biome aninhada), e o Biome nos arquivos alterados passa.
