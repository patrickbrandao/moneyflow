# 024 — Capacidades dos provedores e provedor por inferência (F10)

Os provedores declaram o que sabem fazer. O agente escolhe um provedor (e um modelo) para cada tipo de inferência. O tipo `anthropic` passa a cobrir formalmente as APIs compatíveis com a Messages API. Decisões da entrevista de 2026-10-13.

## Tipos de provedor
- **Dois tipos**, como hoje:
  - **`anthropic`**: Messages API. O `base_url` vazio é a API oficial; preenchido, é um servidor compatível com a Messages API (OpenRouter, MiniMax, Z.ai, proxies).
  - **`openai`**: Chat Completions e os endpoints de embeddings e áudio. O `base_url` vazio é a OpenAI oficial; num compatível, a URL termina em `/v1`.
- **Anthropic compatível**:
  - O provedor com `base_url` exige um **modelo de texto padrão** (o modelo da chamada mínima do teste e a sugestão no agente). O "testar conexão" faz uma chamada mínima a esse modelo. Se `models.list` não existir (404, 405 ou 501), a tela mostra "listagem indisponível: digite o modelo", sem erro.
    - A regra vale só para o Anthropic compatível (`anthropic` + `base_url` + flag `text`). O banco a confere quando o tipo, a `base_url`, as flags ou os modelos mudam: um provedor antigo sem o modelo ainda pode ser ativado, desativado ou arquivado.
  - O provedor tem dois interruptores de recursos da Messages API: **cache de prompt** e **raciocínio** (thinking). Ficam ligados por padrão na API oficial e desligados quando há `base_url` (omitidos no cadastro, o banco decide pela `base_url`). Desligados, o adaptador não manda `cache_control` nem `thinking`, mesmo que o agente peça. O raciocínio desligado também tira o `output_config.effort` (o `reasoning_effort` do agente).
  - As regras de [011](011-agentes-de-ia.md) (assinatura do raciocínio só para o mesmo provedor e modelo) continuam.

## Capacidades (flags do provedor)
- **Flags**:
  - `text`: texto→texto (chat, título, fluxos);
  - `vision`: aceita imagens e PDF;
  - `embeddings`;
  - `transcription`: áudio→texto;
  - `speech`: texto→áudio.
- **Quem marca**: o admin. As flags vêm pré-marcadas pelo tipo: `anthropic` = `text` + `vision`; `openai` = todas. O tipo `anthropic` só aceita `text` e `vision`, porque a API não tem embeddings nem áudio.
- **Modelo padrão**: cada flag ligada tem o seu, e o TTS também a voz padrão. Sugestões na tela:
  - `vision`: o mesmo modelo de texto;
  - `embeddings`: `text-embedding-3-small`;
  - `transcription`: `gpt-4o-transcribe`;
  - `speech`: `gpt-4o-mini-tts`, voz `alloy`.
- `default_models` só guarda as chaves das flags ligadas (`speech_voice` só com `speech`). A aplicação descarta as demais ao gravar, e desmarcar uma flag tira o modelo dela no mesmo UPDATE.
- A **visão sem modelo** (nem na inferência nem em `default_models.vision`) usa o modelo de texto padrão do provedor, como a tela sugere.
- O campo `embedding_model` de hoje vira o modelo padrão de `embeddings`, e a regra "no máximo um provedor ativo com embeddings" deixa de existir.
- **Testar conexão**: avisa, flag a flag, se um recurso marcado falha (uma chamada mínima por flag, gravada em Requisições como `test_connection`, [023](023-requisicoes-ao-provedor.md)). O embedding precisa voltar com 1536 dimensões: nos `text-embedding-3-*` o MoneyFlow manda `dimensions: 1536`; num modelo que devolve outra dimensão, o teste falha com "o modelo precisa produzir 1536 dimensões".
  - As chamadas mínimas: texto (uma mensagem curta), visão (um PNG 1×1), embeddings (uma frase), áudio→texto (1 s de silêncio em WAV) e texto→áudio ("ok", com a voz padrão).
  - Uma flag sem modelo padrão aparece como "sem modelo padrão" e não conta como falha.
  - Se a listagem de modelos falha por outro motivo (chave errada, servidor fora), as flags não são testadas e o erro da listagem é o resultado.
- **Desmarcar uma flag em uso** por algum agente, arquivado inclusive, é recusado, com a lista dos agentes (o banco os manda no `DETAIL`). Isso vale também para `text`: o provedor de texto do agente precisa ter a flag `text`.

## Provedor por inferência no agente
- O formulário do agente começa pelo **Provedor padrão**. Ao escolhê-lo, ele preenche:
  - o provedor de **texto** (e o modelo do agente, se estiver vazio, com o modelo de texto padrão do provedor);
  - os de **visão**, **embeddings**, **áudio→texto** e **texto→áudio**, quando ele tem a capacidade. Os que ele não tem ficam como estavam.
