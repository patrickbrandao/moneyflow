---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-10-14
commit:
---

# Prévias, gravação, transcrição, player e modo áudio no chat (F11)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [025](../docs/025-chat-multimidia.md), seção "Aplicação (app)". O que fazer: `AttachmentPreview` (imagem com lightbox, PDF com pdf.js, markdown renderizado/bruto), `AudioRecorder` (até 10 min), transcrição automática em segundo plano (só leitura, o runner espera), `AudioPlayer` com 0.5x–3x lembrado, modo áudio com TTS sob demanda e cache; `Range` no download; testes e e2e.

Ordem: Depois da 024. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [025](../docs/025-chat-multimidia.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **Web** (`apps/web/src/agents/`):
  - `ConversationPane.tsx`;
  - novos: `AudioPlayer`, `AudioRecorder`, `ImageLightbox` e `AttachmentPreview`;
  - `Markdown.tsx`, para a alternância renderizado/bruto;
  - `AgentWindows.tsx` e `AgentSidePanel.tsx`, para o ícone do modo áudio.
- **Reuso**: `components/contracts/PdfViewer.tsx` (pdf.js sob demanda).
- **Textos**: `packages/shared/src/i18n/areas/agents-ui.ts`, e uma função de markdown para texto falado em `packages/shared`.
- **Server**:
  - `routes/agents.ts`: o upload em `/api/conversations/:id/attachments` (l. 50) enfileira a transcrição;
  - `routes/attachments.ts`: `GET /api/attachments/:id/download` (l. 23) ganha `Range`;
  - `runner.ts`: espera as transcrições (`AI_TRANSCRIPTION_TIMEOUT_MS`);
  - `agents/worker.ts`: a fila;
  - a rota do TTS.
- **Provedor falso**: transcrição e TTS (023).
- **Banco**: `pnpm db:pull` depois da 024.

**Riscos e observações**
- O `MediaRecorder` do Safari grava em MP4/AAC.
- O e2e do microfone usa `--use-fake-device-for-media-stream` no Chromium.
- O conteúdo do anexo fica em `bytea`: cada `Range` lê o arquivo inteiro do banco, o que é aceitável até 20 MB.
- Um áudio anexado mas nunca enviado gasta transcrição.

**Dependências**
- Depende da 024 e da 023: inferências, `transcribe`/`speak` e o registro de requisições.

**Como verificar**
- Os testes da 025: derivado, espera, texto em vez do áudio, falha e "tentar de novo", TTS reaproveitado, markdown falado, agente sem áudio→texto.
- Os e2e listados na 025.

**Pontos para a revisão da spec**
1. (025, API) As rotas `/api/agents/attachments/:id/…` e `/api/agents/messages/:id/speech` fogem do padrão atual (`/api/conversations/…`, `/api/attachments/:id/download`). Elas também convivem com as `/api/agents/:agentId/…` da 026. Recomendação: `/api/attachments/:id/derivatives`, `/api/attachments/:id/transcribe` e `/api/conversations/:id/messages/:messageId/speech`.
2. (025, Transcrição) Transcrever "a partir do upload" gasta transcrição com áudio que nunca é enviado. Recomendação: aceitar e registrar na spec.

## Resolução (executor)
Feito pelo app em 2026-10-14 (sem commit; a sessão principal commita). `pnpm db:pull` rodado depois da 0042. Os dois pontos da revisão ficaram como a triagem recomendou e já estavam na spec: as rotas em `/api/attachments/:id/…` e `/api/conversations/:id/messages/:messageId/speech`, e a transcrição a partir do upload (aceita).

**Servidor**
- `services/chat-media.ts` (novo):
  - upload do chat com o tipo normalizado (`chatMime`: sinônimos, a extensão quando vem sem tipo ou como octet-stream, `.md` como `text/markdown`, `video/*` da gravação como `audio/*`), a duração (query `durationMs` do navegador ou o cabeçalho do WAV) e as páginas do PDF (`pdfPageCount`, pdf.js), gravadas no INSERT do anexo;
  - a transcrição enfileirada na mesma transação, com provedor e modelo de `ai_capability_credentials(agente, 'transcription', usuário)` (modelo nulo = não enfileira);
  - `GET /api/attachments/:id/derivatives` (transcrição e descrição; o texto do PDF fica de fora);
  - `POST /api/attachments/:id/transcribe`: só o dono (o admin recebe 403); mesma inferência = `ai_transcription_retry` (`P0002` → 404), outra = enfileira de novo;
  - `POST /api/conversations/:id/messages/:messageId/speech`: o markdown vira texto falado, dividido em 4096; um derivado `speech` por trecho (mensagem + `block_index`, provedor, modelo e voz), já `done` com o áudio em `result_attachment_id` (`ON CONFLICT` com a corrida resolvida); uso `speech` com `characters`, `request_id` e a mensagem. O admin lendo também gera e ouve (o uso fica com ele).
- `GET /api/conversations/:id` ganhou `attachments` (metadados e a transcrição mais recente de cada áudio) e `media` (`transcription`, `speech`).
- `agents/transcriptions.ts` (novo) e o laço em `agents/worker.ts` (até 2 ao mesmo tempo):
  1. `ai_transcription_claim` numa transação curta;
  2. `ai_transcription_credentials` (`42501` → `fail`; `23514`/`P0002` → descarta);
  3. `transcribe()` pelo `request-log.ts`, com `language: 'pt'`;
  4. `ai_usage` com `purpose = 'transcription'`, `audio_seconds`, `request_id`, usuário, agente e conversa;
  5. `ai_transcription_complete` na mesma transação (ou `fail` no erro do provedor). A duração que faltava no anexo vem do provedor.
- `run-attachments.ts`: o áudio espera a transcrição mais recente do anexo, de qualquer provedor, até `AI_TRANSCRIPTION_TIMEOUT_MS` (config nova, padrão 120 s, no `.env.example` e no compose; cancelar corta a espera). Sem nenhuma e com áudio→texto no agente, enfileira. O conteúdo do áudio nem sai do banco: o modelo recebe `[Áudio "nome" (m:ss) — transcrição]: …` ou `[Áudio "nome" sem transcrição]`.
- `routes/attachments.ts`: `Range` no download (`parseRange`: `a-b`, `a-`, `-n`; 206 com `Content-Range`, 416 fora do arquivo, `Accept-Ranges: bytes`).
- `attachments.ts`: `storeAttachment` com `durationMs`/`pageCount`; `assertReadable` exportado e lendo o `ai_message_speech`.
- Erros traduzidos: `attachments_duration_ms_check` e `attachments_page_count_check`; novos `agent_no_speech`, `agent_no_transcription`, `speech_no_text`, `not_audio`.

**Shared**
- `agents/media.ts` (novo): `chatMime`, `isAudioMime`/`isImageMime`/`isPdfMime`/`isMarkdownMime`, `formatDuration`, `markdownToSpeech`, `splitSpeech`, `SPEECH_CHAR_LIMIT`, `AUDIO_RATES`, `AUDIO_RATE_STORAGE_KEY` e os limites da gravação.
- DTOs `ChatAttachmentDto`, `TranscriptionDto`, `AttachmentDerivativeDto` e `MessageSpeechDto`; textos em `agents-ui.ts` (`media`) e `agents.ts`.

**Web** (`apps/web/src/agents/`)
- `AttachmentPreview.tsx`:
  - imagem: miniatura e lightbox com navegação (botões e setas) e "baixar";
  - PDF: cartão com a 1ª página, as páginas e o tamanho, abrindo o `PdfViewer` dos contratos (o `loadPdf` foi exportado para a miniatura);
  - markdown: cartão com o início do texto e o diálogo com `MarkdownDocument` (renderizado/bruto) e "baixar";
  - áudio: o player com a transcrição embaixo (acompanhada enquanto está na fila, "Falha na transcrição" com "Tentar de novo" fora do somente leitura, recolhe acima de 6 linhas, "sem transcrição: o agente não converte áudio");
  - o play do modo áudio (`SpeechButton`).
- `AudioPlayer.tsx`: play/pausa, barra (clicar e arrastar), tempos, 0.5x–3x lembrada em `moneyflow:audio-rate` e compartilhada entre os players, um tocando pausa o outro, vários trechos em sequência.
- `AudioRecorder.tsx`: `MediaRecorder` em WebM/Opus ou MP4/AAC, até 10 min (aviso aos 9, para aos 10), ouvir, descartar, regravar e anexar; mensagem para o microfone bloqueado. O botão só aparece com áudio→texto.
- `ImageLightbox.tsx` com a camada `MediaDialog`; `Markdown.tsx` com `MarkdownDocument`.
- O compositor mostra "Transcrevendo…" no chip do áudio e deixa enviar; o arquivo de áudio anexado manda a duração lida pelo navegador.
- O fone no cabeçalho da janela e do painel (`AgentWindows.tsx`, `PaneHeader`), só com texto→áudio; o estado fica em `audioMode` da janela (`AgentsProvider`).
- Estilos em `styles/agents.css`, só com tokens.

**Testes**
- `apps/server/test/chat-media.test.ts` (novo, 10 casos):
  - upload → derivado, uso e requisição;
  - a execução espera e o modelo recebe o texto, nunca o áudio;
  - espera esgotada;
  - falha, `failed` e "tentar de novo" (o admin recebe 403);
  - agente sem áudio→texto;
  - TTS uma vez e reaproveitado, com o markdown falado;
  - vários trechos e as recusas;
  - PDF com páginas, `Range` e o admin lendo;
  - os erros de duração e páginas traduzidos.
- `packages/shared/test/media.test.ts` (novo): `chatMime`, `formatDuration`, `markdownToSpeech` e `splitSpeech`.
- Provedor falso: `audioQueue` (texto, atraso ou erro HTTP na transcrição), `speechFormat = 'wav'` (fala tocável pelo navegador) e `silentWav()`.
- e2e `agentes.spec.ts`, bloco "chat multimídia (spec 025)", com 3 casos:
  - anexar um áudio, ver "Transcrevendo…" e a transcrição, o modelo recebendo o texto, tocar e trocar para 2x (lembrada), o modo áudio tocando a resposta com a velocidade lembrada, e um player pausando o outro;
  - prévias de imagem (ampliar, navegar, "baixar"), de PDF (cartão e visualizador) e o markdown bruto/renderizado;
  - a gravação com o fake media stream do Chromium (`--use-fake-device-for-media-stream`, ligado no arquivo todo): descartar, regravar, anexar e ver a transcrição.

**Docs**: [025](../docs/025-chat-multimidia.md) (Banco com o que a 024 pediu: `conversation_id`, as funções da fila com 10 min e 3 tentativas, a falha definitiva, o retry que zera as tentativas e o MIME exigido; Aplicação com as rotas, o worker, a espera e os componentes; Testes), [011](../docs/011-agentes-de-ia.md) (F11 entregue), [INDEX](../docs/INDEX.md) e `AGENTS.md`.

**Verificação**
- `pnpm lint`, `pnpm typecheck` e `pnpm build`: ok.
- `pnpm test`: 132 + 162 ok, com `MONEYFLOW_TEST_DATABASE_URL`/`MONEYFLOW_TEST_OWNER_URL` e o `moneyflow_test` recriado e migrado pelo dbmate.
- e2e `agentes.spec.ts`: 13 ok, com a pilha (`TELEGRAM_API_BASE=…18081`), parada no fim.
- Nenhum banco `moneyflow_bk_*` ficou: os 2 que o `backup.test.ts` deixou foram apagados.

**Pendências**
- A gravação no Safari (MP4/AAC) não tem e2e: só o Chromium tem o microfone falso.
- O admin lendo a conversa de outro usuário pode gerar a fala (custo no uso dele). Era o "vê e toca tudo" da spec; se o usuário preferir que o admin só toque o que já existe, basta trocar `loadConversation(…, 'read')` por `'own'` em `messageSpeech`.
- As visões mensais de uso (`ai_usage_monthly_*`) seguem sem somar `audio_seconds`/`characters` (pendência da 023; é do dba se o painel da F14 precisar).
- O `backup.test.ts` deixa bancos `moneyflow_bk_*` no servidor de teste externo. Não é desta tarefa: vale uma tarefa à parte para limpá-los no `afterAll`.
