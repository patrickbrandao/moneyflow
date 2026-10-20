---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-20
commit:
---

# Regras de classificação por conta na aplicação (F18)

## Descrição
A seção "Aplicação (app)" da spec [032](../docs/032-regras-de-classificacao-por-conta.md), mais as seções Regras, Copiar, Agentes e Tela: entradas por conta/cartão no shared, `ruleFor` pelo alvo da linha (importação, aplicar regras, `learnRule`), lista com `Access`, `applyRulesToAccount`, `copyRules` com `skipped`, rotas, tools (`list_classification_rules` em todas as contas legíveis, `create_classification_rule` com o alvo, a nova `copy_classification_rules` com prévia), o pedido no prompt da conciliação com IA e das receitas, a guia Regras com o seletor de conta, a aba Regras na tela da conta, o modal "Copiar regras de outra conta", a conversão do backup antigo, `pnpm db:pull` e os testes. Atualizar o AGENTS.md (estrutura) se o mapa mudar.

Ordem: depois da [039](039-regras-por-conta-no-banco.md).

## Como reproduzir
Não se aplica (recurso novo). Pronto: os testes de integração e o e2e da seção Aplicação da spec.

## Análise (triagem)
Designada direto pela sessão principal (spec aprovada pelo usuário em 2026-10-20).

**Executor designado: app.**

## Resolução (executor)
`pnpm db:pull` (colunas `financial_account_id` e `copied_from_rule_id`, `caixa_id` NOT NULL). Sem commit (pedido de quem delegou): o campo `commit` fica vazio até o commit da sessão principal.

- **Shared**: `classificationRuleInput`, `applyRulesInput` e o novo `copyRulesInput` com `accountId`/`cardCaixaId` (exatamente um, `E.ruleAccount`); `ruleListQuery` com `accountId`, `cardCaixaId`, `caixaId`, `archived`; `ClassificationRuleRow` com `caixaKind`, `financialAccountId`, `accountName`, `cardCaixaId`, `targetName`, `copiedFromRuleId` e a origem `copy`; `CopyRulesResult`/`CopyRulesSkipped`; textos em `i18n/areas/statements.ts` (os de escopo global saíram); erros `classification_rules_account_check`, `classification_rules_copied_from_check`, o `classification_rules_pattern_key` por conta e o 23502 de `classification_rules.caixa_id` (`DB_NOT_NULL_MESSAGES`, usado em `errors.ts`); `AccountTab` e `CaixaTab` ganham `rules`.
- **Serviços**: `ruleFor(tx, { accountId, cardCaixaId }, …)` com a assinatura nova de `classification_rule_for` (importação, aplicar regras); `learnRule` grava na conta da linha com o `ON CONFLICT` do índice novo; `resolveRuleTarget`, `listRules` (todas as contas legíveis ou o filtro), `createRule` pelo alvo, `applyRulesToAccount` (no lugar de `applyRulesToCaixa`; lotes substituídos ficam de fora), `planRuleCopy`/`copyRules` numa transação com `skipped`. Sem caminho de regra global.
- **Rotas**: `GET /api/classification-rules?accountId|cardCaixaId|caixaId`, `POST` com o alvo, `POST /api/classification-rules/apply` com o alvo e `POST /api/classification-rules/copy`.
- **Agentes**: `list_classification_rules` (todas as contas legíveis, filtros), `create_classification_rule` com o alvo (prévia com a conta), a nova `copy_classification_rules` (prévia com o que entra e o que é pulado); `RULES_ADVICE` (`t.agents.reconcile.rulesAdvice`) no prompt da conciliação com IA (`flowSystemPrompt('reconcile_statement')`) e no bloco das receitas.
- **Backup**: `legacyClassificationRules` em `backup/import.ts` converte o arquivo antigo pelo critério da migração.
- **Tela**: `RulesPanel` por conta/cartão com o modal "Copiar regras de outra conta"; guia Regras da caixa com o seletor (`rules-account` no navegador, `account` no endereço) e o aviso sem conta; aba Regras na tela da conta e na caixa do cartão.
- **Testes**: `test/statements.test.ts` (regras por conta: classificação diferente, correção só na conta, aplicar sem tocar a outra, cópia com pulado, leitor e outra caixa; regra do cartão e o ON CONFLICT com a conta nula), `test/agent-tools.test.ts` (prévia, execução, permissão e `/mcp` de list/create/copy), `test/backup.test.ts` (arquivo antigo), `packages/shared/test/agents.test.ts` (registro), e2e `operacao.spec.ts` (criar na corrente, não aparece na poupança, copiar pelo modal) e `conta.spec.ts` (aba Regras).
- **Divergências**: embeddings não indexam regras de classificação (nada a reindexar); a aba Regras do cartão fica na caixa do cartão; a cópia pula também as arquivadas (`archived`); o desempate de unicidade da migração não é refeito no backup (repetida volta como conflito). Anotado na spec 032.
- **Verificação**: `pnpm verify:quick` (typecheck, testes do shared, integração tocada, pgTAP: verdes; o lint falha só pelo `tmp/` não versionado, com `biome.json` aninhado; o Biome nos arquivos desta tarefa passa); integração local de statements, agent-tools, backup, agent-prompts, reconcile-recipes, autonomous, statement-supersede, agents e account-summary; e2e numa pilha isolada (`operacao.spec.ts` regras e conciliação, `conta.spec.ts`, `agentes.spec.ts -g kit`).
