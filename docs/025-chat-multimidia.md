# 025 — Chat multimídia: imagens, áudios, PDFs e markdown (F11)

O chat dos agentes passa a mostrar e tocar o que é anexado, a gravar áudio e a transcrevê-lo sozinho, e ganha um modo áudio que lê as mensagens em voz alta. Depende das inferências da [024](024-capacidades-dos-provedores.md). Decisões da entrevista de 2026-10-13.

## Anexos aceitos
- **Formatos**, até 20 MB cada (o limite de anexo de hoje):
  - imagens: PNG, JPEG, GIF e WebP;
  - PDF;
  - markdown: `.md`, `text/markdown`;
  - áudio: MP3, M4A/MP4, WAV, OGG/Opus, WebM e FLAC;
  - os demais seguem como hoje: o texto vai ao modelo e o resto vira chip.
- **Imagem e PDF** chegam ao modelo pela regra de visão da [024](024-capacidades-dos-provedores.md): direto, por descrição ou pela camada de texto. Imagem num agente sem visão é recusada ao anexar.
- **Áudio nunca** vai ao modelo de texto, só a transcrição dele.

## Prévia na conversa
- **Imagem**: miniatura na mensagem; clicar abre ampliada, com navegação entre as imagens da conversa e "baixar".
- **PDF**: cartão com a miniatura da 1ª página, o nome e o número de páginas; clicar abre o visualizador pdf.js, o mesmo dos contratos e carregado sob demanda.
- **Markdown**: cartão com o início do texto; abrir mostra o conteúdo renderizado (o renderizador seguro do chat), com a alternância **renderizado / bruto** e "baixar". As respostas do agente já são markdown e não mudam.
- **Áudio**: o player descrito abaixo, com a transcrição embaixo.
- **Outros**: chip de download, como hoje.
- O admin lendo a conversa de outro usuário vê e toca tudo, em somente leitura.

## Gravar áudio
- O botão de microfone no compositor só aparece se o agente tem provedor de áudio→texto. A gravação usa o `MediaRecorder`, em WebM/Opus ou, no Safari, MP4/AAC.
- **Até 10 minutos**: o cronômetro avisa ao chegar a 9 min e para sozinho aos 10.
- Antes de enviar dá para ouvir, descartar e regravar. Sem permissão do microfone, a mensagem explica como liberá-la.
- O áudio gravado vira um anexo como qualquer outro (o mesmo upload).

## Transcrição automática
- **Quando**:
  - todo áudio anexado ou gravado numa conversa cujo agente tem áudio→texto é transcrito **automaticamente**, a partir do upload, em segundo plano (fila do worker);
  - o compositor mostra "Transcrevendo…" e deixa enviar mesmo assim;
  - a execução espera as transcrições pendentes da mensagem antes de chamar o modelo, até `AI_TRANSCRIPTION_TIMEOUT_MS` (120 s).
- **Exibição**: só leitura, **sem edição**. O texto fica anexado ao áudio (derivado `transcription`, [024](024-capacidades-dos-provedores.md)), aparece sob o player e recolhe quando passa de 6 linhas.
- **O que o modelo recebe**: `[Áudio "nome" (m:ss) — transcrição]: <texto>` (sem a duração, sem o `(m:ss)`).
- **Falhas**:
  - a falha mostra "Falha na transcrição" com o botão "Tentar de novo", e o modelo recebe `[Áudio "nome" sem transcrição]`;
  - num agente sem áudio→texto, o áudio anexado fica como arquivo, com o aviso "sem transcrição: o agente não converte áudio".
- Transcrever no upload gasta transcrição mesmo com áudio que nunca é enviado (aceito: o usuário vê o texto antes de mandar).
- A transcrição usa o idioma `pt` como dica e grava uso e requisição com a finalidade `transcription`.

## Player de áudio
- Tem play/pausa, a barra de progresso (arrastar e clicar), o tempo atual e o total, e as velocidades **0.5x, 1x (padrão), 1.5x, 2x, 2.5x e 3x**.
- A velocidade escolhida fica como preferência do navegador (`localStorage`, `moneyflow:audio-rate`) e vale para os próximos áudios.
- Um áudio tocando pausa o que estava tocando antes.
- O mesmo componente toca os anexos de áudio e o modo áudio.

