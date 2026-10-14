# 021 — Kit de Ferramentas (F7)

Perfis de ferramentas dos agentes de IA. O kit diz quais tools internas do MoneyFlow um agente pode usar e, para cada uma, se ela roda direto (`allow`) ou pede aprovação ao usuário (`ask`). Substitui a lista `enabled_tools` e a flag `require_write_confirmation` do agente ([011](011-agentes-de-ia.md)). Decisões da entrevista de 2026-10-13.

## Regras
- Um **kit** tem nome (único, sem distinção de maiúsculas, até 120), descrição opcional (até 2000) e a lista das tools que ele libera, cada uma com o modo `allow` (executa sem perguntar) ou `ask` (mostra o cartão "Aplicar?" com a prévia e espera a decisão do usuário).
- Uma tool fora do kit **não existe** para o agente: ela não é enviada ao modelo.
- O kit decide tudo, para leituras e escritas. Não há travas fixas: o "enviar mensagem" pode ficar em `allow`, e o "avisar o usuário" pode ficar em `ask`. Cada tool tem um **modo sugerido**, usado quando ela é marcada no kit:
  - leituras e `notify_user`: `allow`;
  - demais escritas: `ask`.
- **Exceção, tools de segredo**: as tools com campo de segredo ([027](027-tools-de-controle-total.md)) ficam sempre em `ask`, com ou sem kit, porque o segredo é digitado pelo usuário no cartão de aprovação e nunca passa pelo modelo.
- **Cardinalidade**: um agente tem no máximo um kit (`ai_agents.tool_kit_id`), e um kit pode servir a vários agentes. Alterar o kit vale na próxima chamada ao modelo de todas as execuções dos agentes ligados a ele.
- **Agente sem kit = poder completo**: todas as tools internas, todas em `allow`, sem aprovação (menos as de segredo). As tools de MCP externo continuam com a regra delas, abaixo.
- **Tools novas** do registro (F13 e seguintes) **não entram sozinhas** num kit, que funciona como lista de permissões. Elas aparecem na tela como "não incluída".
- O kit vale só para as tools **internas**. Os servidores MCP externos continuam vinculados ao agente ([011](011-agentes-de-ia.md), seção MCP), com a regra de confirmação deles: as tools contam como escrita e pedem confirmação, salvo `readOnlyHint`.
- O kit **não amplia permissões**. A tool continua passando por `Access` com as permissões de quem aciona o agente, e as tools só de administrador ([027](027-tools-de-controle-total.md)) nunca são oferecidas ao modelo quando quem aciona não é admin, mesmo que estejam no kit. O campo `adminOnly` do registro e esse filtro entram já na F7; como ainda não há tool de admin real, o teste usa uma tool registrada só no teste.
- O kit não se aplica ao servidor `/mcp` próprio: os tokens pessoais continuam expondo todas as tools, menos as só de administrador (para quem não é admin), as de segredo e as que geram arquivo ([027](027-tools-de-controle-total.md)). Ele também não se aplica aos fluxos automáticos, que rodam sem tools até a [029](029-fluxos-autonomos.md).
- **Excluir**: só o kit sem agentes ligados (inclusive os arquivados). O kit em uso mostra os agentes que o usam. Não há arquivamento.
- O kit é **auditado** como o resto da configuração da IA.
- O backup do admin ([019](019-backup-e-restauracao.md)) exporta e importa os kits. O agente aponta para o kit pelo nome (chave natural). Um arquivo de antes do kit (v0.1.7, agente com `enabled_tools`/`require_write_confirmation`) é convertido na importação pela mesma regra da migração (abaixo), com o retrato `ai_legacy_tool_registry()`: o agente novo ganha o kit "Kit – <nome>" no próprio arquivo, ou fica sem kit; um agente que já existe no banco (mesmo id ou nome) fica como está.

## Categorias das tools
O registro (`packages/shared/src/agents/tools.ts`) ganha o campo `category` em cada tool. As categorias são fixas no código, com nome e ordem em pt-BR, e as tools de cada uma são:

