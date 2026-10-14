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
