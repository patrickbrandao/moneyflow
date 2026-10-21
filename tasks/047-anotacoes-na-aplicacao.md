---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: alta
criada: 2026-10-21
commit: daa692a, dda1d02
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

### Parte servidor (concluída)

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

### Parte web e e2e (concluída)

**O que entrou**
- Cores `--note-info` (= `--accent-soft`, o azul do acento), `--note-good`, `--note-bad` (laranja), `--note-severe` e `--note-reminder` (cinza) nos dois temas em `styles/tokens.css`, todas com 4,5:1 ou mais sobre o cartão e fora da faixa roxa (conferido no `tema.spec.ts`, que ganhou as cinco); componentes só por `var(--note-<tipo>)`. Textos novos em `t.notes.ui` e `t.notes.alarm` (shared), `t.nav.notes` e `t.palette.newNote`.
- Sons: `apps/web/public/sounds/manifest.json` (`default` e, por som, chave, nome, arquivo e licença) com `bell`, `beep`, `chime` e `digital` em WAV PCM 16 bits mono de 1 a 2 s, sintetizados por `apps/web/scripts/generate-sounds.mjs` (fora do bundle), domínio público. `components/notes/sounds.ts` lê o manifest (chave ausente cai no padrão) e faz o "Ouvir".
- Alarme `components/notes/ReminderAlarm.tsx` no `Layout`, entre o tema e os agentes: contador, animação enquanto toca (desligada com `prefers-reduced-motion`), popover com a cor do tipo, título (leva a `/notes?note=`), entidade, horário previsto, adiado até/quantas vezes, não lido em destaque, Dispensar, Adiar 5/10/30, Parar o som, Marcar todos como lidos e o link para `/notes`.
- Tela `/notes` (`pages/NotesPage.tsx`, menu abaixo de Contratos, atalho `g n`, "Nova anotação" na paleta) com `components/notes/NotesBrowser.tsx` (calendário, filtros e tabela), `NoteCalendar.tsx` (anual com 12 mini-meses e mensal, setas, Hoje, voltar ao ano, legenda, bolinhas por tipo com as contagens no tooltip, sem o texto da nota) e `NoteModal.tsx` (guias Anotação, Lembrete e Escopo; somente leitura sem `canEdit` ou arquivada; arquivar/desarquivar).
- Entidade: guias Cadastro e Anotações na `EntityPage` (`?tab=notes`, contagem do selo) e o selo `NoteBadgeDot` ao lado do nome na listagem de entidades e no título da ficha.
- Minha conta → Lembretes (`components/account/ReminderSettingsPanel.tsx`): som padrão com "Ouvir" e segundos padrão.
- e2e `e2e/tests/anotacoes.spec.ts` (2 testes).

**Decisões**
- Uma aba toca: a líder é eleita pelo Web Locks (`navigator.locks`, o lock fica com a aba até ela fechar), e o `BroadcastChannel` `moneyflow:reminders` leva a lista, o toque, o parar e o "mudou". Sem Web Locks ou sem `BroadcastChannel`, cada aba é líder e toca (o fallback pedido). A líder sonda a cada 20 s mesmo em segundo plano (é ela que toca); as outras a cada 30 s com a aba visível; todas ao focar. "Já tocado" é a chave disparo + `lastFiredAt` no `localStorage` (o re-disparo de um adiamento toca de novo; outra aba que vire líder não repete).
- O som para quando nenhum disparo que está tocando continua com `shouldRing` (dispensado, adiado ou lido em qualquer aba), no fim dos segundos, ou por "Parar o som" (deixa não lido). Com vários disparos juntos, toca o som e os segundos do mais recente.
- Autoplay recusado: o aviso aparece em todas as abas e o próximo clique, em qualquer uma, toca ali pelo tempo que resta.
- O dia clicado vira o período do `DateRangeFilter` (from = to = dia) e fica destacado; o calendário filtra pela entidade e pelos tipos escolhidos (escopo e autor não entram, como na API). Visão, ano, mês, tipos e a nota aberta ficam na URL; o período é o lembrado por `useStoredPeriod('notes')`.
- Na guia da entidade, a tabela começa sem período (todas as anotações dela, uma linha por anotação) e sem o calendário; o filtro de período continua disponível.
- No lembrete, o "Início" é a própria data da anotação (um campo só, editável nas duas guias); "Enviar também no Telegram" fica desabilitado sem destino pessoal (`hasPersonalTelegram`), com a explicação.
- Sem codificador MP3 nesta máquina (só o `afconvert`, que não gera MP3): todos os sons em `.wav`; a spec 035 foi ajustada ("`.mp3` ou `.wav`").
- Clicar na linha da tabela abre a anotação; só o link da entidade não propaga o clique.

**Verificação**
- `pnpm typecheck` (todos os pacotes) e Biome nos arquivos alterados ok; `pnpm test:unit` (178) ok.
- `pnpm verify:quick`: typecheck, testes do shared, integração e pgTAP ok; o lint falha só pelo `tmp/` não rastreado (configuração Biome aninhada), como na parte servidor.
- e2e contra os servidores de dev (`E2E_BASE_URL=http://localhost:5174`, com `pnpm dev:worker` e `MESSAGE_INTERVAL_MS=5000`): `anotacoes.spec.ts` (2), `tema.spec.ts` (3), `tags`, `fluxo-principal` e `cnpj-alfanumerico` passam. Telas conferidas por screenshot em claro e escuro, em 1280 px e 390 px.
- Não verificado: `pnpm verify:full` (build, suíte inteira com Testcontainers e o e2e inteiro na pilha Docker), o som de verdade num navegador (o e2e usa um dublê do `play()`), duas abas reais disputando a liderança e o alarme com `MESSAGE_INTERVAL_MS` padrão (30 s; o teste tem folga de 150 s para isso).