| Categoria | Tools |
|---|---|
| Busca e consulta | `search_records`, `semantic_search`, `calendar` |
| Caixas e contas | `list_caixas`, `get_caixa`, `list_accounts`, `get_account_statement`, `list_transfers`, `create_transfer`, `delete_transfer`, `create_caixa`, `update_caixa`, `archive_caixa` (admin), `create_account`, `update_account`, `archive_account`, `create_adjustment` |
| Entidades | `list_entities`, `list_entity_tags`, `get_entity`, `create_entity`, `update_entity`, `set_entity_tags`, `set_entity_favorite`, `add_pix_key`, `create_entity_tag` (admin), `update_entity_tag` (admin), `archive_entity_tag` (admin) |
| Títulos e baixas | `list_titles`, `get_title`, `create_title`, `update_title`, `end_series`, `settle_title`, `reverse_settlement`, `cancel_title`, `archive_title`, `delete_title`, `accept_mirror`, `dispute_mirror` |
| Cartão de crédito | `get_card`, `get_invoice`, `list_card_purchases`, `create_card_purchase`, `close_invoice`, `pay_invoice`, `reopen_invoice`, `create_card_charge`, `refund_card_purchase` |
| Contratos | `list_contracts`, `get_contract`, `create_contract`, `update_contract`, `activate_contract`, `add_contract_amendment`, `terminate_contract`, `decide_contract_renewal`, `get_contract_document`, `save_contract_markdown`, `convert_contract_pdf` |
| Conciliação | `list_statement_imports`, `get_statement_import`, `list_line_candidates`, `match_statement_line`, `match_statement_lines`, `confirm_statement_lines`, `unmatch_statement_line`, `ignore_statement_lines`, `unignore_statement_lines`, `create_from_statement_line`, `create_from_statement_lines`, `classify_statement_lines`, `apply_classification_suggestions` |
| Importação | `import_statement`, `import_nfe`, `read_document`, `parse_payment_code`, `attach_file` |
| Categorias e regras | `list_categories`, `create_category` (admin), `update_category` (admin), `archive_category` (admin), `list_classification_rules`, `create_classification_rule`, `update_classification_rule`, `archive_classification_rule` |
| Relatórios e canvas | `report_categories`, `report_entities`, `report_projection`, `flow_graph` |
| Mensagens e avisos | `list_message_destinations`, `send_telegram_message`, `notify_user`, `list_message_subscriptions`, `create_message_destination` (segredo), `update_message_destination` (segredo), `archive_message_destination`, `set_message_subscriptions`, `send_test_message`, `list_notifications` |
| Fechamento e auditoria | `list_month_closings`, `close_month`, `reopen_month` (admin), `get_audit_history` |
| Usuários e permissões | `list_users` (admin), `create_user` (admin, segredo), `update_user` (admin), `set_user_active` (admin), `set_user_password` (admin, segredo), `list_caixa_members`, `set_caixa_member` (admin), `remove_caixa_member` (admin), `list_api_tokens`, `revoke_api_token` |
| Configuração de IA | todas de admin: `list_ai_providers`, `create_ai_provider` (segredo), `update_ai_provider` (segredo), `archive_ai_provider`, `test_provider`, `list_provider_models`, `list_ai_prices`, `create_ai_price`, `delete_ai_price`, `list_ai_agents`, `create_ai_agent`, `update_ai_agent`, `archive_ai_agent`, `list_agent_tools`, `list_tool_kits`, `create_tool_kit`, `update_tool_kit`, `duplicate_tool_kit`, `delete_tool_kit`, `list_mcp_servers`, `create_mcp_server` (segredo), `update_mcp_server` (segredo), `archive_mcp_server`, `refresh_mcp_tools`, `get_app_settings`, `set_app_setting`, `get_ai_usage`, `list_ai_requests` |
| Backup | todas de admin: `export_backup` (gera arquivo), `simulate_import`, `import_backup` |

As tools do lote F13a ([027](027-tools-de-controle-total.md)) entraram nas categorias acima, com as novas Contratos, Importação e Categorias e regras (`list_categories` saiu de Títulos e baixas para Categorias e regras). O lote F13b acrescentou as categorias Fechamento e auditoria, Usuários e permissões (com os tokens pessoais, do próprio usuário, sem ser admin), Configuração de IA e Backup, nessa ordem depois de Mensagens e avisos, e as tags de entidade em Entidades. "(segredo)" marca as tools com campo de segredo: sempre em `ask`, com o valor digitado no cartão. O modo sugerido é `allow` nas leituras, em `notify_user` e em `refresh_mcp_tools` (só atualiza o cache de tools do servidor MCP); as demais escritas, `ask`.

## Banco (dba)
- `ai_tool_kits`: `id`, `name`, `description`, `created_by_user_id`, `created_at` e `updated_at`.
- `ai_tool_kit_tools`: `kit_id`, `tool_name` e `mode` (`allow|ask`), com chave primária (`kit_id`, `tool_name`). O nome segue o formato de `ai_tool_list_valid`, e a aplicação valida contra o registro.
- `ai_agents.tool_kit_id`: FK nula para `ai_tool_kits`, sem `ON DELETE` (NO ACTION: o kit em uso devolve `23503 ai_agents_tool_kit_id_fkey`, e a API traduz listando os agentes).
- As colunas `ai_agents.enabled_tools` e `require_write_confirmation` saem.
- **Migração** (ninguém ganha nem perde poder, com uma exceção anotada):
  - a migration traz um retrato fixo das 49 tools da v0.1.7 (25 de leitura, 24 de escrita), escrito nela; nomes desconhecidos em `enabled_tools` são descartados;
  - o nome do kit é truncado para caber em 120 caracteres (com sufixo numérico se colidir);
  - o agente com `enabled_tools` não nulo, ou com `require_write_confirmation = true`, ganha o kit "Kit – <nome do agente>", com exatamente as tools que ele tinha (todas, se a lista era nula);
  - nesse kit, `ask` vai para a escrita que pedia confirmação (`send_telegram_message`, sempre, e as demais escritas quando a flag era `true`), e `allow` para o resto;
  - o agente com lista nula e flag `false` fica **sem kit**. Exceção: nele, o `send_telegram_message` deixa de pedir confirmação (poder completo).
