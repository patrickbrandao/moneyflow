---
status: concluida
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: media
criada: 2026-10-20
commit:
---

# Regras de classificação por conta no banco (F18)

## Descrição
Lacuna entre o banco atual (migration 0049) e a spec [032](../docs/032-regras-de-classificacao-por-conta.md), seção "Banco (dba)". Uma migration nova: `classification_rules.caixa_id` `NOT NULL`, `financial_account_id` (obrigatório fora do cartão, nulo no cartão; conta `checking`/`savings` da mesma caixa), origem `copy` com `copied_from_rule_id`, unicidade das ativas por conta, `classification_rule_for` pelo alvo da linha (conta ou cartão) e a migração dos dados (regras de caixa copiadas para cada conta, globais para todas as contas e cartões, linhas reapontadas, contadores por conta, sem conta e sem linha = removida). Atualizar a 016, o seed de desenvolvimento (regras com conta; `copy_classification_rules` em `ask` onde estão as de regra) e o `schema.sql`.

Ordem: primeira da F18; a [040](040-regras-por-conta-na-aplicacao.md) depende desta.

## Como reproduzir
Não se aplica (recurso novo). Pronto: pgTAP da migration passando em `make -C database test`.

## Análise (triagem)
Designada direto pela sessão principal (spec aprovada pelo usuário em 2026-10-20).

**Executor designado: dba.**

## Resolução (executor)
Migration `database/migrations/0050_classification_rules_by_account.sql`, teste novo `database/tests/0050_classification_rules_by_account.sql` (66 testes) e `0014_statements.sql`/`0015_audit_log.sql` ajustados ao alvo obrigatório e à assinatura nova. `make test` completo: 46 arquivos, 3526 testes, PASS (o up e o down também passaram com os dados do banco de desenvolvimento: 8 regras de caixa → 11 por conta e de volta às 8). `schema.sql` regravado; seed com `copy_classification_rules` em `ask` no kit Padrão (o seed não tem caixas, contas nem regras, então não há regra a ganhar conta). Detalhes na [016](../docs/016-banco-de-dados.md) (Extratos → Regras).

- **Colunas**: `financial_account_id` (FK `financial_accounts`, `ON DELETE CASCADE`) e `copied_from_rule_id` (FK própria, `ON DELETE SET NULL`); `caixa_id NOT NULL` (sem caixa: `23502`, coluna `caixa_id`). Índices `classification_rules_financial_account_id_idx` e `classification_rules_copied_from_rule_id_idx`.
- **Alvo**: `23514 classification_rules_account_check` (trigger `classification_rules_validate_target`) para caixa geral sem conta, conta de outra caixa, conta que não é `checking`/`savings` e cartão com conta; o mesmo nome quando a conta com regras muda de caixa ou vira cofre (trigger `financial_accounts_validate_rules` em `financial_accounts`). A conta com regras não muda de caixa (recusa, em vez de mover as regras junto).
- **Cópia**: `classification_rules_origin_check` aceita `copy`; `23514 classification_rules_copied_from_check`: vínculo só com `origin = 'copy'` e nunca a própria regra (`copy` sem vínculo vale).
- **Unicidade**: `classification_rules_pattern_key` agora (caixa_id, financial_account_id, match_kind, lower(pattern), direction) `NULLS NOT DISTINCT`, ativas (`23505`).
- **Função**: `classification_rule_for(p_financial_account_id uuid, p_card_caixa_id uuid, p_description text, p_amount_cents bigint) RETURNS uuid` (exatamente um alvo, senão `22023`); a `(uuid, text, bigint)` saiu.
- **Migração**: `classification_rules_split_by_target()` (interna, sem `EXECUTE` para a aplicação; mantida para o pgTAP), pelo critério da spec. Decisão onde a spec não dizia: conflito de unicidade no alvo (ex.: global e de caixa com o mesmo padrão na mesma conta, ou global e regra do cartão) — a regra do cartão fica; entre as migradas vence a que já vencia (menor prioridade, a da caixa antes da global, id); a perdedora vira cópia arquivada se tem linha naquele alvo, senão não vai para ele. A original fica no alvo com mais linhas. Linha de conta que deixou de ser `checking`/`savings` (não deveria existir) solta a regra. Cópias herdam `created_from_line_id` só se a linha é do alvo delas. As linhas são reapontadas sem `updated_at`, sem auditoria das linhas e passando pela imutabilidade do lote substituído (triggers desligados só no UPDATE); as regras ficam na auditoria como `system`.
- **Down**: junta as ativas iguais da mesma caixa (linhas reapontadas, uso somado, a não-`copy` mais antiga fica), `copy` → `manual`.
- Para a 040: `pnpm db:pull`; trocar `classification_rule_for(caixa, …)` por `classification_rule_for(conta, cartão, …)`; traduzir `classification_rules_account_check`, `classification_rules_copied_from_check` e o `23505 classification_rules_pattern_key` (já por conta); o backup (019) converte arquivos antigos pelo mesmo critério na aplicação; reindexar no fluxo normal as regras novas (cópias da migração não têm embedding).
