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
- **Quem dispara**: o worker, num laço com advisory lock, como as tarefas agendadas ([029](029-fluxos-autonomos.md)).
  - O banco guarda o próximo disparo (`next_fire_at`), recalculado a cada disparo e a cada edição.
  - O worker dispara os lembretes vencidos (`next_fire_at <= agora`) e grava um **disparo** com dedup por (lembrete, horário previsto).
- **O disparo**:
  - entra no **log de lembretes** do autor, como não lido;
  - cria a notificação no **sino** (`note_reminder`, `ON CONFLICT (user_id, dedup_key) DO NOTHING`), com link para a anotação;
  - enfileira o Telegram, se ligado.
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
- **Chegada do disparo**: o front recebe os disparos pela sondagem que o sino já faz, ou por SSE se houver, sem laço novo por aba.
- **Várias abas**: uma aba toca (coordenação por `BroadcastChannel`, com a eleição da aba líder); todas mostram o ícone. Dispensar ou adiar numa vale para todas.
- **Autoplay**: o navegador bloqueia som sem interação prévia. Se o `play()` for recusado, o ícone pisca com o aviso "Clique para ativar o som do alarme" e o próximo clique libera o áudio.

## Sons
- Ficam em `apps/web/public/sounds/`, em `.mp3` e `.wav` livres de licença, com um `manifest.json` (chave, nome em pt-BR, arquivo).
- Adicionar um som é colocar o arquivo e a linha no manifest; entra no próximo build. O banco guarda só a chave; uma chave que sumiu do manifest cai no som padrão.
- A primeira entrega traz alguns sons curtos e distintos (por exemplo sino, bipe, carrilhão, digital), gerados ou de fonte com licença registrada no manifest.

## Tela Anotações
- **Menu**: "Anotações" no menu principal, logo abaixo de "Contratos", em `/notes` (atalho e "Ir para" da paleta, como os outros).
- **Visão anual** (inicial):
  - 12 mini-meses do ano, com as setas para voltar e avançar o ano e o botão "Hoje";
  - em cada dia, uma **bolinha** por tipo presente, na cor do tipo (até cinco, sem o texto da nota); o tooltip diz quantas de cada tipo;
  - clicar no nome do mês abre a visão mensal.
- **Visão mensal**: a grade do mês com as bolinhas maiores, as setas de mês e a volta para o ano. A nota não aparece dentro do calendário.
- **Clicar num dia** (nas duas visões) seleciona o dia e filtra a tabela abaixo para ele.
- **Tabela** abaixo do calendário:
  - colunas: data, tipo (bolinha + nome), título, entidade, autor, escopo e, no lembrete, a repetição em texto ("todo dia 10 às 09:00") e o próximo disparo;
  - filtro de período pelo `DateRangeFilter`/`useStoredPeriod` ([004](004-caixas-e-contas.md)), igual às listagens das contas; o dia clicado vira o período;
  - filtros: **tipo** (chips nas cinco cores), **entidade** (busca), **escopo/autor** (minhas, globais; o admin filtra por autor) e **texto** (título e corpo);
  - clicar na linha abre a anotação; "Nova anotação" abre a janela com a data do dia selecionado.
- **Janela da anotação**: guias **Anotação** (tipo, título, entidade, data, corpo), **Lembrete** (só no tipo lembrete: horário, repetição, vigência, som, segundos, Telegram, ativo) e **Escopo** (privada/global, autor e datas de criação e edição).

## Na entidade
- **Aba "Anotações"** na tela da entidade: a mesma tabela, presa à entidade, e "Nova anotação" já vinculada a ela.
- **Selo na listagem de entidades**: uma bolinha ao lado do nome com a cor da anotação mais grave visível ao usuário (grave > ruim > informação > boa > lembrete), com o tooltip das contagens. Só anotações não arquivadas.

## Agentes e MCP
- Tools novas em `AGENT_TOOLS` (categoria nova "Anotações") e no `TOOL_HANDLERS`, sobre o mesmo serviço e com o `Access` do usuário; todas expostas no `/mcp` (`mcpExposed`).
  - **Leitura**: `list_notes` (os mesmos filtros da tabela), `get_note`, `note_calendar` (contagem por dia e tipo num intervalo), `list_reminder_firings`.
  - **Escrita, com prévia**: `create_note`, `update_note`, `archive_note`, `snooze_reminder`, `mark_reminders_read`.
- Pela regra da [021](021-kit-de-ferramentas.md), as tools novas não entram sozinhas em kit nenhum.
- O agente cita as notas de uma entidade ao falar dela consultando as tools (`list_notes` com a entidade); nada é injetado no prompt.

## API
- `GET/POST /api/notes`, `GET/PATCH /api/notes/:id`, `POST /api/notes/:id/archive` (e desarquivar).
- `GET /api/notes/calendar?from&to` — bolinhas por dia e tipo, com as recorrências expandidas.
- `GET /api/note-reminders/firings` (não lidos e recentes), `POST /api/note-reminders/firings/:id/dismiss`, `POST /api/note-reminders/firings/:id/snooze`, `POST /api/note-reminders/firings/read-all`.
- `GET/PUT /api/me/reminder-settings` — som e segundos padrão.
- `GET /api/entities/:id/notes` e o selo na listagem de entidades.

## Banco
Pelo dba ([016](016-banco-de-dados.md)):
- `notes`: autor, tipo, escopo, título, corpo, data, `object_type` + `object_id` (checagem de existência por tipo), arquivada, datas.
- `note_reminders` (1:1 com a nota do tipo lembrete): horário, regra (`once`, `daily`, `every_n_days` + n, `monthly_day` + dia), início, fim, som, segundos, Telegram, ativo e `next_fire_at`, com a função que calcula o próximo disparo no fuso de São Paulo.
- `note_reminder_firings`: lembrete, usuário, horário previsto, disparado em, `read_at`, `snoozed_until`, adiamentos e `dedup_key` único por (lembrete, horário previsto).
- Preferências do usuário (som e segundos padrão).
- O lembrete só existe numa nota do tipo `reminder`; o disparo só para o autor.

## Backup
As três tabelas e as preferências entram no catálogo do backup ([019](019-backup-e-restauracao.md)), com o vínculo pela chave natural da entidade.

## Testes
- **Integração**:
  - visibilidade: privada, global e admin; edição só do autor e do admin;
  - cálculo do próximo disparo em cada repetição (dia 31 em fevereiro, a cada X dias, fim da vigência);
  - disparo no worker com dedup, o disparo perdido uma vez só, adiar e marcar todos como lidos;
  - sino e Telegram (Bot API falsa) com dedup.
- **pgTAP**: as checagens do vínculo, do tipo e do disparo.
- **Tools**: prévia, execução, permissão negada e o `/mcp`.
- **e2e**: criar um lembrete para daqui a um minuto, ver o ícone e o popover, dispensar e adiar; o calendário anual e mensal com as bolinhas, clicar no dia e filtrar a tabela; a aba da entidade.
