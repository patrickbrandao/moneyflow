# 023 — Requisições ao provedor e detalhe do provedor (F9)

Registro de tudo o que é enviado ao provedor de IA e recebido dele, as retentativas feitas pelo próprio MoneyFlow e uma tela de detalhe por provedor. Decisões da entrevista de 2026-10-13.

## O que é registrado
- **Toda** chamada a um provedor gera uma requisição em `ai_requests`:
  - chat, título e fluxos;
  - embeddings, descrição de imagem/PDF, transcrição e TTS ([024](024-capacidades-dos-provedores.md), [025](025-chat-multimidia.md));
  - testar conexão e listar modelos.
- Cada requisição guarda a **operação** (`chat|title|embedding|vision_describe|transcription|speech|test_connection|list_models`) e a **finalidade** (o vocabulário de `ai_usage.purpose`; nula em `test_connection` e `list_models`), além de provedor, agente, usuário, conversa, execução, modelo, método e caminho (sem o host quando é o `base_url` do provedor) e se houve streaming.
- **Metadados, sempre**, com o registro ligado ou não:
  - status final (`ok|error|canceled`), status HTTP e mensagem de erro segura;
  - início, fim, duração e tempo até o primeiro byte;
  - tokens (os mesmos de `ai_usage`, que passa a apontar para a requisição) e o número de tentativas.
- **Corpos, só com o registro ligado no provedor**: a flag `log_bodies`, desligada por padrão, ao ser ligada abre um aviso de que as requisições levam o conteúdo das conversas e dados financeiros. Com ela ligada, ficam gravados:
  - o corpo enviado, **completo, inclusive o base64** de imagens, PDFs e áudios;
  - os cabeçalhos enviados e recebidos;
  - a resposta montada (JSON final);
  - no streaming, o stream bruto como foi recebido (texto SSE).
  - Os corpos ficam em `text`, comprimidos pelo TOAST, com o tamanho em bytes.
- **Segredos nunca**:
  - nos cabeçalhos, os valores de `Authorization`, `x-api-key`, `api-key`, `openai-organization` e `anthropic-*` de credencial são trocados por `[omitido]`;
  - os segredos das tools ([027](027-tools-de-controle-total.md)) nunca passam pelo modelo: são digitados pelo usuário no cartão de aprovação e vão direto ao serviço.
  - A chave do provedor nunca está no corpo.

## Tentativas
- O retry interno dos SDKs fica desligado (`maxRetries: 0`), e o MoneyFlow faz as próprias tentativas: até `AI_REQUEST_MAX_ATTEMPTS` (padrão 3).
  - **Erros que repetem**: 408, 409, 429, 5xx, 529 (sobrecarga), erro de rede e timeout.
  - **Espera**: backoff de 1 s, 2 s e 4 s com jitter, ou o `retry-after` informado (até 60 s).
  - Cancelar a execução interrompe a espera.
- Cada tentativa é gravada em `ai_request_attempts`:
  - número, início, duração, status HTTP, tipo e mensagem do erro, `retry-after` e cabeçalhos de rate limit da resposta;
  - com `log_bodies`, também o corpo da resposta de erro.
- **Streaming**: só repete quando a falha veio antes do primeiro byte. Se o stream cai no meio, os deltas já foram ao SSE do console. Nesse caso a requisição termina em erro, e vale a regra de hoje: a execução volta à fila até `max_attempts` ([011](011-agentes-de-ia.md), Execução).
- Esgotadas as tentativas, o erro segue como hoje (`LlmError` com `retryable`).

## Retenção
- O prazo padrão vem de `AI_REQUEST_RETENTION_DAYS` (30). O admin pode mudá-lo na tela, gravando em `app_settings` (`ai.request_retention_days`, de 1 a 365), e **o banco vence a variável**. Sem valor no banco, vale a variável.
- O worker purga, no laço de manutenção (`AGENT_MAINTENANCE_MS`) e em lotes, as requisições (e suas tentativas) mais velhas que o prazo. O `ai_usage` fica: o vínculo vira nulo.

## Telas (só admin)
- **Lista de provedores**: o nome vira link para o **detalhe do provedor** (`/admin/ai/providers/:id`). O lápis de editar continua na lista.
- **Detalhe do provedor**:
  - **Cabeçalho**: nome, tipo, `base_url`, capacidades ([024](024-capacidades-dos-provedores.md)), ativo/arquivado, se registra corpos, a dica da chave e o botão **Editar** (o mesmo modal da lista).
  - **Resumo de uso**: mês atual, últimos 30 dias e total; chamadas, tokens (entrada, saída, cache gravado e lido) e custo por moeda; separado por finalidade e por modelo, a partir de `ai_usage`.
  - **Saúde (7 dias)**: taxa de erro, latência p50/p95, tempo até o primeiro byte e média de tentativas.
  - **Requisições recentes**: as 50 últimas, com data, operação, finalidade, modelo, agente, usuário, status, tentativas, duração e tokens. Clicar abre o detalhe.
