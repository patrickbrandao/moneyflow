# 027 — Tools de controle total do sistema (F13)

Os agentes passam a ter **controle completo** do MoneyFlow: tudo o que se faz pela interface pode ser feito por uma tool, inclusive a configuração do próprio sistema de IA. O controle continua sempre limitado às permissões de quem aciona. Decisões da entrevista de 2026-10-13. O que cada agente realmente pode usar, e com ou sem aprovação, é decidido pelo kit ([021](021-kit-de-ferramentas.md)).

## Princípios
- **Mesmo serviço, mesma autorização**: cada tool nova entra em `AGENT_TOOLS` (shared, com `category`, `kind`, `destructive` e o modo sugerido) e no `TOOL_HANDLERS` (server). Ela roda sobre o mesmo serviço da rota da API, com `Access`. As escritas têm `preview` (antes→depois e avisos), como hoje.
- **Tools de admin** (`adminOnly: true` no registro):
  - só são oferecidas ao modelo quando quem aciona é admin ativo (filtro no `tools-runtime`, além de `assertAdmin` no serviço);
  - no `/mcp`, só aparecem para token de admin.
- **Segredos são gravados, nunca lidos, e nunca passam pelo modelo**:
  - **gravar**: a chave do provedor, os cabeçalhos secretos do MCP, o token do bot do Telegram e a senha de usuário podem ser **definidos ou trocados** por tool, como na tela;
  - **como**: o campo de segredo é declarado no registro (`secrets: [...]`) e **não** faz parte do schema enviado ao modelo. A tool com segredo fica sempre em `ask` ([021](021-kit-de-ferramentas.md)); o cartão de aprovação abre um campo de senha para cada segredo, o usuário digita, e o valor vai na decisão (`ai_tool_confirmations_decide`) direto ao serviço, sem ser gravado em `ai_messages`, nos eventos de SSE, na auditoria, nas confirmações ou nas Requisições ([023](023-requisicoes-ao-provedor.md)). O modelo recebe só "segredo definido";
  - deixar o campo vazio mantém o segredo atual (quando a tool também muda outras coisas);
  - **nunca ler**: nenhuma tool devolve um segredo;
  - no `/mcp` e no Telegram não há cartão: as tools de segredo não são expostas no `/mcp` e, no Telegram, a aprovação delas responde "abra o console para digitar o segredo";
  - **limite conhecido**: um segredo digitado pelo usuário no texto livre da mensagem vai ao provedor como texto. A tela de chat avisa "Chaves e senhas: o agente vai pedir no cartão de aprovação".
- **Destrutivas**: estornar, excluir, rescindir, reabrir mês, revogar e importar backup sobre dados existentes têm `destructive: true` (selo na tela do kit e `destructiveHint` no MCP), com o modo sugerido `ask`.
- **Anexos da conversa como entrada**: as tools de importação recebem o `attachmentId` de um anexo da sessão.
  - Numa execução, o handler aceita só um anexo de mensagem da sessão da execução (a conversa do run). Um anexo de outra sessão, mesmo do próprio usuário, é recusado com "O anexo não é desta sessão".
  - O modelo conhece o id pelo rótulo que vai antes de cada anexo da mensagem: `[Anexo "nome" (tipo) — attachmentId …]`. OFX, CSV e XML vão ao modelo como texto.
  - Peças: `toolAttachment` em `apps/server/src/agents/tool-helpers.ts`.
- **Arquivos gerados** (export de backup, CSV, PDF de relatório) viram anexo de uma mensagem do agente na sessão. O resultado da tool traz só id, nome e tamanho, nunca o conteúdo. O registro marca essas tools com `producesFile`; a primeira chega no lote F13b (nenhuma tool do F13a gera arquivo).
- **No `/mcp`** (sem sessão): as tools de importação aceitam o `attachmentId` de qualquer anexo que o dono do token lê (senão, "Registro não encontrado"); as que geram arquivo (`producesFile`) e as de segredo não são expostas (`mcpExposed` no shared).
- **Tools que chamam a IA** (`read_document`, `convert_contract_pdf`): rodam o fluxo do agente dos fluxos como hoje (conversa arquivada e execução própria, com o uso dela) e esperam o resultado até `AI_DOCUMENT_TIMEOUT_MS`. A execução aninhada precisa de outra vaga do worker: com `AGENT_CONCURRENCY` 1, ela só roda depois do prazo e a tool devolve o erro de leitura.