- As duas tabelas entram na auditoria.

## Aplicação (app)
- **API**:
  - `/api/admin/ai/tool-kits`: CRUD, mais `duplicate`;
  - `GET /api/admin/ai/tools` passa a devolver `category`, `kind`, `destructive` e o modo sugerido.
- **Execução**:
  - o `tools-runtime` monta as tools pelo kit do agente: com kit, só as dele; sem kit, todas;
  - as tools de admin são tiradas quando o ator não é admin;
  - `needsConfirmation` passa a usar o modo do kit (sem kit = `allow`);
  - o modo é lido a cada chamada ao modelo, não só no início da execução.
- **Tela "Kit de Ferramentas"**, nova guia em /admin/ai, entre Agentes e MCP:
  - **Lista**: nome, quantas tools (leitura/escrita), quantas em `ask` e os agentes que usam o kit.
  - **Edição**:
    - tools agrupadas por categoria, em blocos recolhíveis;
    - o checkbox da categoria (com estado intermediário) marca ou desmarca todas as tools dela. Exemplo: marcar "Conciliação" libera todas as tools de conciliação;
    - cada linha mostra o título pt-BR e o nome técnico, um selo **Leitura** ou **Escrita** (e **Destrutiva**, quando for) e o seletor **allow / ask**;
    - a categoria tem "todas allow" e "todas ask";
    - há busca por nome e o filtro "só incluídas";
    - "Duplicar kit" cria uma cópia para ajustar.
- **Formulário do agente**: o campo "Kit de ferramentas" (lista de kits, ou "Sem kit — todas as ferramentas, sem aprovação") substitui a lista de tools e a flag de confirmação. A lista de agentes mostra o kit.
- **API (detalhes)**: `GET/POST /api/admin/ai/tool-kits`, `GET/PATCH/DELETE /api/admin/ai/tool-kits/:id` e `POST /api/admin/ai/tool-kits/:id/duplicate` (corpo opcional `{ name }`; sem nome, "Cópia de <nome>", com " (n)" se já existir). O kit volta com `tools` (`name`, `mode`, na ordem do registro) e `agents` (inclusive os arquivados). No PATCH, `tools` substitui o conjunto inteiro; a gravação mexe só no que mudou (a auditoria mostra cada tool incluída, removida ou com o modo trocado). Nomes fora do registro são recusados (400); o modo é obrigatório; as tools de segredo são gravadas em `ask`. O kit em uso devolve 422 com os nomes dos agentes. O agente recebe `toolKitId` (kit inexistente: 400) e devolve `toolKitId` e `toolKitName`.
- **Execução (detalhes)**: `apps/server/src/agents/tools-runtime.ts` monta as tools internas com `kitTools()` (shared) sobre `internalTools()` — o `AGENT_TOOLS` mais as tools registradas por `registerInternalTool()`, usada só nos testes (a tool `adminOnly` do teste) —, relendo o kit (`loadAgentKit`) a cada volta do loop. O `/mcp` próprio não usa o kit, mas também tira as `adminOnly` de quem não é admin.
- **Backup**: as duas tabelas entram no catálogo (`services/backup/catalog.ts`), com o kit por nome como chave natural. `ai_tool_kit_tools` não tem `id`: entra em `COMPOSITE_KEYS` (`kit_id`, `tool_name`; a parte que não é FK é texto) e é filha do kit (`OWNED_BY`): as tools de um kit que já existia não entram.
- **Textos**: em `i18n/areas/agents.ts`.

## Testes
- **Integração**:
  - a tool fora do kit não chega ao modelo;
  - em `allow`, a escrita executa sem `ai_tool_confirmations`;
  - em `ask`, a leitura pede confirmação;
  - sem kit, tudo roda direto;
  - a tool de admin num kit, acionada por um usuário comum, não é oferecida;
  - o kit em uso não é excluído;
  - a migração reproduz o comportamento de cada agente;
  - o backup faz a ida e volta do kit.
- **e2e**: criar um kit marcando a categoria Conciliação, pôr uma escrita em `ask`, ligar o kit ao agente e ver o cartão de aprovação na conversa (provedor falso).