## Modo áudio
- Um ícone (fone) no cabeçalho da janela do agente e do painel lateral liga e desliga o **modo áudio**. Fica **desligado por padrão** e aparece só se o agente tem provedor de texto→áudio. O estado fica por janela, no `localStorage` da UI dos agentes.
- **Ligado**:
  - cada mensagem de texto (do usuário e do agente) mostra o ícone de **play**;
  - clicar gera o áudio da mensagem com o provedor, o modelo e a voz de texto→áudio do agente, e toca no player com as velocidades acima.
- **Geração**:
  - o áudio gerado fica guardado como anexo derivado (`speech`) da mensagem e não é gerado de novo para a mesma voz e modelo;
  - antes de virar fala, o markdown vira texto corrido: tabelas e blocos de código viram "tabela omitida" e "código omitido", e os links ficam só com o texto;
  - texto longo é dividido no limite do provedor (4096 caracteres na OpenAI), em trechos tocados em sequência.
- Nada é gerado sem o clique.
- Uso e requisição com a finalidade `speech`.

## Banco (dba)
- A tabela de derivados (inclusive a origem por mensagem do áudio gerado e a fila da transcrição) e as finalidades vêm da [024](024-capacidades-dos-provedores.md).
- **Duração e páginas**: `attachments` (o anexo, que existe desde o upload) ganha `duration_ms` (áudio) e `page_count` (PDF), opcionais, preenchidos pela aplicação. O banco exige o tipo: a duração só com `mime_type` `audio/*` ou `video/*` (1 ms a 24 h; o Safari às vezes grava `video/mp4`), as páginas só com `application/pdf` (1 a 100 mil). Por isso a aplicação normaliza o tipo antes de gravar: com `application/octet-stream`, a duração seria recusada (`attachments_duration_ms_check` e `attachments_page_count_check`, traduzidos).
- **Atribuição**: o derivado tem `conversation_id` (a conversa em que a transcrição foi pedida, `ON DELETE SET NULL`). É dela que o worker tira o usuário e o agente do uso e da requisição; excluir a conversa deixa o cache do anexo.
- **Fila da transcrição** (migration 0042), só no `kind = 'transcription'`:
  - `ai_transcription_enqueue(anexo, provedor, modelo, conversa)` insere `pending` ou devolve a linha que já existe para o anexo, o provedor e o modelo (`done` = cache);
  - `ai_transcription_claim(limite, reserva_velha = 10 min, tentativas = 3)` reserva com `FOR UPDATE SKIP LOCKED` (`running`, `locked_at`, `lock_token` novo, tentativas + 1) e retoma a reserva mais velha que o prazo (o worker caiu); sem tentativas restantes, a linha vira `failed`;
  - `ai_transcription_credentials(id, lock_token)` dá a chave só a quem tem a reserva (`42501` = provedor, dono ou agente inativo; `23514` = reserva perdida);
  - `ai_transcription_complete` e `ai_transcription_fail` exigem a cerca (`false` = reserva perdida: o resultado é descartado);
  - a **falha é definitiva**: as novas tentativas de HTTP já ficaram no adaptador ([023](023-requisicoes-ao-provedor.md)). Voltar à fila é só pelo "Tentar de novo";
  - `ai_transcription_retry(id)` ("Tentar de novo") volta `failed` → `pending` com as **tentativas zeradas** e sem erro; nos outros estados não muda nada (`P0002` = inexistente, 404).
- **Áudio gerado**: o derivado `speech` (mensagem + `block_index`, provedor, modelo e voz) com o áudio em `result_attachment_id`, sem fila; o áudio entra em `attachment_links` como `ai_message_speech` e sai com a conversa.

