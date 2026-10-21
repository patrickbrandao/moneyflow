# 035 — Anotações e lembretes (F21)

Anotações funcionam como notas, post-its e lembretes presos a um objeto do sistema. Hoje esse objeto é sempre uma entidade ([003](003-entidades.md)), e o modelo já está pronto para outros tipos de objeto. O lembrete é a anotação que vira alarme: toca um som na interface administrativa, acende um ícone no topo e fica registrado num log. Decisões da entrevista de 2026-10-21.

## Anotação
- **Tipos**, cada um com a sua cor, sempre por token (`--note-info`, `--note-good`, `--note-bad`, `--note-severe`, `--note-reminder`), nunca hex em componente:

  | Tipo | Chave | Cor |
  |---|---|---|
  | Informação | `info` | azul (o acento da interface) |
  | Nota boa | `good` | verde |
  | Nota ruim | `bad` | laranja |
  | Nota grave | `severe` | vermelha |
  | Lembrete | `reminder` | cinza |

  As cores passam no contraste AA e ficam fora da faixa roxa, como o resto da interface.
- **Conteúdo**:
  - título curto (obrigatório, até 120 caracteres): aparece na tabela, no alarme, no sino e no Telegram;
  - corpo em markdown (opcional), exibido pelo renderizador seguro que já existe (`Markdown`), com as abas bruto/renderizado.
- **Data**: o campo "Data" (`YYYY-MM-DD`, fuso de São Paulo) vem com hoje e pode ser editado, o que permite registrar fatos passados. É a data em que a nota aparece no calendário. No lembrete, quem manda são as ocorrências (veja abaixo).
- **Vínculo**: toda anotação pertence a **exatamente um objeto**, guardado como `object_type` + `object_id`.
  - Hoje `object_type` só aceita `entity`. Um objeto novo depois é um valor a mais no tipo, uma checagem de existência a mais e a aba na tela dele.
  - O banco confere que o objeto existe. Uma entidade arquivada mantém as anotações dela.
- **Autor e escopo**:
  - a anotação é do autor (o usuário que a criou);
  - o escopo é **privada** (padrão) ou **global**, escolhido na guia "Escopo" da janela da anotação;
  - **visibilidade**: o admin global vê todas, sem restrição; os demais veem as próprias e as globais. A regra fica no `Access` (`assertRead`/`assertWrite` da anotação), nunca repetida nos serviços.
- **Edição**:
  - só o autor e o admin editam; para os demais, a nota global é somente leitura;
  - excluir é **arquivar** ([008](008-categorias-auditoria-e-exclusao.md)); a arquivada sai do calendário e da tabela, salvo com o filtro "Arquivadas";
  - toda escrita passa por `withTx` e fica na auditoria.

## Lembrete
- **Horário**: HH:MM no fuso `America/Sao_Paulo`, padrão 09:00.
- **Repetição**:
  - **uma vez**: na data e no horário;
  - **todo dia**;
  - **a cada X dias** (X de 2 a 365), contado a partir do início;
  - **todo dia N do mês** (1–31); nos meses sem esse dia, cai no último dia do mês.
- **Vigência**: data de início (obrigatória, padrão hoje) e de fim (opcional; sem fim, repete para sempre). No "uma vez", vale só o início.
- **No calendário**, o lembrete aparece em cada ocorrência entre o início e o fim, expandida no servidor para o intervalo pedido. A data da anotação é a do início.
- **Quem é alarmado**: **só o autor**, mesmo numa nota global. O escopo muda quem vê, não quem é alarmado.
- **Som e tempo de toque**:
  - em *Minha conta → Lembretes*, o usuário escolhe o som padrão e os segundos padrão do loop (padrão 30 s, de 5 a 600);
  - cada lembrete pode sobrescrever o som e os segundos (nulo = o padrão do usuário);
  - os dois lugares têm o botão "Ouvir".
- **Telegram**: o interruptor "Enviar também no Telegram" (desligado por padrão) manda o disparo pelo destino pessoal do autor ([013](013-mensagens-telegram.md)), pela outbox com `dedup_key`. Se o autor não tem destino pessoal ativo, o interruptor fica desabilitado com a explicação.
- **Desligar sem arquivar**: o interruptor "Ativo" pausa os disparos e mantém a nota.