- Cada campo pode ser trocado depois. A lista de cada campo só traz os provedores ativos com aquela flag, e "Nenhum" vale para todos menos o texto.
- O provedor padrão não é gravado: é um atalho da tela. A API aceita o mesmo atalho (`defaultProviderId` no cadastro e na edição do agente), que preenche o provedor de texto que não veio e as inferências que não vieram em `inferences`. `inferences`, quando vem, substitui o conjunto inteiro (a capacidade ausente fica "Nenhum").
- **Modelo**: cada inferência herda o modelo padrão do provedor escolhido (nulo = herdar), e o admin pode trocá-lo. O texto continua com o modelo do agente (obrigatório para ficar ativo). O TTS também tem a voz.
- A lista de agentes mostra ícones das capacidades configuradas.
- O agente dos fluxos usa a mesma configuração (a leitura de documento e a de contrato usam a visão).
- **Agentes de antes da F10** (migration 0041, decisão aceita pelo usuário): para nada mudar de comportamento, cada agente com provedor ganhou a inferência `vision` no próprio provedor de texto (o anexo continua indo direto ao modelo), e todo agente ganhou a `embeddings` no provedor de embeddings ativo de antes, quando havia (sem isso, os vetores migrados seriam purgados em 7 dias).

## Como cada inferência é usada
- **Imagem e PDF** (a regra também vale para os fluxos):
  - Se o provedor de visão do agente é o mesmo do texto e tem `vision`, o anexo vai direto ao modelo de texto, como hoje.
  - Senão, o provedor de visão **descreve/extrai** o anexo, uma vez por anexo e modelo. O resultado fica guardado como derivado do anexo (`description`), e o texto vai ao modelo de texto como `[Imagem "nome" — descrição]: …` (no PDF, `[PDF "nome" — conteúdo extraído]: …`).
    - A descrição é uma chamada `vision_describe` ao provedor de visão, registrada em Requisições e em `ai_usage` com a execução, o provedor e o modelo de visão.
    - Ela roda antes da chamada ao modelo de texto (nunca no meio do stream) e grava o derivado e o uso numa transação curta. Uma falha do provedor de visão é tratada como erro do provedor: a execução volta à fila ou falha, como na [011](011-agentes-de-ia.md).
  - Sem provedor de visão:
    - o PDF vai pela **camada de texto** (extraída no servidor com pdf.js, derivado `pdf_text`, sem provedor) como `[PDF "nome" — camada de texto]: …`; um PDF escaneado sem texto (ou inválido) vira o aviso "PDF sem texto e o agente não tem visão";
    - a imagem é **recusada ao anexar** (422 "Este agente não lê imagens"): no upload do anexo da conversa, no envio da mensagem e, nos fluxos, antes de abrir a conversa da leitura de documento.
- **Embeddings**: veja abaixo.
- **Áudio→texto e texto→áudio**: [025](025-chat-multimidia.md).

## Índice de embeddings por modelo em uso
- O worker indexa, para **cada par distinto (provedor, modelo)** de embeddings usado por algum agente ativo, as entidades, os títulos, as compras de cartão e as linhas de extrato. O custo da indexação cresce com cada par novo, o que é aceito.
- A dimensão continua fixa em 1536.
- A busca (`semantic_search`; a `search_records` é por texto e não muda) usa o par do agente que a chamou, pela execução. O vetor da consulta é cobrado do usuário e do agente.
  - Enquanto o índice do par não está completo (sem fila e com todos os registros que a busca enxerga), a busca usa o que já existe e completa com trigramas, avisando "índice em construção" (`building: true` e `notice` no resultado da tool).
  - Agente sem embeddings, ou a busca fora de um agente (o servidor `/mcp`): só trigramas, como hoje.
- Os vetores de um par que nenhum agente ativo usa mais são apagados depois de 7 dias. O par em uso fica registrado em `ai_embedding_indexes` (abaixo), com a última vez em que esteve em uso.
- O ciclo do worker: `ai_embedding_indexes_touch()` registra os pares em uso (antes de gravar qualquer vetor de um par novo), cada par grava os textos-fonte e calcula os vetores pendentes com as credenciais do provedor dele, e `ai_embedding_indexes_purge()` apaga os parados. Um par com problema (provedor fora, modelo com outra dimensão) não segura os demais.
- Vários modelos dividem o mesmo índice HNSW; a busca filtra por provedor e modelo com `hnsw.iterative_scan` ligado, para não perder resultados no filtro.
- O detalhe do provedor mostra o progresso do índice por modelo (indexados / total), pela visão `ai_embedding_index_stats`; o total é o número de registros que a busca enxerga.

