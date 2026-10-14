---
status: aberta
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
