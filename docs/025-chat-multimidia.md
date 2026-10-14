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
- **O que o modelo recebe**: `[Áudio "nome" (m:ss) — transcrição]: <texto>`.
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
- **Duração**: `attachments` (o anexo, que existe desde o upload) ganha `duration_ms` (áudio) e `page_count` (PDF), opcionais, preenchidos pela aplicação.

## Aplicação (app)
- **API**:
  - o upload da conversa enfileira a transcrição;
  - `GET /api/attachments/:id/derivatives`;
  - `POST /api/attachments/:id/transcribe` (tentar de novo);
  - `POST /api/conversations/:id/messages/:messageId/speech` (gera ou devolve o áudio);
  - `GET` do anexo com `Range`, para o player poder buscar.
- **Worker**: a fila de transcrições (claim com SKIP LOCKED na tabela de derivados `pending`) e a espera no runner.
- **Web**:
  - `AudioPlayer`, `AudioRecorder`, `ImageLightbox` e `AttachmentPreview` em `apps/web/src/agents/`;
  - o `PdfViewer` vem dos contratos;
  - textos em `i18n/areas/agents-ui.ts`.

## Testes
- **Integração** (provedor falso com transcrição e TTS):
  - o upload de áudio gera o derivado `transcription`;
  - a execução espera a transcrição pendente;
  - o modelo recebe o texto e não o áudio;
  - a falha marca `failed`, e o "tentar de novo" funciona;
  - o TTS gera uma vez e reaproveita;
  - o markdown vira texto falado;
  - o agente sem áudio→texto não transcreve.
- **e2e**:
  - anexar um áudio e ver a transcrição;
  - tocar e trocar a velocidade para 2x;
  - ligar o modo áudio e tocar uma resposta;
  - prévia de imagem e de PDF;
  - markdown com alternância bruto/renderizado.
  - A gravação pelo microfone é testada com o fake media stream do Chromium.
