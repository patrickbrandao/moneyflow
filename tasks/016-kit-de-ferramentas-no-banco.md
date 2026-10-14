---
status: aberta
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: alta
criada: 2026-10-14
commit:
---

# Kit de ferramentas no banco (F7)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [021](../docs/021-kit-de-ferramentas.md), seção "Banco (dba)". O que fazer: Criar `ai_tool_kits` e `ai_tool_kit_tools` (modo `allow|ask`) e `ai_agents.tool_kit_id` (RESTRICT); migrar `enabled_tools`/`require_write_confirmation` para kits conforme a regra de migração da spec e remover as duas colunas; auditoria e catálogo do backup.

Ordem: Primeira tarefa da F7; depois vem a 017. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [021](../docs/021-kit-de-ferramentas.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: dba.** Tipo confirmado: banco.

**Arquivos afetados**
- Migration nova `database/migrations/0038_*.sql` (a última é a 0037), teste pgTAP novo e `schema.sql` (`make dump`).
- `database/tests/0024_ai_providers_and_agents.sql`: testa `enabled_tools` e `require_write_confirmation`, que saem.
- Estado atual: `ai_agents.enabled_tools text[]` com CHECK `ai_tool_list_valid` e `require_write_confirmation boolean DEFAULT true` (migration 0024; `schema.sql` l. ~5283). `ai_tool_list_valid` continua em uso por `agent_mcp_servers.enabled_tools` e pela view `effective_agent_mcp_servers`, então não sai.

**Riscos e observações**
- **Migração dos dados.** O banco não conhece o registro de tools nem o tipo leitura/escrita. Para expandir a lista NULL ("todas") e decidir o `ask`, a migration precisa de um retrato fixo do registro da v0.1.7: 49 tools, 25 de leitura e 24 de escrita (`packages/shared/src/agents/tools.ts`).
  - `send_telegram_message` tem `confirm: 'always'`, então é sempre `ask`.
  - `notify_user` tem `confirm: 'never'`, então é sempre `allow`.
  - A 017 deve ter um teste que compara esse retrato com `AGENT_TOOLS`.
- **Nomes desconhecidos.** `enabled_tools` pode ter nomes que não existem mais no registro, porque o banco só valida o formato. É preciso decidir se a migração os copia ou descarta. Recomendação: descartar.
- **Nome do kit migrado.** "Kit – <nome do agente>" pode passar de 120 caracteres, porque o nome do agente já vai até 120 (`ai_agents_name_check`). É preciso truncar. A unicidade se mantém, porque `ai_agents_name_key` já é único em `lower(name)`.
- **Auditoria.** `ai_tool_kit_tools` não tem `id` (a chave primária é composta). O precedente é `entity_tag_links_audit_row()` (migration 0035), uma função de auditoria própria para chave composta.
- **FKs.** `kit_id` com CASCADE (filho puro). `ai_agents.tool_kit_id` com RESTRICT, que devolve 23503. Cada FK precisa de índice, e as tabelas novas precisam dos GRANTs para `moneyflow_app`.
- **Down.** Recriar as duas colunas a partir dos kits.
- **Backup.** O "catálogo do backup" é código da aplicação (`apps/server/src/services/backup/catalog.ts`: `NATURAL_KEYS`, `COMPOSITE_KEYS`, `OWNED_BY`), então fica na 017. Aqui ficam só as FKs e os GRANTs, que o catálogo lê do `pg_catalog`.

**Dependências**
- É a primeira da F7. A 017 vem depois (`pnpm db:pull` e o código).

**Como verificar**
- `make -C database test`.
- pgTAP:
  - o kit em uso não é excluído (23503);
  - um modo inválido é recusado (23514);
  - um nome repetido com outra caixa de letras é recusado (23505);
  - a migração cobre os três casos: lista não nula; flag `true`; lista nula com flag `false` (fica sem kit).

**Pontos para a revisão da spec**
1. (021, Banco/Migração) A migração depende de um retrato fixo das 49 tools da v0.1.7, com o tipo de cada uma. Recomendação: aceitar e registrar isso na 021 e na 016.
2. (021, Banco) "As duas tabelas entram … no catálogo do backup" é trabalho da aplicação, não do dba. Recomendação: mover esse item para a seção "Aplicação".
3. (021, Migração) Falta definir o que fazer com nomes de tools desconhecidos e com nomes de kit acima de 120 caracteres. Recomendação: descartar os nomes desconhecidos e truncar o nome do kit.

## Resolução (executor)
