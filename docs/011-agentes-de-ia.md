# 011 — Agentes de IA

## Configuração
- **Provedores**: multi-provedor, cadastrados pelo admin (chaves no servidor). Claude API é o padrão; OpenAI API é suportada. Cada agente escolhe provedor e modelo.
- **Agentes**: criados **só pelo admin** (nome, system prompt, provedor/modelo, tools, MCPs).
- **Tools**: gestão completa do sistema, sempre dentro das permissões do usuário que aciona o agente. Definidas uma vez em `packages/shared`. A leitura executa direto; a escrita mostra um cartão "Aplicar?" com o diff (e aprovar tudo para lotes). Confirmação configurável por agente. A tool "enviar mensagem" também passa por confirmação.

## MCP
- **MCP client** (só Streamable HTTP, sem stdio), servidores cadastrados pelo admin com uma visibilidade:
  - `global`: entra automaticamente em todos os agentes;
  - `public`: disponível para ser escolhido na configuração de qualquer agente;
  - `private`: só os agentes a que o admin o vincular explicitamente.
- **MCP server próprio**: endpoint `/mcp` expondo as mesmas tools, autenticado por token pessoal do usuário e com as permissões dele.

## Execução, histórico e custo
- O loop do agente roda no worker, com streaming via SSE; fechar a janela não interrompe, e um aviso no sino informa a conclusão.
- Conversas do usuário com título automático, renomear, fixar, arquivar, excluir, buscar e bifurcar. **O admin pode ler as conversas de todos.**
- Tokens e custo estimado por mensagem, agente e usuário (só medição, sem teto).

## UX das janelas
- Várias janelas flutuantes (arrastar, redimensionar, minimizar numa doca no rodapé), persistidas entre páginas e recarregamentos; cada janela é uma conversa.
- O agente recebe o contexto da tela (caixa aberta, registro selecionado, filtros); dá para arrastar um registro para dentro da janela.
- **Um** agente por vez pode ser ancorado como **painel lateral direito**, com o comportamento da sidebar esquerda: colapsar, expandir, alargar, minimizar (libera o espaço e volta a ser um agente minimizado na doca) e fechar (some até o usuário reabri-lo).
- O ícone **Agentes** na topbar lista as conversas, para continuar uma anterior ou iniciar uma nova.

## Decisões da implementação (F4b)

### Provedores, modelos e custo
- Dois tipos: `anthropic` (Messages API, `@anthropic-ai/sdk`) e `openai` (Chat Completions, `openai`), este cobrindo APIs compatíveis via `base_url` (para a OpenAI oficial, deixe vazio; num servidor compatível, a URL termina em `/v1`). Sem chave só com `base_url` (servidor local).
- Modelos padrão sugeridos para Claude: `claude-sonnet-5-5` (dia a dia) e `claude-opus-5-5` (análises pesadas). O admin testa a conexão e lista os modelos do provedor na tela.
- A chave é write-only: gravada pela API, nunca devolvida (a tela vê `…últimos 4`), lida só pelas funções do banco (`ai_run_provider_credentials` na execução, `admin_ai_provider_api_key` no testar conexão e no backup do admin, que exporta a chave — [019](019-backup-e-restauracao.md)). Fica fora de logs, auditoria, eventos e tools.
- Parâmetros do agente: `max_tokens` (padrão 16000), `max_tool_iterations` (padrão 20 chamadas ao modelo por execução), `thinking_budget_tokens` (> 0 liga o raciocínio: adaptativo com resumo nos modelos 5.x; orçamento fixo nos 4.5 ou anteriores), `reasoning_effort` (vira `output_config.effort` na Anthropic e `reasoning_effort` na OpenAI), `temperature`/`top_p` (só enviados a modelos que os aceitam).
- Prompt caching na Anthropic: ponto de cache na última tool e no prompt de sistema estável; a parte volátil (data, usuário, contexto da tela) vai depois. Os blocos de raciocínio são guardados com a assinatura e devolvidos só ao mesmo provedor e modelo.
- Uso por chamada em `ai_usage` (chat, título, embeddings), normalizado (entrada sem cache, cache gravado e lido). Custo estimado pelo preço vigente cadastrado por modelo (USD por padrão, ou BRL), mostrado por moeda; sem preço, "sem preço". Painel de uso (admin) por usuário e por agente/modelo, por mês.