## Tools novas por categoria
Os nomes são indicativos; o executor fecha os schemas a partir das rotas existentes.

**Contratos** ([020](020-contratos.md)):
- `list_contracts`, `get_contract` (ciclos, parcelas, documentos, tarefa de renovação);
- `create_contract` (sempre rascunho: a tool não tem o `activate` da API), `update_contract` (vigente: só a configuração livre; a prévia recusa o resto), `activate_contract` (gera as parcelas; a prévia lista o calendário), `add_contract_amendment` e `terminate_contract` (destrutiva), com a prévia pelo `dryRun` do serviço, `decide_contract_renewal` (`approve` com o próximo ciclo em `renewal`, prévia pelo `dryRun`; `decline` exige a tarefa aberta);
- `get_contract_document` (o markdown atual ou uma versão, com a lista de versões), `save_contract_markdown` (com `documentId`, uma versão nova, com o diff de linhas na prévia; com `contractId` e `title`, um documento markdown novo; autor `agent` e a execução na versão), `convert_contract_pdf` (PDF → markdown por IA).

**Importação** (a partir de anexo):
- `import_statement`: OFX/CSV para uma conta ou cartão, com o mapeamento CSV salvo (`mappingId`; omitido = o padrão) ou informado (`csvMapping`, salvo na conta antes do import); devolve o lote e as linhas. A prévia lê o arquivo sem gravar (formato, período, linhas novas e repetidas, entradas e saídas) e recusa o arquivo todo repetido. Diferente da tela, não dispara a sugestão de classificação do agente dos fluxos: o próprio agente classifica;
- `import_nfe`: grava a NF-e como a tela (emitente vira entidade, nota, itens e XML) e devolve o título sugerido (`suggestedTitle`: entidade, valor, competência, vencimento da 1ª duplicata e `nfeDocumentId`); o título é criado depois com `create_title`, com a própria prévia. A prévia mostra a nota (emitente novo ou cadastrado, valor, itens, duplicatas);
- `read_document`: boleto, comprovante ou nota → os dados de [010](010-entrada-de-titulos.md), sem gravar;
- `parse_payment_code`: linha digitável ou PIX copia-e-cola → dados (o PIX acha a entidade pela chave, sem criar);
- `attach_file`: liga um anexo da sessão a um título, baixa, movimento, compra de cartão ou entidade (a mesma checagem do upload); em `contract`, vira um documento do contrato (PDF, ou markdown a partir de um `.md`).

**Cartão de crédito** ([007](007-cartao-de-credito.md)):
- `close_invoice` (um título por pagadora; a prévia mostra o total de cada uma);
- `pay_invoice` (total, parcial ou antecipado, com conta, data e encargos): fatura fechada vai ao pagamento (o resto rola, com os encargos); fatura aberta, ao antecipado (valor e conta obrigatórios, sem encargos);
- `reopen_invoice` (destrutiva);
- `create_card_charge` (encargo do emissor) e `refund_card_purchase` (estorno).

**Caixas e contas**:
- `create_caixa`, `update_caixa`, `archive_caixa` (admin, como a rota);
- `create_account`, `update_account`, `archive_account`;
- `create_adjustment` (movimento avulso);
- `archive_caixa` e `archive_account` usam o "excluir" da tela: com uso, arquivam; sem nenhum uso, excluem. Por isso são destrutivas.

**Títulos e baixas**:
- `cancel_title`, `archive_title` (só arquiva o par, sem apagar nem cancelar; serviço `archiveTitle`), `delete_title` (destrutiva; o "excluir" da tela, com `scope` nas séries);
- `accept_mirror` / `dispute_mirror`;
- `delete_transfer` (destrutiva; na categoria Caixas e contas, junto de `create_transfer`).

