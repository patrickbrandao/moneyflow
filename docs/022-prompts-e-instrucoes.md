# 022 — Prompts e instruções dos agentes (F8)

O que entra no prompt de sistema além do prompt do agente ([011](011-agentes-de-ia.md)):

- instruções do usuário;
- contexto automático do usuário;
- variáveis no prompt;
- histórico de versões do prompt;
- as `instructions` dos servidores MCP.

Decisões da entrevista de 2026-10-13. A memória entre conversas ficou fora por ora (veja [026](026-sessoes-dos-agentes.md)).

## Montagem do prompt
A ordem é fixa. Os pontos de cache da Anthropic ficam onde indicado.

1. Base do sistema (`t.agents.systemPrompt.base`).
2. Prompt do agente, com as **variáveis estáveis** substituídas.
3. As `instructions` dos servidores MCP no modo `system`, cada uma sob o título "Instruções do servidor MCP <nome>".
4. O prompt fixo do fluxo, quando é uma conversa de fluxo.
   — **ponto de cache 1** (junto com as tools) —
5. **Instruções do usuário** (se houver), sob o título "Instruções de <nome do usuário>".
6. **Contexto automático do usuário**.
   — **ponto de cache 2** (estável por usuário) —
7. A parte volátil de hoje: data, usuário e contexto da tela.

As `instructions` dos MCP no modo `user` não ficam no prompt de sistema. Elas entram como um bloco de texto do papel `user` no início do histórico enviado ao modelo, montado na hora da chamada e nunca gravado em `ai_messages`. O mesmo vale para o modo `system` (vem do cache a cada execução).

## Instruções do usuário
- Ficam em *Minha conta → IA*, numa caixa de texto de até 20 mil caracteres, que vale para **todos** os agentes do usuário.
- Na mesma tela, o campo opcional **Minha caixa principal**: uma caixa `general` que o usuário lê. O usuário não tem nome nem caixa principal no cadastro (a caixa principal é do titular); esta escolha alimenta o contexto automático e as variáveis.
- Só o próprio usuário edita. O admin as vê no detalhe do usuário (leitura).
- A conversa de fluxo não as usa, porque o fluxo responde JSON e o texto livre do usuário pode quebrar o formato.

## Contexto automático do usuário
É montado no início de cada execução, a partir de `Access`. Traz:

- login, e-mail e se é admin;
- a caixa principal escolhida pelo usuário (se houver);
- caixas que o usuário lê, com tipo, papel (`editor`/`viewer`) e id;
- contas de cada caixa, com nome, tipo e id;
- cartões, com nome e id.

O limite é de 60 caixas e 300 contas. O excesso é cortado com o aviso "lista parcial: use list_caixas". O contexto entra também nas conversas de fluxo, porque ajuda a classificar.

## Variáveis no prompt
- A sintaxe é `{{nome}}`, e `\{{` escapa as chaves. Variáveis:
  - **estáveis**: `{{agente.nome}}`, `{{usuario.nome}}` (o login, porque o usuário não tem nome no cadastro), `{{usuario.login}}`, `{{usuario.email}}`, `{{usuario.caixa_principal}}` (o nome da caixa escolhida em *Minha conta → IA*) e `{{empresa.titular_principal}}` (o titular dessa caixa). As duas últimas ficam vazias se o usuário não escolheu;
  - **voláteis**: `{{data}}` (DD/MM/AAAA em São Paulo), `{{data_iso}}`, `{{dia_semana}}`, `{{mes_ano}}`.
- Variável desconhecida é recusada ao salvar o agente (400, com o nome).
- As variáveis do usuário mudam por usuário e continuam no bloco cacheado: o cache fica por usuário, o que é aceito.
- Uma variável volátil no prompt do agente leva o prompt **inteiro** para depois do ponto de cache 2. A tela avisa: "Este prompt usa variáveis que mudam a cada dia e não será cacheado".
- O formulário do agente tem a lista de variáveis (clicar insere) e o botão **"Ver prompt montado"**: o admin escolhe um usuário e vê o prompt final, com os pontos de cache marcados, sem chamar o modelo.

## Histórico de versões do prompt
- Toda gravação que muda `system_prompt` cria uma versão: número sequencial, conteúdo, nota opcional (até 500), autor e data. O agente novo nasce com a versão 1.
- O formulário mostra a versão atual e o botão "Histórico". O histórico lista as versões, com o diff entre duas (`text-diff.ts`, o mesmo das versões de markdown dos contratos) e o botão "Restaurar". Restaurar cria uma versão nova com o conteúdo antigo e a nota "Restaurada da versão N".
- As versões são imutáveis e excluídas só junto com o agente.

## Instructions dos servidores MCP
- O servidor MCP pode mandar `instructions` na resposta do `initialize`. Elas são guardadas no cache junto com o `tools/list` (`instructions_cache`), atualizado pelo mesmo botão "Atualizar tools".
- Cada servidor tem o **modo das instruções**: `ignore` (padrão, porque são texto de terceiros), `system` ou `user`. A tela do MCP mostra o texto em cache e avisa que ele vai ao modelo.
- Vale para o servidor efetivo do agente (global, ou vinculado).

## Banco (dba)
- `user_ai_settings`: `user_id` como chave primária e FK com `ON DELETE CASCADE`, `instructions` (até 20 mil), `primary_caixa_id` (FK nula para `caixas`, `ON DELETE SET NULL`, só caixa `general`; a permissão de leitura é checada pela aplicação), `updated_at`. Fica numa tabela própria para não mexer em `users`, que guarda a senha.
- `ai_agent_prompt_versions`: `id` (uuid), `agent_id` e `version` atribuída pelo banco (a próxima, travando o agente), mais `content`, `note`, `created_by_user_id` e `restored_from_version_id`. Imutável, como `contract_document_versions`.
- **Migração**: a versão 1 de cada agente existente recebe o `system_prompt` atual.
- **A versão manda**: um trigger na tabela de versões copia o conteúdo da versão nova para `ai_agents.system_prompt` (vale também na importação do backup). A aplicação muda o prompt sempre criando uma versão.
- `mcp_servers`: entram `instructions_mode` (`ignore|system|user`, padrão `ignore`) e `instructions_cache` (texto, até 50 mil). Atualizar o cache não gera linha de auditoria, como o `tools_cache`.
- Auditoria e backup cobrem as três mudanças. As versões vão no backup como filhas do agente.

## Aplicação (app)
- Em `runner.ts`: `buildSystemPrompt` monta as partes acima e usa o segundo ponto de cache na Anthropic. No OpenAI-compatível, a ordem é a mesma, sem marcas de cache.
- Em `mcp-client.ts`: guardar `getInstructions()` do `initialize` no cache.
- Rotas:
  - `GET/PUT /api/account/ai` (instruções e caixa principal do usuário);
  - `GET /api/admin/ai/agents/:id/prompt-versions`;
  - `POST .../restore`;
  - `POST /api/admin/ai/agents/:id/prompt-preview` (com `userId`).

## Testes
- **Integração**:
  - ordem e conteúdo do prompt montado, com e sem instruções e com MCP `system`/`user`/`ignore`;
  - variável desconhecida recusada;
  - variável volátil sai da parte cacheada;
  - o contexto automático respeita as caixas legíveis (um viewer não vê a caixa alheia);
  - versão criada a cada mudança, e restaurar cria a versão nova;
  - instruções do usuário fora das conversas de fluxo.
- **e2e**: editar o prompt, ver o histórico e o diff, e restaurar.