## Uso e preços
- Novas finalidades em `ai_usage.purpose`: `vision_describe`, `transcription` e `speech`.
- O uso de áudio também registra `audio_seconds` (transcrição) e `characters` (TTS).
- Os preços (`ai_model_prices`) ganham `audio_input_per_minute` e `speech_per_million_chars`, opcionais, para os modelos cobrados assim. Os cobrados por token usam os preços de entrada e saída de sempre. Custo = tokens + segundos ÷ 60 × preço do minuto + caracteres × preço por milhão (preço nulo conta zero).
- O detalhe do provedor soma os minutos transcritos e os caracteres falados no resumo de uso.

## Banco (dba)
- **`ai_providers`**:
  - `capabilities text[]`: subconjunto de {`text`,`vision`,`embeddings`,`transcription`,`speech`}, com padrão pelo tipo e `anthropic` ⊆ {`text`,`vision`};
  - `default_models jsonb`: um modelo por capacidade ligada, mais `speech_voice` (só com `speech`); chave de flag desligada é recusada. Absorve o `embedding_model`, que sai;
  - `prompt_cache_enabled` e `thinking_enabled`, booleanos com padrão pelo `base_url` (omitidos no INSERT, o banco decide: ligados sem `base_url`);
  - sai o índice/regra de um provedor de embeddings só.
- **`ai_agent_inferences`**:
  - colunas: `agent_id`, `capability` (`vision|embeddings|transcription|speech`), `provider_id`, `model` (nulo = padrão do provedor) e `voice`. A chave primária é (`agent_id`, `capability`);
  - um trigger exige que o provedor tenha a flag, e a flag não sai do provedor enquanto houver vínculo, de agente arquivado inclusive (`23514`, com os nomes no `DETAIL`); o provedor de texto do agente também precisa da flag `text`;
  - auditada com `record_id = agent_id` (aparece no histórico do agente);
  - o texto continua em `ai_agents.provider_id/model`.
- **`ai_attachment_derivatives`** (definida inteira aqui; a [025](025-chat-multimidia.md) só a usa):
  - origem: **exatamente uma** entre `attachment_id` (descrição, texto do PDF, transcrição) e `message_id` + `block_index` (o áudio gerado de uma mensagem, `speech`), por CHECK;
  - `kind` (`description|pdf_text|transcription|speech`), `provider_id`, `model`, `voice` (só no `speech`), `content` (texto), `result_attachment_id` (o áudio gerado, no `speech`), `status` (`pending|running|done|failed`), `error`, `attempts`, `locked_at` (fila da transcrição), `created_at`/`updated_at`;
  - `provider_id` e `model` são nulos só (e sempre) no `pdf_text`, que é extraído no servidor;
  - `block_index` é o trecho da mensagem que virou áudio, definido pela aplicação (o bloco de texto ou o pedaço dividido no limite do provedor);
  - único por (`attachment_id`, `message_id`, `block_index`, `kind`, `provider_id`, `model`, `voice`) com `NULLS NOT DISTINCT`;
  - excluir a mensagem ou o anexo leva o derivado; o áudio gerado entra em `attachment_links` (`ai_message_speech`) para não virar órfão, e o banco o apaga quando o derivado sai (ou troca de áudio), inclusive ao excluir a conversa, se ele não tem outro vínculo.
- **`ai_embedding_indexes`**: (`provider_id`, `model`) como chave, `last_in_use_at`; o worker atualiza a cada ciclo para os pares em uso e purga os vetores dos pares parados há mais de 7 dias.
  - Auxiliares: a visão `ai_embedding_pairs_in_use` (agentes ativos e não arquivados, provedor ativo com a flag, modelo nulo = o padrão), `ai_embedding_indexes_touch()` (registra os pares em uso e os devolve), `ai_embedding_indexes_purge(prazo = 7 dias)` (apaga os parados com os vetores) e a visão `ai_embedding_index_stats` (vetores, indexados e na fila por par).
- **`ai_embeddings`**: a chave única passa a (`object_type`, `object_id`, `provider_id`, `model`), e `ai_embeddings_search(vetor, provedor, modelo, caixas, tipos, limite)` recebe o provedor. Todo vetor pertence a um par registrado (FK). Os vetores existentes migram com o provedor cujo `embedding_model` era o modelo deles (o ativo primeiro); sem provedor, são apagados.
- **Credenciais fora de uma execução reservada** (transcrição no upload, TTS, indexação, embedding da consulta):
  - `ai_capability_credentials(agente, capacidade, ator)` (`SECURITY DEFINER`): exige ator ativo, agente ativo e provedor ativo com a flag; usada também durante a execução (visão por descrição), com o usuário da execução como ator. Aceita também `text` (provedor e modelo do agente) e devolve o modelo resolvido (pode ser nulo) e a voz só no `speech`; `P0002` sem provedor para a capacidade;
  - `ai_embedding_credentials(provedor)` passa a receber o provedor e devolve o modelo padrão (a indexação usa o modelo do par);
  - `ai_run_provider_credentials` também exige a flag `text`.
  - Nenhuma devolve chave para provedor inativo ou sem a flag (`42501`).