## Disparo no servidor
- **Quem dispara**: o worker, no laço de mensagens (a cada `MESSAGE_INTERVAL_MS`, antes do consumo da outbox), pela reserva `note_reminder_claim` (`FOR UPDATE SKIP LOCKED`: vários workers não repetem), como as tarefas agendadas ([029](029-fluxos-autonomos.md)).
  - O banco guarda o próximo disparo (`next_fire_at`), recalculado a cada disparo e a cada edição.
  - O worker dispara os lembretes vencidos (`next_fire_at <= agora`) e grava um **disparo** com dedup por (lembrete, horário previsto).
- **O disparo**:
  - entra no **log de lembretes** do autor, como não lido;
  - cria a notificação no **sino** (`note_reminder`, dedup `note_reminder:<disparo>:<adiamentos>`, `ON CONFLICT (user_id, dedup_key) DO NOTHING`), com link para `/notes?note=<id>`;
  - enfileira o Telegram, se ligado, em cada destino Telegram pessoal ativo do autor (mesma dedup, `ON CONFLICT (destination_id, dedup_key) DO NOTHING`); sem destino, só o sino.
  - Tudo na mesma transação da reserva.
- **Disparos perdidos**: com o worker parado, cada lembrete dispara **uma vez** ao voltar (o último horário previsto), sem enfileirar as ocorrências atrasadas uma por uma. O log mostra o horário previsto e o real.
- **Com o navegador fechado**: o disparo fica não lido. No próximo acesso, o ícone acende com o contador, e o som só toca para disparos dos últimos 10 minutos.
- **Adiar**: grava `snoozed_until` no disparo e o worker o dispara de novo nessa hora (mesmo registro, com o contador de adiamentos). O próximo disparo da recorrência não muda.

## Alarme na interface
- **Ícone**: um sino de alarme no canto superior direito, **entre o botão de tema claro/escuro e o ícone dos agentes**.
  - Com disparos não lidos, mostra o contador; enquanto toca, o ícone anima (respeitando `prefers-reduced-motion`).
  - Clicar abre o popover do log: os disparos (cor do tipo, título, entidade, horário previsto), o não lido em destaque, **"Marcar todos como lidos"** e o link para a tela das anotações.
- **Ao tocar**:
  - o som do lembrete toca em loop pelos segundos configurados e para sozinho;
  - o popover abre com o disparo e as ações **Dispensar** (para o som e marca como lido) e **Adiar 5 / 10 / 30 min** (para o som e reagenda);
  - parar o som sem agir deixa o disparo não lido.
- **Chegada do disparo**: não há SSE de notificações; o front sonda `GET /api/note-reminders/firings` — a aba líder a cada 20 s, mesmo em segundo plano (é ela que toca), e as outras a cada 30 s com a aba visível e ao focar — e toca os disparos com `shouldRing` ainda não tocados (a chave disparo + último toque fica no `localStorage`, para outra aba que vire líder não repetir).
- **Várias abas**: uma aba toca. A líder é eleita pelo Web Locks (`navigator.locks`, o lock fica com a aba até ela fechar) e as abas conversam pelo `BroadcastChannel` (a lista de disparos, o toque, o parar e o "mudou" depois de dispensar, adiar ou marcar como lidos); todas mostram o ícone. Dispensar ou adiar numa vale para todas. Sem Web Locks ou sem `BroadcastChannel`, cada aba é líder dela mesma e toca.
- **Autoplay**: o navegador bloqueia som sem interação prévia. Se o `play()` for recusado, o ícone pisca (em todas as abas) com o aviso "Clique para ativar o som do alarme" e o próximo clique, em qualquer aba, toca o som ali pelo tempo que resta.

## Sons
- Ficam em `apps/web/public/sounds/`, em `.mp3` ou `.wav` livres de licença, com um `manifest.json` (`default` e, por som, chave, nome em pt-BR, arquivo e licença/origem).
- Adicionar um som é colocar o arquivo e a linha no manifest; entra no próximo build. O banco guarda só a chave; uma chave que sumiu do manifest cai no som padrão.
- A primeira entrega traz quatro sons curtos (1 a 2 s) e distintos — sino (`bell`, o padrão), bipe (`beep`), carrilhão (`chime`) e digital (`digital`) —, em `.wav` PCM sintetizados pelo projeto (`apps/web/scripts/generate-sounds.mjs`, fora do bundle), de domínio público. Sem codificador MP3 na máquina da entrega, não há `.mp3`; um som em `.mp3` entra do mesmo jeito, pelo manifest.

