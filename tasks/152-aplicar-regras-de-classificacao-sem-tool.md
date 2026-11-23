---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 5d66b57
---

# A tool de copiar regras manda "aplicar as regras", mas não existe tool para aplicar

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** tool faltando / descrição que induz a erro
- **Arquivos afetados:** `packages/shared/src/agents/tools-operation.ts:559-606`, `apps/server/src/agents/tool-handlers-operation.ts:1237`, `packages/shared/src/i18n/areas/statements.ts:257`, `apps/server/src/services/reconciliation.ts:815-840`, `apps/server/src/routes/statements.ts:112,133`, `docs/027-tools-de-controle-total.md:3`, `docs/032-regras-de-classificacao-por-conta.md:21,28,35`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O agente pode criar e copiar regras de classificação, mas não consegue aplicá-las às linhas que já estão no extrato: isso só existe como botão na tela. A própria ferramenta de copiar diz ao agente "depois, aplique as regras", e ele não tem como.

### Evidência e análise técnica
- Descrição de `copy_classification_rules` (`tools-operation.ts:587`): "Copiar não reclassifica as linhas: depois, aplique as regras." A prévia acrescenta `t.statements.copyHint` (`tool-handlers-operation.ts:1237`): "use “Aplicar regras” na conta de destino" (`statements.ts:257`).
- O serviço existe: `applyRulesToImport` e `applyRulesToAccount` (`reconciliation.ts:815-840`), nas rotas `POST /api/statement-imports/:id/apply-rules` e `POST /api/classification-rules/apply` (`routes/statements.ts:112,133`). Nenhuma tool os chama (`grep` por `applyRules` em `packages/shared/src/agents` e `apps/server/src/agents`: nada).
- `docs/027:3`: "tudo o que se faz pela interface pode ser feito por uma tool". `docs/032:21` define o "Aplicar regras" da tela; `:35` só cria a tool de cópia.
- Sem a tool, o caminho do agente para as linhas pendentes é `classify_statement_lines`, que grava sugestões "pendentes de aprovação" uma a uma, e não usa a regra nem conta o uso dela.

### Verificação (tentativa de refutação)
- A importação já aplica as regras (`docs/009`), então o problema é só para as linhas que já estavam no lote quando a regra nasceu ou foi copiada: o caso de "crie uma regra para estas linhas" e "copie as regras da outra conta".
- Nenhuma receita ou fluxo automático chama o serviço por baixo.

### Impacto
O agente promete um passo que não pode dar (ou alucina uma tool), e o usuário precisa ir à tela. Nas receitas de conciliação, que sugerem regra de classificação (`docs/030`), a regra nova não reclassifica o próprio lote.

## Como reproduzir
Conversa: "copie as regras da corrente para a poupança e aplique nas linhas pendentes". O agente chama `copy_classification_rules` e depois não tem tool para aplicar.

## Solução proposta
- Tool `apply_classification_rules` (escrita, categoria `categories` ou `reconciliation`, modo sugerido `ask`): `importId` (o lote) ou `accountId`/`cardCaixaId` (todos os lotes da conta), sobre `applyRulesToImport`/`applyRulesToAccount`; prévia com quantas linhas novas seriam classificadas e por quais regras (um `dryRun` no serviço).
- Numa execução de receita, limitar às linhas do escopo (ou pôr a tool em `RECIPE_DENIED_TOOLS`, como as de lote inteiro, tarefa 057).
- Trocar o texto de `copyHint`/descrição para citar a tool nova; acrescentar a tool em `docs/011`, `docs/021` e `docs/032`.

## Critérios de aceite
- [ ] O agente consegue aplicar as regras de uma conta ou de um lote, com prévia.
- [ ] A descrição de `copy_classification_rules` aponta para uma tool que existe.

## Testes recomendados
`apps/server/test/agent-tools.test.ts`: criar regra, `apply_classification_rules` no lote → linhas novas classificadas pela regra e o uso dela conta; permissão negada em conta só leitura; o mesmo pelo `/mcp`.

## Limitações e suposições
Não há `dryRun` em `applyRulesToAccount` hoje; a prévia precisaria dele (ou contar as linhas candidatas sem gravar).

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: não havia tool para aplicar as regras; a descrição de `copy_classification_rules` e o aviso da prévia mandavam aplicar.

## Resolução (executor)

- Tool `apply_classification_rules` (escrita, categoria `categories`, `ask`; registro em `tools-operation.ts`, handler em `tool-handlers-operation.ts`): um lote (`importId`) ou todos os lotes da conta (`accountId`) ou do cartão (`cardCaixaId`), exatamente um. A prévia é o plano do serviço sem gravar (`planApplyRules` em `reconciliation.ts`, sobre o `planRuleChanges` que a execução também usa): onde, quantas linhas mudam por regra (entidade e categoria) e as que perdem a classificação de uma regra que não vale mais.
- Na receita de conciliação ela é recusada (`RECIPE_DENIED_TOOLS`), porque age em linhas fora do escopo.
- A descrição de `copy_classification_rules` e o aviso da prévia (`t.statements.copyHintAgent`) apontam para a tool nova; o texto da tela (`copyHint`) ficou.
- Ficou na categoria Categorias e regras (com a cópia), então a contagem da categoria Conciliação no e2e (`agentes.spec.ts`, 22 de 22) não muda. Como toda tool nova, não entra em kit nenhum.
- Specs 021 (tabela), 027 e 032 e a linha da 032 no `docs/INDEX.md` atualizadas.
- Testes: `agent-tools.test.ts` (no lote: prévia, uma linha classificada pela regra criada depois da importação e o uso contado; nada mais a mudar avisado; viewer negado; dois alvos recusados; a conta inteira pelo `/mcp`) e o schema no `packages/shared/test/agents.test.ts`.
- Verificação: `pnpm verify:quick` (Biome, typecheck, os testes do shared relacionados e, passados depois de `--`, os de integração `agents`, `agent-tools`, `agent-tools-admin`, `titles`, `cards`, `contracts`, `statements`, `vision`, `reconcile-recipes`, `statement-supersede`, `autonomous` e `budgets` no Postgres local). Não rodei `verify:full` nem o e2e.