## Aplicação (app)
- **API**:
  - `POST /api/conversations/:id/attachments` (o upload da conversa): o tipo é normalizado (sinônimos como `audio/x-m4a` viram o canônico; sem tipo, `application/octet-stream` ou `text/plain` de um `.md`, vale a extensão; `video/webm`/`video/mp4` da gravação viram `audio/*`). A duração vem do navegador (`durationMs` na query, medida pelo gravador ou pelos metadados do arquivo) ou, no WAV, do cabeçalho; as páginas do PDF saem do pdf.js no servidor. Com a inferência `transcription` do agente (`ai_capability_credentials`; modelo nulo = não configurada), enfileira a transcrição na mesma transação. Devolve o anexo com a duração, as páginas e a transcrição;
  - `GET /api/conversations/:id` traz os metadados dos anexos das mensagens (`attachments`, com a transcrição mais recente de cada áudio) e o que o agente converte (`media.transcription`, `media.speech`);
  - `GET /api/attachments/:id/derivatives`: transcrição e descrição (o texto do PDF fica de fora), para quem lê o anexo;
  - `POST /api/attachments/:id/transcribe` (tentar de novo): só o dono da conversa (o admin lendo recebe 403). Com a mesma inferência, `ai_transcription_retry`; se o agente agora usa outro provedor ou modelo, é outra transcrição (enfileirada);
  - `POST /api/conversations/:id/messages/:messageId/speech` (gera ou devolve o áudio): `{ parts: [{ blockIndex, attachmentId, characters }] }`, um anexo por trecho, na ordem. A voz é a da inferência (ou `default_models.speech_voice`; sem nenhuma, `alloy`). O admin lendo a conversa de outro usuário ouve só o que o dono já gerou; pedir uma fala ainda não gerada dá 403 (somente leitura). Agente sem texto→áudio: 422 `agent_no_speech`; mensagem sem texto: 422;
  - `GET /api/attachments/:id/download` com `Range` (`bytes=a-b`, `a-` e `-n`: 206 com `Content-Range`; fora do arquivo: 416; sempre `Accept-Ranges: bytes`), para o player poder buscar. O conteúdo vem inteiro do banco a cada pedido (bytea, até 20 MB).
- **Worker**: a fila de transcrições no laço dos agentes (`agents/transcriptions.ts`, até 2 ao mesmo tempo, no ritmo de `AGENT_POLL_MS`): reserva numa transação curta, lê as credenciais com a cerca, chama o provedor pelo invólucro de requisições (idioma `pt`), grava o uso (`transcription`, `audio_seconds`, `request_id`, usuário, agente e conversa da derivada) e conclui na mesma transação; a duração que o navegador não informou vem do provedor.
- **Espera no runner** (`RunAttachments`): para cada áudio da mensagem, a transcrição **mais recente do anexo, de qualquer provedor** (o agente pode ter trocado de inferência), esperando a `pending`/`running` até `AI_TRANSCRIPTION_TIMEOUT_MS` (padrão 120 s; cancelar corta a espera). Sem nenhuma e com áudio→texto no agente (ele ganhou a capacidade depois do upload), a execução enfileira uma. O conteúdo do áudio nem sai do banco: o modelo recebe a transcrição ou `[Áudio "nome" sem transcrição]`.
- **Web** (`apps/web/src/agents/`):
  - `AudioPlayer` (velocidade compartilhada entre os players e um tocando por vez), `AudioRecorder` (`useAudioRecorder`, o botão e a faixa de revisão), `ImageLightbox` (e a camada `MediaDialog` das prévias) e `AttachmentPreview` (as prévias, a transcrição acompanhada enquanto está na fila e o play do modo áudio);
  - `MarkdownDocument` em `Markdown.tsx` (renderizado / bruto);
  - o `PdfViewer` (e o `loadPdf`, também da miniatura) vem dos contratos;
  - o modo áudio fica em `audioMode` da janela, no estado da UI dos agentes (`localStorage`);
  - textos em `i18n/areas/agents-ui.ts` (`media`).

## Testes
- **Integração** (`apps/server/test/chat-media.test.ts`, provedor falso com transcrição e TTS):
  - o upload de áudio gera o derivado `transcription`;
  - a execução espera a transcrição pendente;
  - o modelo recebe o texto e não o áudio;
  - a falha marca `failed`, e o "tentar de novo" funciona;
  - o TTS gera uma vez e reaproveita;
  - o markdown vira texto falado;
  - o agente sem áudio→texto não transcreve;
  - a espera esgotada (o modelo recebe "sem transcrição"), as páginas do PDF, o `Range` do download e o admin lendo em somente leitura.
- **e2e** (`e2e/tests/agentes.spec.ts`, "chat multimídia"):
  - anexar um áudio e ver a transcrição;
  - tocar e trocar a velocidade para 2x;
  - ligar o modo áudio e tocar uma resposta;
  - prévia de imagem e de PDF;
  - markdown com alternância bruto/renderizado.
  - A gravação pelo microfone é testada com o fake media stream do Chromium.