## Tela Anotações
- **Menu**: "Anotações" no menu principal, logo abaixo de "Contratos", em `/notes` (atalho e "Ir para" da paleta, como os outros).
- **Visão anual** (inicial):
  - 12 mini-meses do ano, com as setas para voltar e avançar o ano e o botão "Hoje";
  - em cada dia, uma **bolinha** por tipo presente, na cor do tipo (até cinco, sem o texto da nota); o tooltip diz quantas de cada tipo;
  - clicar no nome do mês abre a visão mensal;
  - a visão, o ano e o mês ficam na URL (`view`, `year`, `month`), como os tipos filtrados (`kinds`) e a nota aberta (`note`).
- **Visão mensal**: a grade do mês com as bolinhas maiores, as setas de mês e a volta para o ano. A nota não aparece dentro do calendário.
- **Clicar num dia** (nas duas visões) seleciona o dia e filtra a tabela abaixo para ele.
- **Tabela** abaixo do calendário:
  - colunas: data, tipo (bolinha + nome), título, entidade, autor, escopo e, no lembrete, a repetição em texto ("todo dia 10 às 09:00") e o próximo disparo;
  - filtro de período pelo `DateRangeFilter`/`useStoredPeriod` ([004](004-caixas-e-contas.md)), igual às listagens das contas; o dia clicado vira o período;
  - filtros: **tipo** (chips nas cinco cores), **entidade** (busca), **escopo/autor** (minhas, globais; o admin filtra por autor) e **texto** (título e corpo);
  - clicar na linha abre a anotação; "Nova anotação" abre a janela com a data do dia selecionado.
- **Janela da anotação**: guias **Anotação** (tipo, título, entidade, data, corpo), **Lembrete** (só no tipo lembrete: horário, repetição, vigência, som, segundos, Telegram, ativo) e **Escopo** (privada/global, autor e datas de criação e edição).

## Na entidade
- **Aba "Anotações"** na tela da entidade (guias Cadastro e Anotações, `?tab=notes`, com o total do selo): a mesma tabela, presa à entidade, sem o calendário e começando sem período (todas as anotações dela, uma linha por anotação; o filtro de período continua lá), e "Nova anotação" já vinculada a ela.
- **Selo na listagem de entidades**: uma bolinha ao lado do nome com a cor da anotação mais grave visível ao usuário (grave > ruim > informação > boa > lembrete), com o tooltip das contagens. Só anotações não arquivadas.

## Agentes e MCP
- Tools novas em `AGENT_TOOLS` (categoria nova "Anotações") e no `TOOL_HANDLERS`, sobre o mesmo serviço e com o `Access` do usuário; todas expostas no `/mcp` (`mcpExposed`).
  - **Leitura**: `list_notes` (os mesmos filtros da tabela), `get_note`, `note_calendar` (contagem por dia e tipo num intervalo), `list_reminder_firings`.
  - **Escrita, com prévia**: `create_note`, `update_note`, `archive_note`, `snooze_reminder`, `mark_reminders_read`.
- Pela regra da [021](021-kit-de-ferramentas.md), as tools novas não entram sozinhas em kit nenhum.
- O agente cita as notas de uma entidade ao falar dela consultando as tools (`list_notes` com a entidade); nada é injetado no prompt.

