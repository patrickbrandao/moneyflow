---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-14
commit:
---

# Capacidades, Anthropic compatível, provedor por inferência e visão por descrição (F10)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [024](../docs/024-capacidades-dos-provedores.md), seção "Aplicação (app)". O que fazer: Flags e modelos padrão no modal do provedor (padrão por tipo, teste por flag), interruptores de cache/raciocínio no Anthropic compatível, bloco "Inferências" no agente (provedor padrão preenche), `resolveInference`, visão direta/descrição/camada de texto do PDF, `transcribe`/`speak`/`embed`, indexação por par em uso e busca pelo par do agente; testes.

Ordem: Depois da 022. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [024](../docs/024-capacidades-dos-provedores.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **Adaptadores**:
  - `agents/llm/anthropic.ts`: `cache_control` (l. 136–138) e `thinking` passam a depender dos interruptores do provedor;
  - `agents/llm/openai.ts`: `transcribe`, `speak` e `embedTexts` com `dimensions: 1536`.
- **`agents/inferences.ts`**, novo: `resolveInference`.
- **`runner.ts`**: `loadAttachment` (l. ~272) hoje manda o arquivo cru ao modelo. Entram o pré-processamento (visão direta, descrição ou camada de texto) e a gravação dos derivados em transação curta.
- **Embeddings**: `agents/embeddings.ts`, `agents/search.ts` e `agents/worker.ts` indexam por par e buscam pelo par do agente.
- **`services/ai-admin.ts`**:
  - provedor: flags, modelos padrão e o teste por flag;
  - agente: o bloco de inferências;
  - recusa de desmarcar flag em uso.
- **`services/conversations.ts`**: `uploadMessageAttachment` recusa imagem sem visão (422).
- **Fluxos**: `services/ai-flows.ts` e `agents/flows.ts` passam a usar a visão do agente.
- **Shared**: `agents/schemas.ts` e `agents/types.ts`.
- **Web**: `components/admin-ai/ProvidersTab.tsx` e `AgentsTab.tsx`, mais o progresso do índice no detalhe do provedor (021).
- **Backup**: `catalog.ts`.
- **Banco**: `pnpm db:pull` depois da 022.

**Dependência nova**
- A camada de texto do PDF é extraída no servidor. Hoje o `pdfjs-dist` existe só em `apps/web`. Ele entraria no bundle da API e do worker (`dist/main.mjs`), então é preciso conferir o build e a imagem.
- O provedor falso (`e2e/fakes/fake-llm.ts`) precisa de `/v1/audio/transcriptions`, `/v1/audio/speech` e `dimensions` nos embeddings.

**Riscos e observações**
- As funções de embeddings trocam de assinatura (022): esta tarefa vai na mesma branch.
- A descrição fica em cache por anexo e modelo, para não ser chamada de novo.
- A assinatura do raciocínio só volta ao mesmo provedor e modelo (011).

**Dependências**
- Depende da 022 e usa o invólucro da 021.
- A 025 depende desta.

**Como verificar**
- Os testes da 024: flags por tipo, provedor padrão, flag em uso, imagem direta/descrita/recusada, PDF pela camada de texto, dois índices e o cache desligado.
- O e2e do provedor com todas as flags.

**Pontos para a revisão da spec**
1. (024, Anthropic compatível) "Testar conexão faz uma chamada mínima ao modelo informado", mas o provedor não tem um modelo de texto definido hoje. Recomendação: usar o modelo padrão de `text` em `default_models`, obrigatório no Anthropic compatível.
2. Os pontos de banco da 022 (derivados e os 7 dias) também afetam esta tarefa.

## Resolução (executor)
Feito pelo app em 2026-10-14 (sem commit ainda; a sessão principal commita). `pnpm db:pull` rodado depois da 0041.

**Spec 024**
- Registradas as decisões do banco que a 022 listou: a migração das inferências dos agentes antigos (visão no próprio provedor de texto, embeddings no provedor de embeddings de antes; aceita pelo usuário), a regra do modelo de texto só no Anthropic compatível com o legado conferido só na edição, `default_models` só com as chaves das flags ligadas, `pdf_text` sem provedor, o `block_index` definido pela aplicação, o banco apagando o áudio gerado, os auxiliares `ai_embedding_pairs_in_use`/`touch`/`purge`/`ai_embedding_index_stats` e `ai_capability_credentials` aceitando `text`.
- Decisões novas da aplicação, também na spec:
  - visão sem modelo = o modelo de texto padrão do provedor;
  - o raciocínio desligado também tira o `output_config.effort`;
  - testar conexão: chamadas mínimas por flag, flag sem modelo padrão não é falha, listagem 404/405/501 = "listagem indisponível", outra falha na listagem não testa as flags;
  - `defaultProviderId` na API do agente (o mesmo atalho da tela) e `inferences` substituindo o conjunto;
  - a busca fora de um agente (o `/mcp`) fica só com trigramas;
  - o índice completo = sem fila e com todos os registros que a busca enxerga;
  - imagem recusada também no envio da mensagem e no fluxo de leitura de documento, antes de abrir a conversa;
  - registro: multipart com o arquivo em base64 com `log_bodies`, resposta binária (TTS) em JSON com base64, sondas `data:` do SDK fora do registro;
  - backup de arquivos antigos.

**Servidor**
- `agents/llm`: `LlmCredentials` com `promptCache`/`thinking`; o `anthropic.ts` só manda `cache_control` e `thinking`/`effort` com os interruptores ligados. No `openai.ts`, `embed()` (recusa vetor ≠ 1536 com "O modelo precisa produzir 1536 dimensões"), `transcribe()` e `speak()`, todos pelo `RequestRecorder`. `LlmAttachment` pode ser o arquivo ou o texto que o substitui.
- `request-log.ts`: `describeBody` assíncrono (multipart com o áudio em base64 só com `log_bodies`), resposta binária guardada em base64, URLs que não são http(s) passam direto.
- `agents/inferences.ts`: `resolveInference`, `visionMode` e `inferenceCredentials` (por `ai_capability_credentials`; P0002/42501 = indisponível).
- `agents/run-attachments.ts` (`RunAttachments`): pré-processa os anexos do histórico antes da chamada.
  - Direta: o arquivo como está.
  - Por descrição: chamada `vision_describe` ao provedor de visão; o derivado `description` e o `ai_usage` na mesma transação curta.
  - Sem visão: a camada de texto (`pdf_text`) ou o aviso.
  - O runner usa os interruptores do provedor da execução.
- `agents/pdf-text.ts`: pdf.js (`pdfjs-dist` 5.7.284 no servidor, legacy, sem worker separado, com classes vazias no lugar do canvas nativo). Conferido dentro de um bundle esbuild igual ao da imagem.
- Embeddings: indexação por par (`touch` antes de gravar, `provider_id` no INSERT, credenciais por `ai_embedding_credentials(provedor)`), purga no laço de manutenção, um par com erro não segura os outros. A busca usa o par do agente da execução, com `building`/`notice` e o complemento por trigramas; o uso da consulta leva usuário e agente.
- `ai-admin.ts`:
  - provedores com flags, modelos padrão (filtrados pelas flags) e interruptores, e o teste flag a flag;
  - agentes com `inferences` e `defaultProviderId`;
  - preços de áudio.
- `ai-requests.ts`: o progresso do índice (`embeddingIndexes`) e os minutos/caracteres no resumo do provedor.
- `conversations.ts`: `assertReadsImages` (422 `agent_no_vision`) no upload e no envio; `ai-flows.ts` checa antes de abrir a conversa.
- `errors.ts` e `i18n/errors.ts`: traduções novas (com os nomes do `DETAIL` na flag em uso); saíram as do `embedding_model`.
- Backup:
  - `ai_agent_inferences` em `COMPOSITE_KEYS`/`OWNED_BY`;
  - derivados e `ai_embedding_indexes` em `EXCLUDED_TABLES`;
  - `ROW_FILTERS` tira o áudio gerado sem outro vínculo;
  - a paginação da chave composta passou a tratar as colunas de texto (antes fazia `::uuid` em todas);
  - `legacyCapabilities` migra os arquivos antigos.

**Shared e web**
- Shared:
  - `AI_CAPABILITIES`, `AI_INFERENCE_CAPABILITIES`, `AI_KIND_CAPABILITIES`, `AI_MODEL_SUGGESTIONS`, `EMBEDDING_DIMENSIONS`;
  - os schemas do provedor (`capabilities`, `defaultModels`, interruptores), do agente (`inferences`, `defaultProviderId`) e do preço;
  - os DTOs (`AgentInferenceDto`, `AiProviderCapabilityCheck`, `AiEmbeddingIndexDto`);
  - `inferencesFromProvider`;
  - as finalidades novas e os textos pt-BR.
- Web:
  - modal do provedor com as flags, os modelos padrão, a voz e os interruptores, e o resultado do teste por flag;
  - formulário do agente com o "Provedor padrão", o provedor de texto e o bloco "Inferências";
  - ícones das capacidades nas listas;
  - detalhe do provedor com as capacidades, os interruptores, o progresso do índice e o áudio;
  - preços com as colunas de áudio.

**Testes**
- `test/capabilities.test.ts` (novo, 11 casos):
  - flags por tipo, `anthropic` com embeddings recusado, compatível sem modelo de texto;
  - testar conexão flag a flag, com 1536/768 e a listagem indisponível;
  - transcrição com e sem `log_bodies`, fala em base64, preços de áudio;
  - provedor padrão, flag em uso, cache e raciocínio desligados;
  - imagem direta/descrita uma vez/recusada (também no fluxo), PDF pela camada de texto e o PDF sem texto;
  - dois índices com a busca pelo par do agente e o "índice em construção".
- `agents.test.ts`: embeddings pelo agente. `backup.test.ts`: ida e volta das inferências e o arquivo antigo. Ajustados `ai-requests.test.ts`, `agent-prompts.test.ts` e o e2e para o compatível com modelo de texto.
- Robustez: três asserções do `agents.test.ts` passaram a filtrar a busca de entidades pelo nome exato. A busca é por semelhança e falhava num banco de teste reaproveitado.
- Provedor falso: `/v1/audio/transcriptions` (multipart), `/v1/audio/speech`, `dimensions` (modelo com "768" devolve 768), o prefixo `/nolist` e a resposta de descrição.
- e2e `agentes.spec.ts`: provedor OpenAI-compatível falso com todas as flags pela tela, testar flag a flag e um agente que herda tudo pelo "Provedor padrão".

**Verificação**
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: ok.
- `pnpm test`: 128 + 152 ok, com `MONEYFLOW_TEST_DATABASE_URL` (e `MONEYFLOW_TEST_OWNER_URL`, para os testes de backup). O `moneyflow_test` foi recriado e migrado pelo dbmate para a rodada final.
  - Num banco reaproveitado, `operation.test.ts` (NF-e "já importada") e `titles.test.ts` (séries de rodadas anteriores) falham por dados de rodadas anteriores. Não têm relação com esta tarefa.
- e2e `agentes.spec.ts` + `backup.spec.ts`: 11 ok, com a pilha (`TELEGRAM_API_BASE=…18081`), parada no fim. Nenhum banco `moneyflow_bk_*` ficou.

**Para a F11 (025)**
- `transcribe()` e `speak()` não gravam `ai_usage`. A 025 grava o uso com `audio_seconds` (do `TranscribeResult`) ou `characters` e o `request_id`, e as credenciais vêm de `inferenceCredentials(agente, 'transcription' | 'speech', usuário)`.
- A fila da transcrição (`pending`/`running`, `attempts`, `locked_at`), o claim e `attachments.duration_ms/page_count` dependem da 024 (dba).
- O TTS divide o texto pelo limite do provedor em `block_index` e grava o áudio em `result_attachment_id`.
- O áudio anexado ao chat ainda vai ao modelo como "formato não suportado". A 025 decide se a transcrição substitui o anexo como texto, no mesmo ponto do `RunAttachments`.
- As visões mensais de uso (`ai_usage_monthly_*`) não somam `audio_seconds`/`characters`. Só o detalhe do provedor soma. Se o painel de Uso (F14) precisar, é tarefa do dba.