- **Uso e preços**: as finalidades novas, `audio_seconds`/`characters` em `ai_usage` e as duas colunas de preço.
- **Backup**: a tabela de inferências entra como filha do agente (chave composta `agent_id` + `capability`; agente já cadastrado fica com as dele); os derivados e `ai_embedding_indexes` ficam fora (são cache), e o áudio gerado cujo único vínculo é `ai_message_speech` também.
  - Arquivo anterior à F10: o `embedding_model` vira `default_models.embeddings`; flags, cache e raciocínio ficam com os padrões do banco; o Anthropic compatível ganha o modelo de texto de um agente dele no arquivo (sem nenhum, volta como conflito com o motivo); os agentes do arquivo ganham as inferências pela regra da migração (visão no próprio provedor de texto, embeddings no provedor de embeddings ativo do arquivo).

## Aplicação (app)
- **Adaptadores**: em `openai.ts`, `transcribe()`, `speak()` e `embed()` com `dimensions`; em `anthropic.ts`, os interruptores de cache e raciocínio. Toda chamada passa pelo registro de requisições ([023](023-requisicoes-ao-provedor.md)).
  - Transcrição: com `log_bodies`, o registro guarda o corpo multipart inteiro como JSON, com o arquivo em base64 (`file_name`, `content_type`, `bytes`, `base64`); sem ele, só os metadados (tamanho, modelo, tempos).
  - Resposta binária (o áudio do TTS): com `log_bodies`, guardada como JSON com o base64 (o `text` do banco não aceita bytes nulos).
  - As sondas internas do SDK (`fetch('data:,')` antes de um upload) não viram requisição.
- **Resolução**: `resolveInference(agent, capability)` devolve provedor, modelo e voz já com os padrões, em `agents/inferences.ts`; `inferenceCredentials` lê a chave por `ai_capability_credentials` (nulo quando a inferência não está configurada ou não pode ser usada).
- **Visão**: o pré-processamento dos anexos fica no runner (`agents/run-attachments.ts`), antes da chamada, e grava os derivados em transação curta. A camada de texto do PDF sai de `agents/pdf-text.ts` (pdf.js no servidor, sem worker separado, dentro do bundle único).
- **Worker**: a indexação de embeddings roda por par em uso.
- **Telas**:
  - Modal do provedor: as flags (pré-marcadas pelo tipo; no tipo OpenAI, as sugestões de modelo preenchidas), o modelo padrão de cada flag e a voz, e os interruptores de cache e raciocínio no tipo Anthropic. A lista mostra os ícones das capacidades, e o "Testar conexão", uma linha por flag.
  - Formulário do agente: o "Provedor padrão", o provedor e o modelo de texto e o bloco "Inferências" (provedor, modelo e voz de cada uma, com o modelo herdado de exemplo). A lista de agentes mostra os ícones das capacidades configuradas.
  - Detalhe do provedor: as capacidades com os modelos padrão no cabeçalho, os interruptores, o progresso do índice de embeddings por modelo e o áudio no resumo de uso.
  - Preços: as colunas e os campos de áudio.

## Testes
- **Integração** (provedor falso):
  - flags padrão por tipo, e `anthropic` com `embeddings` recusado;
  - o provedor padrão preenche as inferências que ele suporta;
  - desmarcar uma flag em uso é recusado;
  - imagem com visão no texto vai direto; com visão em outro provedor vira descrição (uma vez só); sem visão, recusada;
  - PDF sem visão vai pela camada de texto;
  - dois agentes com modelos de embeddings diferentes geram dois índices, e a busca usa o do agente;
  - Anthropic compatível com cache desligado não manda `cache_control`.
- **e2e**: cadastrar um provedor OpenAI-compatível falso com todas as flags e criar um agente que herda tudo.
- Onde estão: `apps/server/test/capabilities.test.ts` (o provedor falso ganhou `/v1/audio/transcriptions`, `/v1/audio/speech`, `dimensions` e o prefixo `/nolist` sem listagem), o embedding por par em `agents.test.ts`, o arquivo antigo em `backup.test.ts` e o e2e em `agentes.spec.ts`.
