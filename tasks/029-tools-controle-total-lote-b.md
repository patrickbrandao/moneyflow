---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-10-14
commit: (pendente: entregue sem commit, a pedido; branch spec/f7-agentes-ia)
---

# Tools de controle total, lote F13b (administração e segredos)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [027](../docs/027-tools-de-controle-total.md), seção "Tools novas por categoria (Configuração de IA, Usuários, Backup, Fechamento e auditoria, Mensagens, Tokens, tags)". O que fazer: Tools de admin (`adminOnly`), campos `secret` mascarados em prévia, `ai_messages`, eventos, auditoria e `ai_requests`; arquivos gerados como anexo da sessão; `/mcp` só com token de admin para essas tools; testes.

Ordem: Depois da 028. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [027](../docs/027-tools-de-controle-total.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria. Pode exigir uma tarefa do dba antes (ponto 1).

**Arquivos afetados**
- O registro e os handlers, como na 028.
- Serviços: `ai-admin.ts`, `api-tokens.ts`, `messages.ts`, `backup/*`, `audit.ts` e o de usuários.
- `routes/mcp.ts` hoje lista todo o `AGENT_TOOLS` (l. 27). Passa a filtrar `adminOnly` pelo papel do dono do token.
- `runner.ts` e `store.ts`, para mascarar os segredos.

**Riscos e observações**
- **Mascarar o `tool_use` "logo depois da execução" é inviável no banco atual**:
  - `ai_messages.content` é imutável (`ai_messages_validate_update`, `schema.sql` l. 659, constraint `ai_messages_immutable_check`);
  - `ai_tool_confirmations.input` também é imutável (`ai_tool_confirmations_validate`, l. 1326) e guarda o segredo enquanto espera a decisão;
  - o evento SSE `message`, gravado em `ai_run_events`, sai com o bloco no INSERT, antes da execução;
  - a 027 diz "Não há tabela nova" e não prevê essa mudança.
- **O segredo já está no texto do usuário**: o valor que o modelo escreve na tool veio do texto do usuário (ou de um anexo). Ele já está em `ai_messages`, nos corpos das Requisições e no provedor, então mascarar o `tool_use` não fecha o vazamento.
- **`restore_dump` como tool**: o `pg_restore --clean --single-transaction` (`backup/dump.ts`, l. 252) troca o banco inteiro, inclusive `ai_runs` e a reserva da própria execução. O runner perde a reserva no meio.
- **`export_backup` como anexo**: os anexos têm limite de 20 MB e ficam em `bytea`. Um dump ou um JSON completo pode passar disso.
- **`close_month` não é só de admin**: `closeMonth` usa `assertWrite(caixaId)` (`services/audit.ts`, l. 158). Só `reopenMonth` é de admin (l. 171).
- **Tags**: as tools de tags entram neste lote (veja a 028, ponto 2).

**Dependências**
- Depende da 028.
- Usa `app_settings` (020), `ai_requests` (020/021), as inferências (022/023) e o kit (017).
- Também os orçamentos (030) e as tarefas agendadas (032), que só chegam na F14/F15. As tools de orçamento e de tarefas agendadas dependem dessas tarefas, e a ordem F13 → F14 → F15 as deixa sem base. Recomendação: entregá-las junto com a 031 e a 033.

**Como verificar**
- Os testes da 027: a tool de admin ausente para quem não é admin, o segredo mascarado (no desenho que for aprovado) e a permissão negada.
- O e2e "crie um kit só de leitura".

**Pontos para a revisão da spec**
1. (027, Segredos) A imutabilidade de `ai_messages` e de `ai_tool_confirmations`, mais o segredo que já está no texto do usuário, inviabilizam o desenho. Recomendação:
   - as tools com campo `secret` não recebem o valor do modelo;
   - o cartão de aprovação (sempre `ask` para elas) tem o campo para o usuário digitar o segredo;
   - o valor vai direto ao serviço, sem passar pelo modelo, por `ai_messages`, pelos eventos ou pelas Requisições.
   - Se a máscara for mantida, abrir uma tarefa do dba para uma troca controlada do bloco.
2. (027, Backup) `restore_dump` por tool. Recomendação: fica fora das tools, só na tela; `import_backup` continua.
3. (027, Arquivos gerados) O limite de 20 MB dos anexos. Recomendação: acima dele, a tool devolve um erro que manda usar a tela.
4. (027, Fechamento) `close_month` não é de admin. Recomendação: `close_month` com `assertWrite`, sem `adminOnly` e sem `destructive`; `reopen_month` fica de admin e destrutiva.
5. (027, Configuração de IA) As tools de orçamentos e de tarefas agendadas vêm antes das tabelas delas (F14/F15). Recomendação: movê-las para a 031 e a 033.

## Resolução (executor)
Executor: app, 2026-10-14.

**Decisão dos segredos (aprovada pelo usuário, opção a)**: a decisão é da API e as tools aprovadas rodam no worker (outro processo), então o valor não chega em memória ao worker. A API executa a tool de segredo **na própria requisição de decisão** (`decideConfirmations` → `runSecretTools` → `executeSecretTool`), com o valor em memória e o ator `agent` da execução, antes de devolver a execução à fila. O resultado (sem o segredo) vai ao worker pelo evento `tool_result` com `prepared: true` e `content` em `ai_run_events`; sem mudança no banco. O worker nunca executa tool de segredo: sem resultado gravado, devolve "Esta ação precisa de um segredo: abra o console…". Consequências registradas na 027 e na 011: ordem (a de segredo roda na decisão, antes das outras da mesma resposta), falha parcial (o evento é gravado fora da transação da decisão; nova aprovação não reexecuta; decisões serializadas por trava consultiva da execução) e campo vazio mantém o segredo (obrigatório vazio volta "Informe … no cartão de aprovação"; "Aprovar tudo" fica desabilitado enquanto faltar um obrigatório).

**Tools criadas (55)**, em `packages/shared/src/agents/tools-admin.ts` e `apps/server/src/agents/tool-handlers-admin.ts`, sobre os serviços das rotas (com `Access`), escritas com prévia:
- **Entidades** (admin): `create_entity_tag`, `update_entity_tag`, `archive_entity_tag` (destrutiva). A descrição de `set_entity_tags` foi atualizada.
- **Mensagens e avisos**: `list_message_subscriptions`, `create_message_destination` e `update_message_destination` (token do bot = segredo), `archive_message_destination` (destrutiva), `set_message_subscriptions`, `send_test_message`, `list_notifications`.
- **Fechamento e auditoria** (categoria nova `closing`): `list_month_closings`, `close_month` (quem edita a caixa; não destrutiva), `reopen_month` (admin, destrutiva), `get_audit_history`.
- **Usuários e permissões** (categoria nova `users`): `list_users`, `create_user` e `set_user_password` (senha = segredo), `update_user`, `set_user_active` (admin); `list_caixa_members` (quem lê a caixa); `set_caixa_member`, `remove_caixa_member` (admin; a última destrutiva); `list_api_tokens` e `revoke_api_token` (destrutiva) sobre os tokens do próprio usuário, sem ser admin. Criar token fica fora.
- **Configuração de IA** (categoria nova `ai`, tudo admin): `list_ai_providers`, `create_ai_provider`/`update_ai_provider` (chave = segredo; `clearApiKey`), `archive_ai_provider`, `test_provider`, `list_provider_models` (serviço novo `listProviderModels`), `list_ai_prices`, `create_ai_price`, `delete_ai_price`, `list_ai_agents`, `create_ai_agent`, `update_ai_agent`, `archive_ai_agent`, `list_agent_tools` (catálogo para montar kits), `list_tool_kits`, `create_tool_kit`, `update_tool_kit`, `duplicate_tool_kit`, `delete_tool_kit`, `list_mcp_servers`, `create_mcp_server`/`update_mcp_server` (nomes dos cabeçalhos na entrada, valores = segredo), `archive_mcp_server`, `refresh_mcp_tools` (sugerido `allow`), `get_app_settings` (serviço novo `listSettings`), `set_app_setting`, `get_ai_usage`, `list_ai_requests` (só metadados). Orçamentos e tarefas agendadas ficaram para a F14/F15.
- **Backup** (categoria nova `backup`, admin): `export_backup` (`producesFile`; recurso em JSON, `full` ou `dump` em .zip; prévia avisa que leva segredos), `simulate_import` (leitura) e `import_backup` (destrutiva; prévia = simulação), a partir de anexo da sessão. A restauração do dump fica fora.

**Segredos (como ficaram)**: o campo não está no schema do modelo (`secrets` no registro; `ToolPreview.secretFields` com chave, rótulo, obrigatório e dica); o cartão abre um campo de senha por segredo (`ConversationPane`), e o valor vai em `secrets` na decisão (`confirmationDecisionInput`). O handler recebe `meta.secrets`; o modelo recebe o resultado do serviço com `secrets: { rótulo: "segredo definido" | "segredo mantido (campo vazio)" }`, e qualquer ocorrência do valor no resultado vira "[segredo]". Sempre `ask`, fora do `/mcp`. O chat avisa "Chaves e senhas: o agente vai pedir no cartão de aprovação" (sessão vazia e dica do campo). Um backup anexado no chat (.zip ou .json `moneyflow-backup`) nunca vai ao modelo (`run-attachments.ts`), porque leva chaves e senhas.

**Arquivo gerado (`producesFile`)**: o handler devolve `{ file }`; `RunTools.execute` grava o anexo (do usuário; acima de 20 MB, erro que manda usar a tela) e o runner o liga à mensagem `tool` da sessão (`ai_message_attachments`); o modelo recebe só `{ attachmentId, fileName, mime, sizeBytes }`. O console mostra o link de download no bloco da tool. O arquivo serve de entrada às tools de importação da mesma sessão.

**Outras mudanças**: categorias `closing`, `users`, `ai`, `backup` em `tool-def.ts` (e nomes em `t.agents.toolCategories`); `AGENT_TOOL_MODES` importado de `tool-def.ts` em `agents/schemas.ts` (quebra o ciclo com o registro); `formatFileSize` (shared); `backupStamp` movido para `services/backup/export.ts`; `preparedResults` em `store.ts`.

**Testes**: `apps/server/test/agent-tools-admin.test.ts` (9 casos, provedor falso, MCP falso e Bot API falsa): registro e oferta (segredo fora do schema enviado ao modelo, tools de admin ausentes para não admin, `/mcp` sem segredo nem arquivo e só admin com as de admin), tags, mensagens (token digitado, mantido com campo vazio, trocado, usado no envio de teste; viewer negado), fechamento (editor fecha, admin reabre, viewer negado), usuários (senha do cartão confere por `auth_login`, senha curta recusada sem expor o valor, acessos, tokens do próprio usuário), configuração de IA (chave conferida por `admin_ai_provider_api_key`, testar e listar modelos com a chave gravada, preços, kits, agentes, MCP com o cabeçalho digitado provado pelo `refresh_mcp_tools`, configurações, uso e requisições), backup (export como anexo da mensagem da tool, download, simulação na mesma sessão e recusa noutra, import a partir de anexo, conteúdo do backup fora do que vai ao modelo) e segredos (worker recusa a tool de segredo aprovada fora da API; nenhum valor digitado em `ai_messages`, `ai_run_events`, `ai_tool_confirmations`, `audit_log` ou `ai_requests`, com corpos registrados). Unitário do registro F13b em `packages/shared/test/agents.test.ts`. e2e em `e2e/tests/agentes.spec.ts`: "crie um kit só de leitura" (o kit aparece em /admin/ai/tool-kits) e o cartão de segredo trocando a chave de um provedor falso. `agent-tools.test.ts` passou a tolerar resultado truncado (banco reaproveitado).

**Verificação**: `pnpm lint`, `pnpm typecheck`, `pnpm test` (Testcontainers: 134 unitários e 185 de integração) e `pnpm build` passaram; `agentes.spec.ts` passou inteiro (18) contra a pilha (`TELEGRAM_API_BASE=http://host.docker.internal:18081 docker compose up --build -d`), parada no fim. Um aviso no rodapé do composer mudava a altura da janela e quebrava o e2e das prévias de PDF; o aviso foi para a sessão vazia e a dica do campo.

**Specs atualizadas**: 027 (segredos: onde executa, ordem, falha parcial, campo vazio; arquivos gerados; nomes e regras das tools do F13b; F13b entregue), 021 (categorias novas e a tabela), 011 (registro, leituras e escritas do F13b, segredos, arquivos gerados, backup fora do modelo), 019 (backup pelos agentes) e `docs/INDEX.md`; `AGENTS.md`.

**Pendências**
- Seed de dev (dba): o kit "Padrão" de `database/seeds/dev.sql` não traz as tools do F13a nem do F13b (monta a partir de `ai_legacy_tool_registry()`), como já anotado na 028.
- Telegram de entrada (F15, tarefa 033): a aprovação de tool de segredo pelo Telegram já cai no erro "abra o console" do worker; falta só a mensagem do botão.
- Commit: as mudanças estão na branch `spec/f7-agentes-ia`, sem commit (pedido do coordenador).