- **Guia "Requisições"**, nova em /admin/ai, depois de Uso:
  - a lista de todas as requisições, com filtros (período, provedor, agente, usuário, operação, finalidade, status, modelo) e paginação por cursor;
  - o campo "Retenção (dias)", que mostra se o valor vem do banco ou da variável, com o botão "Usar o padrão" (apaga o valor do banco).
- **Detalhe da requisição** (gaveta):
  - resumo e links para a conversa e a execução (somente leitura);
  - a linha do tempo das tentativas;
  - cabeçalhos e corpo enviados, num visualizador JSON. O base64 aparece recolhido com o tamanho, e imagem e áudio têm "ver/ouvir" e "baixar";
  - a resposta montada, com o stream bruto numa aba;
  - "Copiar como cURL", sem a chave.

## Banco (dba)
- **`app_settings`**: configurações do sistema gravadas pela tela, que vencem a variável de ambiente. Colunas: `key` (texto, chave primária, formato `area.nome`), `value` (jsonb), `updated_by_user_id` e `updated_at`. É auditada. A validação por chave fica em `app_setting_valid(key, value)`, começando por `ai.request_retention_days` (inteiro de 1 a 365). As fases [028](028-limites-e-uso.md) e [029](029-fluxos-autonomos.md) acrescentam chaves.
- **`ai_requests`**:
  - colunas: as dos metadados acima e as dos corpos (nulas sem `log_bodies`), com `request_bytes`/`response_bytes`;
  - as FKs (provedor, agente, usuário, conversa, execução) são todas `ON DELETE SET NULL`: a requisição sobrevive até a purga;
  - índices por (`provider_id`, `started_at` desc), por `started_at` (purga) e por `run_id`;
  - não é auditada (volume), como o resto da IA.
- **`ai_request_attempts`**: (`request_id`, `attempt`) como chave, com `ON DELETE CASCADE`.
- **`ai_providers.log_bodies`**: `boolean NOT NULL DEFAULT false`, auditada.
- **`ai_usage.request_id`**: FK nula, `ON DELETE SET NULL`.
- **`ai_requests_purge(dias, limite)`**: devolve quantas linhas apagou.
- **Função `ai_provider_health(dias)`**: por provedor e modelo, nos últimos N dias (taxa de erro, p50/p95 de duração e de primeiro byte, média de tentativas).
- **Backup**: `ai_requests` e `ai_request_attempts` ficam fora do JSON (são operacionais) e o dump do PostgreSQL leva só a estrutura delas (`--exclude-table-data`), porque trazem conversas e dados financeiros; `app_settings` entra.

## Aplicação (app)
- Um invólucro único (`agents/llm/request-log.ts`) envolve **todas** as chamadas dos adaptadores e de `embedTexts`, com as tentativas e a gravação.
  - Captura o corpo pelo `fetch` customizado do SDK (Anthropic e OpenAI aceitam `fetch`), sem montar o JSON duas vezes.
  - Grava fora da transação do negócio: uma linha no início e um UPDATE no fim. Nunca segura transação durante a chamada.
- **Rotas**:
  - `GET /api/admin/ai/requests` (filtros e cursor);
  - `GET /api/admin/ai/requests/:id`;
  - `GET /api/admin/ai/requests/:id/body?part=request|response|stream` (download);
  - `GET /api/admin/ai/providers/:id/summary`;
  - `GET/PUT/DELETE /api/admin/settings/:key` (o `DELETE` é o "Usar o padrão").

## Testes
- **Integração** (provedor falso):
  - 429 seguido de 200 grava 2 tentativas e 1 requisição `ok`;
  - 3 falhas de 5xx dão erro e devolvem a execução à fila;
  - queda no meio do stream não repete;
  - sem `log_bodies`, nenhum corpo; com ele, o corpo completo com base64, sem `Authorization`/`x-api-key`;
  - a purga respeita o prazo do banco e, sem ele, o da variável;
  - um não admin recebe 403 nas rotas.
- **e2e**: abrir o detalhe do provedor, ver a requisição da conversa e as tentativas, e mudar a retenção.