## API
Entradas, DTOs e textos em `packages/shared/src/notes.ts` e `t.notes`; serviço `apps/server/src/services/notes.ts`.
- `GET /api/notes` — a tabela: `from`/`to` (juntos; com período, uma linha por ocorrência, o lembrete em cada dia em que ocorre; sem período, uma linha por anotação na data dela), `kinds` (separados por vírgula), `entityId`, `scope` (`all`, `mine` = as minhas, `global` = as globais), `authorId` (só admin), `q` (título e corpo), `archived` (só as arquivadas), `order` (`desc` padrão), `cursor` e `limit` (até 500). Devolve `{ items, nextCursor }`; cada item é a anotação sem o corpo, com `occursOn` e `bodyExcerpt`.
- `POST /api/notes`, `GET/PATCH /api/notes/:id`, `POST /api/notes/:id/archive` e `POST /api/notes/:id/unarchive`. O lembrete vai no campo `reminder` da nota; na edição, só os campos que mudam. Trocar o tipo para lembrete cria o lembrete (com os padrões); trocar para outro tipo o remove.
- `GET /api/notes/calendar?from&to&entityId&kinds` — `[{ day, counts: { tipo: n } }]`, pelo `note_calendar`, com as recorrências expandidas.
- `GET /api/note-reminders/firings?unread&limit` — o log do próprio usuário (não lidos primeiro, depois os recentes): `{ unread, serverTime, items }`, cada disparo com o som e os segundos efetivos e `shouldRing` (não lido, não adiado, nota não arquivada e o último toque nos últimos 10 minutos: o que o front toca). `POST .../firings/:id/dismiss` (lido, sem adiamento), `POST .../firings/:id/snooze` `{ minutes }` (1 a 1440; a tela usa 5, 10 e 30) e `POST .../firings/read-all` `{ firingIds? }` (sem a lista, todos os não lidos). Dispensar e marcar como lido também marcam lidas as notificações do sino daquele disparo.
- `GET/PUT /api/account/reminder-settings` — som e segundos padrão (Minha conta, no padrão das outras rotas de `/api/account`), mais `effectiveSound` e `hasPersonalTelegram` (habilita o "Enviar também no Telegram").
- `GET /api/entities/:id/notes` (a mesma listagem presa à entidade) e o selo `noteBadge` (`{ kind, counts, total }`, ou nulo) em cada entidade da listagem e do detalhe.

## Banco
Pelo dba ([016](016-banco-de-dados.md)):
- `notes`: autor, tipo, escopo, título, corpo, data, `object_type` + `object_id` (checagem de existência por tipo), arquivada, datas.
- `note_reminders` (1:1 com a nota do tipo lembrete): horário, regra (`once`, `daily`, `every_n_days` + n, `monthly_day` + dia), início, fim, som, segundos, Telegram, ativo e `next_fire_at`, com a função que calcula o próximo disparo no fuso de São Paulo.
- `note_reminder_firings`: lembrete, usuário, horário previsto, disparado em, `read_at`, `snoozed_until`, adiamentos e `dedup_key` único por (lembrete, horário previsto).
- Preferências do usuário (som e segundos padrão).
- O lembrete só existe numa nota do tipo `reminder`; o disparo só para o autor.

## Backup
As notas, os lembretes e as preferências entram no catálogo do backup ([019](019-backup-e-restauracao.md)); os disparos (log operacional, como as notificações) ficam fora. A nota leva o vínculo pela chave natural da entidade: na importação, o `object_id` passa pela tradução da FK da coluna gerada `entity_id` (a entidade casada pelo documento aponta para o id deste banco). O lembrete é identificado pela nota (`note_id`) e as preferências pelo usuário (também no recurso Usuários); nota e lembrete entram juntos, no grupo com checagens no COMMIT.

## Testes
- **Integração**:
  - visibilidade: privada, global e admin; edição só do autor e do admin;
  - cálculo do próximo disparo em cada repetição (dia 31 em fevereiro, a cada X dias, fim da vigência);
  - disparo no worker com dedup, o disparo perdido uma vez só, adiar e marcar todos como lidos;
  - sino e Telegram (Bot API falsa) com dedup.
- **pgTAP**: as checagens do vínculo, do tipo e do disparo.
- **Tools**: prévia, execução, permissão negada e o `/mcp`.
- **e2e** (`e2e/tests/anotacoes.spec.ts`): lembretes para o próximo minuto disparados pelo worker, o ícone com o contador e o popover, o autoplay recusado (aviso) e liberado no clique (o `play()` trocado por um dublê), adiar, dispensar e marcar todos; o calendário anual e mensal com as bolinhas, clicar no dia e filtrar a tabela, os chips de tipo, a janela com o lembrete mensal; a aba da entidade e o selo na listagem. As cores dos tipos entram no `tema.spec.ts` (sem roxo, AA no cartão).