**Categorias e regras**:
- `create_category`, `update_category`, `archive_category` (admin, como a rota; `archive_category` exclui a categoria sem uso, destrutiva); `list_categories` passa para esta categoria;
- `list_classification_rules`, `create_classification_rule`, `update_classification_rule`, `archive_classification_rule` (a regra é arquivada, como na tela; a regra global exige admin).

**Entidades** (lote F13b): `create_entity_tag`, `update_entity_tag`, `archive_entity_tag` (admin). Revoga a regra de [011](011-agentes-de-ia.md) de que as tags ficam fora dos agentes.

**Mensagens e avisos** ([013](013-mensagens-telegram.md)):
- `create_message_destination` / `update_message_destination` (token write-only), `archive_message_destination`;
- `set_message_subscriptions`, `send_test_message`, `list_notifications`.

**Configuração de IA** (admin):
- **Provedores**: CRUD com a chave write-only, `test_provider`, `list_provider_models`.
- **Preços**: CRUD.
- **Agentes**: CRUD, com prompt, inferências, kit, MCP e "usar nos fluxos".
- **Kits**: CRUD e duplicar.
- **MCP**: servidores (CRUD, cabeçalhos write-only, modo das instruções) e `refresh_mcp_tools`.
- **Configurações**: `app_settings`.
- As tools de **orçamentos** e de **tarefas agendadas** entram com as tabelas delas, na [028](028-limites-e-uso.md) e na [029](029-fluxos-autonomos.md).
- `get_ai_usage` e `list_ai_requests` (metadados; os corpos ficam só na tela).

**Usuários e permissões** (admin):
- `list_users`, `create_user`, `update_user`, `set_user_active`;
- `set_user_password`: write-only; nunca devolve nem revela a senha, e `admin_reveal_password` fica fora das tools;
- `list_caixa_members`, `set_caixa_member` (editor/viewer), `remove_caixa_member`.

**Backup** (admin, [019](019-backup-e-restauracao.md)):
- `export_backup`: o JSON por recurso ou completo, ou o dump, como anexo da sessão. Leva segredos, como o export da tela, e a prévia avisa;
- `simulate_import` e `import_backup` (a partir de anexo; destrutiva);
- a restauração do dump do PostgreSQL **fica fora das tools** (só na tela): ela troca o banco inteiro, inclusive a execução que estaria rodando.

**Fechamento e auditoria** ([008](008-categorias-auditoria-e-exclusao.md)):
- `close_month` (quem edita a caixa; não destrutiva) e `reopen_month` (admin, destrutiva);
- `get_audit_history` (de um registro, nas caixas que o usuário lê).

**Tokens pessoais** (categoria Usuários e permissões): `list_api_tokens` e `revoke_api_token` (destrutiva). Criar token fica **fora**, porque o valor apareceria ao modelo.

## Entrega em lotes
- **F13a** (entregue, tarefa 028): Contratos, Importação, Cartão, Caixas e contas, Títulos, Categorias e regras.
- **F13b**: Configuração de IA, Usuários (com tokens), Backup, Fechamento e auditoria, Mensagens, tags de entidade.

Cada lote atualiza a tabela de categorias da [021](021-kit-de-ferramentas.md) e a lista de tools da [011](011-agentes-de-ia.md).

## Banco (dba)
Não há tabela nova. Se algum serviço precisar de uma função nova, como `close_month` ou `reopen_month`, que já existem, o app abre uma tarefa para o dba. O lote F13a não precisou de nenhuma.

## Testes
- **Integração** (`apps/server/test/agent-tools.test.ts` no F13a): cada tool com o provedor falso cobre:
  - a prévia;
  - a execução;
  - a permissão negada para quem não pode (viewer, não admin);
  - a tool de admin ausente para não admin;
  - o segredo mascarado em `ai_messages`, nos eventos, na auditoria e em `ai_requests`;
  - a importação recusando anexo de outra sessão.
- **e2e**:
  - anexar um OFX na conversa e pedir "importe e concilie";
  - o admin pede "crie um kit só de leitura" e vê o kit na tela.