### Tools
- Registro único em `packages/shared/src/agents/tools.ts`: nome, título e descrição pt-BR, schema Zod de entrada (o mesmo da API; convertido para JSON Schema) e o tipo `read`/`write`. Executores em `apps/server/src/agents/tool-handlers.ts`, chamando os mesmos serviços e a mesma autorização da API, com o `ServiceContext` de quem acionou (`actorKind agent` + `agentRunId`).
- Leitura: buscar registros, busca por significado, caixas, contas e saldos, extrato da conta, entidades, categorias, títulos, transferências, cartão, fatura e compras, calendário, relatórios por categoria e entidade, saldo projetado, grafo de fluxo, extratos importados, candidatos de casamento de uma linha do extrato e destinos de mensagem. Conversas não são expostas às tools.
- Escrita: criar/editar entidade, chave PIX, criar/editar título (com espelho, parcelas e recorrência), baixar título, estornar baixa (`reverse_settlement`, destrutiva: a prévia mostra título, valor, data, conta, a perna do espelho e o que fica em aberto, e avisa se uma linha do extrato ainda está conciliada com o movimento da baixa), transferência, compra no cartão, conciliar linha (uma ou até 500 por chamada), confirmar sugestões de conciliação, desfazer a conciliação de uma linha, ignorar e voltar linhas, lançar a partir da linha (uma ou até 500 por chamada; título com espelho como em criar título, compra com a caixa pagadora), sugerir classificação e aprovar/descartar sugestões, enviar mensagem ao Telegram e avisar o usuário.
- Lotes de linhas do extrato (conciliar, confirmar, ignorar, lançar) rodam numa transação com um savepoint por linha: as que falham voltam em `failed` com o motivo e não derrubam as outras. Com um agente sem confirmação de escrita, o agente concilia e publica no extrato oficial (movimentos da conta) um lote inteiro sozinho: localiza (`list_line_candidates`), classifica e lança. Um casamento errado com título se corrige sozinho: desfazer a conciliação da linha (`unmatch_statement_line`), estornar a baixa criada (`reverse_settlement`; o título volta a ficar em aberto) e casar a linha com o título certo.
- Confirmação: escrita pede confirmação quando o agente exige (padrão); "enviar mensagem" sempre pede; "avisar o usuário" (sino e destinos que assinam *mensagens do agente*) nunca pede. Antes de pedir, o servidor valida a entrada e a permissão e monta a prévia (`ToolPreview`: título, resumo, linhas antes→depois e avisos); se a ação vai falhar, devolve o erro ao modelo sem pedir confirmação. Quando um pedido do modelo mistura leituras e escritas, nada roda até o usuário decidir; depois tudo executa na ordem pedida, e as recusadas voltam ao modelo como erro com o motivo.
- Resultados das tools vão ao modelo como JSON (truncado em 60 mil caracteres). Erros de negócio e do banco chegam traduzidos em pt-BR.

### MCP
- Client só Streamable HTTP (`@modelcontextprotocol/sdk`). As tools de cada servidor entram no agente como `<servidor>__<tool>` (só `[A-Za-z0-9_-]`, até 64 caracteres), a partir do cache de `tools/list` (o admin atualiza na tela). Tools externas contam como escrita, e pedem confirmação, salvo `readOnlyHint = true`.
- Visibilidade: `global` entra em todos os agentes (um vínculo serve só para restringir as tools); `public` e `private` precisam de vínculo na tela do agente. Como só o admin configura agentes, `private` é um rótulo de "vínculo explícito do admin" e não aparece como sugestão comum.
- Cabeçalhos secretos write-only (a tela vê só os nomes; troca parcial por `mcp_server_merge_headers`).
- Servidor próprio em `POST /mcp` (Streamable HTTP sem estado), autenticado por `Authorization: Bearer <token pessoal>`, com as mesmas tools e as permissões do dono do token. O ator é `agent` sem `agent_run_id`. As tools levam as anotações `readOnlyHint`, `destructiveHint`, `idempotentHint` e `openWorldHint`; **a confirmação das escritas fica a cargo do cliente MCP** (o servidor executa o que receber). Tokens em *Minha conta → Tokens de API*: o token (`mf_…`) aparece uma vez; o banco guarda só o SHA-256; revogar é definitivo.

