---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-10-14
commit: (sem commit: fica na branch spec/f7-agentes-ia para o principal commitar)
---

# Tools de controle total, lote F13a (operação)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [027](../docs/027-tools-de-controle-total.md), seção "Tools novas por categoria (Contratos, Importação, Cartão, Caixas e contas, Títulos, Categorias e regras)". O que fazer: Tools do lote F13a com prévia, `Access`, anexos da sessão como entrada, `destructive` e categorias na tabela da 021; atualizar a lista de tools da 011; testes por tool.

Ordem: Depois da F12. Se algum serviço precisar de função nova no banco, abrir tarefa para o dba. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [027](../docs/027-tools-de-controle-total.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria. Se algum serviço precisar de uma função nova no banco, o app abre uma tarefa para o dba.

**Arquivos afetados**
- **Registro**: `packages/shared/src/agents/tools.ts`. Cada tool nova leva `category`, `kind`, `destructive`, o modo sugerido e `adminOnly`.
- **Handlers**: `apps/server/src/agents/tool-handlers.ts`, com `preview`, sobre os serviços:
  - `contracts.ts` e `contract-documents.ts`;
  - `statements.ts`, `reconciliation.ts` e `title-entry.ts`;
  - `cards.ts` e `card-core.ts`;
  - `caixas.ts`, os serviços de títulos, `categories.ts` e `attachments.ts`.
- **MCP**: `routes/mcp.ts`, com as anotações.
- **Docs**: a tabela de categorias da 021 e a lista de tools da 011.

**Riscos e observações**
- **Tools de admin no lote de "operação"**. Estes serviços usam `assertAdmin`:
  - `createCategory`, `updateCategory`, `deleteCategory` e `restoreCategory` (`categories.ts`, l. 54–90);
  - `deleteCaixa`, `restoreCaixa` e `addMember` (`caixas.ts`, l. 191–233).
  - O filtro `adminOnly` precisa existir antes desta tarefa. Veja a 017, ponto 1.
- **Anexo como entrada**: conferir que o anexo pertence a uma mensagem da sessão da execução, ou a algo que o usuário lê.
- **Tools que chamam IA dentro de uma execução** (`convert_contract_pdf`, `read_document`): são execuções aninhadas de fluxo, com espera síncrona. Podem prender uma vaga do worker (`AGENT_CONCURRENCY`). Precisam de timeout e devem contar no orçamento.

**Dependências**
- Depois da F12 (027).
- Depende do kit e do `adminOnly` (017) e do `attachmentId` de sessão (027).

**Como verificar**
- Para cada tool, com o provedor falso: a prévia, a execução, a permissão negada (viewer, não admin) e a importação que recusa anexo de outra sessão.
- O e2e "importe e concilie" com um OFX anexado.

**Pontos para a revisão da spec**
1. (027, Princípios) O `/mcp` não tem sessão, então as tools de importação (anexo da sessão) e os arquivos gerados ficam sem definição ali. Recomendação: no `/mcp`, aceitar o `attachmentId` de um anexo que o dono do token lê e devolver o arquivo gerado como anexo solto, com o link de download. Alternativa: não expor essas tools no `/mcp`.
2. (027, Entrega em lotes) As tools de tags (`create_entity_tag`, `update_entity_tag`, `archive_entity_tag`) não estão em nenhum lote, mas a tarefa 029 as inclui. Recomendação: F13b.
3. (027 × 021) A 021 não lista a categoria das tools de tokens (`list_api_tokens`, `revoke_api_token`). Recomendação: "Usuários e permissões".

## Resolução (executor)
Executor: app, 2026-10-14.

**Tools criadas (41)**, em `packages/shared/src/agents/tools-operation.ts` e `apps/server/src/agents/tool-handlers-operation.ts`, sobre os mesmos serviços das rotas (com `Access`), todas as escritas com prévia:
- **Contratos** (categoria nova): `list_contracts`, `get_contract`, `create_contract` (sempre rascunho), `update_contract`, `activate_contract`, `add_contract_amendment`, `terminate_contract` (destrutiva), `decide_contract_renewal`, `get_contract_document`, `save_contract_markdown`, `convert_contract_pdf`. Aditivo, rescisão e renovação usam o `dryRun` do serviço na prévia.
- **Importação** (categoria nova): `import_statement` (OFX/CSV, mapeamento salvo ou informado), `import_nfe` (devolve `suggestedTitle`; o título sai por `create_title`), `read_document`, `parse_payment_code`, `attach_file` (título, baixa, movimento, compra, entidade ou contrato).
- **Cartão**: `close_invoice`, `pay_invoice` (fechada = pagamento total/parcial com encargos; aberta = antecipado), `reopen_invoice` (destrutiva), `create_card_charge`, `refund_card_purchase`.
- **Caixas e contas**: `create_caixa`, `update_caixa`, `archive_caixa` (admin, destrutiva), `create_account`, `update_account`, `archive_account` (destrutiva), `create_adjustment`, `delete_transfer` (destrutiva).
- **Títulos**: `cancel_title`, `archive_title` (serviço novo `archiveTitle`), `delete_title` (destrutiva), `accept_mirror`, `dispute_mirror`.
- **Categorias e regras** (categoria nova; `list_categories` mudou para ela): `create_category`, `update_category`, `archive_category` (as três admin; a última destrutiva), `list_classification_rules`, `create_classification_rule`, `update_classification_rule`, `archive_classification_rule` (nome fechado assim porque o serviço arquiva).

**Decisões (atualizadas na 027, 021, 011 e no INDEX)**
- Anexo como entrada: numa execução, só anexo de mensagem da sessão da execução (`toolAttachment` em `tool-helpers.ts`); outra sessão, mesmo do próprio usuário, é recusada. No `/mcp`, qualquer anexo que o dono do token lê (`assertReadable`).
- O modelo recebe o id do anexo pelo rótulo `[Anexo "nome" (tipo) — attachmentId …]`, posto antes de cada anexo nos dois adaptadores (`llm/attachment-label.ts`). `.ofx`, `.csv` e `.xml` ganharam tipo no chat e vão ao modelo como texto.
- `/mcp`: `mcpExposed` (shared) tira as só de admin (para não admin), as de segredo e as que geram arquivo. O registro ganhou `producesFile`; nenhuma tool do F13a gera arquivo, então o mecanismo de "arquivo vira anexo de mensagem do agente" fica para o F13b, com a primeira tool que precisar.
- `import_statement` não dispara a sugestão de classificação do agente dos fluxos (a rota dispara): o próprio agente classifica.
- `read_document` e `convert_contract_pdf` rodam o fluxo do agente dos fluxos aninhado e esperam até `AI_DOCUMENT_TIMEOUT_MS`; precisam de outra vaga do worker (com `AGENT_CONCURRENCY` 1, só falham por prazo). O uso fica na execução do fluxo.
- `archive_caixa`, `archive_account` e `archive_category` usam o "excluir" da tela (sem uso, excluem): por isso são destrutivas.
- Versões de markdown gravadas pelo agente ficam com `author_kind = agent` e a execução (`createMarkdownDocument` e `appendVersion`).
- Nenhuma função nova no banco.

**Outras mudanças**: tipos do registro em `tool-def.ts`; `contractCreateFields`/`durationFitsPeriod` exportados; `previewStatementImport` e o mapeamento CSV em memória em `statements.ts`; `linkExistingAttachment`/`assertAttachTarget` em `attachments.ts`; `writableContractDocument` em `contract-documents.ts`. O teste do retrato `ai_legacy_tool_registry()` passou a exigir só que as 49 estejam contidas no registro.

**Testes**: `apps/server/test/agent-tools.test.ts` (12 casos, provedor falso): prévia, execução (com o ator agent na auditoria), permissão negada para o viewer, tools de admin ausentes para não admin, anexo de outra sessão recusado (import, leitura e anexar), CSV com mapeamento informado, conversão do PDF com o worker de verdade e o `/mcp` (anexo próprio aceito, alheio recusado, anotações). Unitários do registro em `packages/shared/test/agents.test.ts`. e2e: "anexar um OFX na conversa e pedir 'importe e concilie'" em `e2e/tests/agentes.spec.ts`. Ajustados `agents.test.ts` e `capabilities.test.ts` ao rótulo do anexo.

**Verificação**: `pnpm lint`, `pnpm typecheck`, `pnpm test` (Testcontainers: 133 unitários e 176 de integração) e `pnpm build` passaram; `agentes.spec.ts` passou inteiro (16) contra a pilha, que foi parada no fim. Contra o banco local reaproveitado (`moneyflow_test`), três testes antigos falham por dados de rodadas anteriores (embeddings por par, NF-e já importada, séries); com o banco novo do Testcontainers passam.

**Pendências**
- Seed de dev (dba): o kit "Padrão" de `database/seeds/dev.sql` monta as tools a partir de `ai_legacy_tool_registry()`, então não traz as 41 novas. Se quiser que o "Padrão" continue com "todas as ferramentas", o dba precisa acrescentar as do F13a no modo sugerido (leituras em `allow`: `list_contracts`, `get_contract`, `get_contract_document`, `read_document`, `parse_payment_code`, `list_classification_rules`; o resto em `ask`).
- F13b: o mecanismo de arquivo gerado (anexo de mensagem do agente) e as categorias de administração.

