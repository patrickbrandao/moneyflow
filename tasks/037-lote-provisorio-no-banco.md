---
status: concluida
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: media
criada: 2026-10-19
commit:
---

# Lote provisório e a troca pelo consolidado no banco (F17)

## Descrição
Lacuna entre o banco atual (migration 0048) e a spec [031](../docs/031-lote-provisorio-e-consolidado.md), seção "Banco (dba)". Uma migration nova com: `statement_imports.provisional`, `superseded_by_import_id`/`superseded_at` e as regras deles (só conta; só provisório é substituído, por lote da mesma conta não substituído; final; sem excluir substituído nem substituto; provisórios ativos sem sobreposição, no COMMIT); a dedup por conta só entre linhas de lotes não provisórios; em `statement_lines`, o estado `superseded`, `superseded_by_line_id`, `supersede_outcome` com as transições e a sugestão da IA; o fechamento de mês recusado com provisório ativo ou linha `pending` no mês; o provisório em mês fechado recusado; `provisional`/`superseded` na `statement_import_balances`; a finalidade `supersede_pairs` nas conversas e no uso.

Ordem: primeira da F17; a [038](038-lote-provisorio-na-aplicacao.md) depende desta.

## Como reproduzir
Não se aplica (recurso novo). Pronto: pgTAP da migration passando em `make -C database test`.

## Análise (triagem)
Designada direto pela sessão principal (spec aprovada pelo usuário em 2026-10-19).

**Executor designado: dba.**

## Resolução (executor)
Migration `database/migrations/0049_statement_provisional_imports.sql`, teste `database/tests/0049_statement_provisional_imports.sql` (128 testes) e `0014_statements.sql` com as colunas novas no `columns_are`. `make test` completo: 45 arquivos, 3460 testes, PASS (o down também foi exercitado com dados: linha `superseded` e hash repetido). `schema.sql` regravado. Detalhes na [016](../docs/016-banco-de-dados.md) ("Lote provisório e a troca pelo consolidado" e "Fechamento de mês").

- **`statement_imports`**: `provisional boolean NOT NULL DEFAULT false` (só conta: `statement_imports_provisional_check`), `superseded_by_import_id` (FK própria, sem cascade) e `superseded_at`, juntos, só em provisório, nunca o próprio lote (`statement_imports_superseded_check`); substituto da mesma conta e, no UPDATE, não substituído (`statement_imports_superseded_by_check`; no INSERT — restauração do backup — só a conta). Final e sem DELETE: `statement_imports_superseded_immutable_check`; o substituto, pela FK (`23503`). Lote que já substituiu outro não vira provisório: `statement_imports_provisional_supersedes_check`. No COMMIT (`statement_imports_supersede_commit_check`, deferida, advisory lock por conta): `statement_imports_provisional_overlap_check` e `statement_imports_superseded_lines_check` (toda linha do substituído com desfecho; a linha inserida sem desfecho num substituído é recusada na hora com o mesmo nome).
- **Dedup**: `statement_lines.provisional` (cópia do lote, mantida pelo banco; o INSERT ignora o valor informado; mudar à mão: `statement_lines_provisional_check`) e `statement_lines_account_dedup_key` parcial `WHERE financial_account_id IS NOT NULL AND NOT provisional`. Desmarcar com linha repetida: `23505 statement_lines_account_dedup_key`. A cópia não gera auditoria nas linhas (`audit_row('provisional')`); a do lote registra a marca e a troca.
- **`statement_lines`**: `superseded` no `statement_lines_status_check` (o `links_check` já o trata como `new`/`ignored`, sem mudança); `superseded_by_line_id`, `supersede_outcome`, `supersede_suggested_line_id`, `supersede_suggestion_reason`. CHECKs `statement_lines_supersede_outcome_check` e `statement_lines_supersede_suggestion_check`; triggers `statement_lines_supersede_import_check`, `statement_lines_superseded_by_line_check`, `statement_lines_supersede_suggestion_target_check`, `statement_lines_supersede_transition_check` e `statement_lines_superseded_immutable_check`. Mais estrito que o contrato: na troca, `matched` só vira `transferred`/`pending` e as demais só `paired`/`dropped`; `kept`/`entry_deleted` só saem de `pending`, e `entry_deleted` exige `created_entry`. Classificação (entidade, categoria, origem) do substituído também é imutável (a regra excluída ainda solta `classification_rule_id`); descrição e notas do lote seguem livres.
- **Mês fechado**: `23514 period_closings_provisional_check` (provisório ativo ou `pending` no mês de uma conta da caixa) e `23514 statement_lines_provisional_closed_check` (linha nova de provisório ativo em mês fechado e também marcar como provisório um lote com linha em mês fechado — um nome só para os dois).
- **View e IA**: `statement_import_balances` com `provisional` e `superseded` no fim; `supersede_pairs` em `ai_conversations_purpose_check`, `ai_usage_purpose_check` e também `ai_requests_purpose_check` (o log das requisições usa o mesmo vocabulário). `ai_usage_is_flow` já a conta como fluxo; nenhuma outra função lista finalidades.
- **Grants**: os privilégios de tabela de `moneyflow_app` cobrem as colunas novas (testado).
- Para a 038: `pnpm db:pull`; a ordem da troca é lote → linhas do provisório → linhas do consolidado; mapear os nomes acima nos erros (`errors.ts`). Backup: as FKs próprias (`superseded_by_import_id`, `superseded_by_line_id`, `supersede_suggested_line_id`) são tratadas pela ordenação genérica por linha (`topoSort`); o banco aceita o lote já substituído e as linhas já com desfecho no INSERT, então não precisa de `replay` — só conferir num teste do backup que um substituído com linhas `transferred`/`pending` volta.