### Execução
- O loop roda no worker (`AGENT_POLL_MS`, `AGENT_CONCURRENCY`): reserva com `ai_run_claim`, heartbeat a cada 3 s (descobre o "parar" e a perda da reserva), eventos em `ai_run_events` (`NOTIFY` → SSE). Reserva abandonada é retomada por outro worker até 3 tentativas; uma escrita sem confirmação que já tinha começado antes da queda não é repetida (o modelo recebe "confira antes de repetir"). Erro temporário do provedor (429/5xx/rede) devolve a execução à fila.
- SSE em `GET /api/runs/:id/events` (Last-Event-ID ou `?after`): manda o histórico de eventos e depois os novos; fecha no `done`. Eventos: `status`, `text_delta`, `thinking_delta`, `tool_start`, `tool_result`, `message`, `confirmation`, `usage`, `title`, `error`, `done`.
- Parar: na fila ou esperando confirmação, cancela na hora (os pedidos de tool pendentes recebem "interrompido"); rodando, o worker encerra na próxima batida.
- Título automático depois da primeira resposta (chamada curta ao mesmo modelo, uso `title`); renomear marca o título como do usuário e ele não é mais trocado.
- Aviso de conclusão: quando a execução termina (ou passa a esperar confirmação) e ninguém está com o stream dela aberto, a API cria a notificação `agent_completed` no sino (e na fila dos destinos que assinam o evento), com link que reabre a conversa. Com várias réplicas da API, cada uma só enxerga os próprios streams.
- Retenção: eventos de execuções terminadas por 7 dias; confirmações esquecidas expiram em 7 dias (execução cancelada).
- Bifurcar avança o corte até não deixar pedido de tool sem resultado. Excluir a conversa apaga mensagens, execuções e eventos, e os anexos que ficarem sem vínculo, na mesma transação; o uso fica.

### Contexto e janelas
- O console manda `screen_context` (rota, título da página, caixa aberta, registro selecionado, filtros) na criação da conversa e em cada mensagem; o agente o recebe na parte volátil do prompt. Arrastar uma linha de título, entidade ou caixa para a janela insere a referência `[tipo: rótulo](tipo:id)`; soltar arquivos anexa.
- Janelas, doca e painel ficam no `localStorage` do navegador (`moneyflow:agents-ui`). O painel direito é uma terceira coluna do shell (320–760 px), vira gaveta abaixo de 900 px.
- O admin lê as conversas de qualquer usuário (filtro "Todos os usuários"), sem enviar, decidir, parar, renomear ou excluir.

### IA nos fluxos
- Um "agente dos fluxos" faz a leitura de documentos e as sugestões da conciliação: o de `AI_FLOW_AGENT` (nome) ou o primeiro agente ativo. Cada uso é uma execução normal numa conversa arquivada, fora da lista (`screen_context.purpose`), sem tools, respondendo JSON.
- `POST /api/title-entry/document`: lê PDF/imagem de boleto, nota ou comprovante e devolve tipo, beneficiário, documento, valor, vencimento, linha digitável, PIX e descrição. A linha digitável válida manda no valor e no vencimento; com documento cadastrado, devolve a entidade. Espera até `AI_DOCUMENT_TIMEOUT_MS`; sem agente, 501.
- Conciliação: ao importar um extrato (e no botão "Sugerir com IA"), as linhas novas sem classificação vão ao agente com as entidades candidatas por semelhança e as categorias. As sugestões ficam como "sugerido pelo agente", gravadas como ator `agent`, e o usuário aprova (vira classificação do usuário) ou descarta em lote.

### Embeddings
- Com um provedor OpenAI-compatível ativo com `embedding_model` (1536 dimensões), o worker indexa entidades, títulos, compras de cartão e linhas de extrato (`AGENT_MAINTENANCE_MS`) e a tool de busca usa `ai_embeddings_search` com as caixas que o usuário lê. Sem provedor de embeddings, a busca usa semelhança de texto (pg_trgm).
