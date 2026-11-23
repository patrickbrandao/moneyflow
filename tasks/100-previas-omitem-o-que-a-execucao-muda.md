---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 5d66b57
---

# Cartão de aprovação não mostra parte do que a tool vai mudar (agente, série, senha, encerrar série)

- **Severidade:** média
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** prévia infiel à execução
- **Arquivos afetados:** `apps/server/src/agents/tool-handlers-admin.ts:186-214,584-600,760-794`, `apps/server/src/services/ai-admin.ts:576-586,610-662`, `apps/server/src/agents/tool-handlers-operation.ts:432-465`, `apps/server/src/services/series.ts:537-671,698-730`, `apps/server/src/services/users.ts:121-127`, `apps/server/src/agents/tool-handlers.ts:516-545`, `packages/shared/src/agents/preview.ts:50-64`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O cartão "Aplicar?" deveria mostrar o antes e o depois do que o agente vai fazer. Em algumas ferramentas ele mostra menos do que acontece: o usuário aprova "Editar agente" com o cartão vazio e o agente muda de temperatura, de provedor de visão ou de servidores MCP; aprova "Editar série" e não vê quantas parcelas mudam nem a troca da pagadora.

### Evidência e análise técnica
`diffRows` (`preview.ts:50-64`) só lista os campos de `fields` que mudam de texto. Onde o texto não representa a mudança, ela some:
- **`update_ai_agent`** (`tool-handlers-admin.ts:775-794`, campos em `:202-214`, valores em `:186-200`):
  - `params` (temperatura, `max_tokens`, `max_tool_iterations`, raciocínio) e `icon` não estão em `AGENT_FIELDS`: mudam sem linha nenhuma;
  - `inferences` vira só a lista de nomes das capacidades (`:194-197`): trocar o provedor ou o modelo da visão mantém "Visão" → "Visão", e a linha não aparece;
  - `mcpServers` vira "N servidor(es)" (`:198`): trocar um servidor por outro não aparece;
  - `defaultProviderId` não aparece, mas `applyDefaultProvider` (`ai-admin.ts:576-586`) troca o provedor de texto e preenche as inferências que não vieram.
- **`create_ai_agent`** (`:760-772`): com `defaultProviderId`, a prévia usa `parsed.inferences` (só as explícitas; sem elas, a linha "Inferências" nem aparece); as que o serviço preenche a partir do provedor padrão (`ai-admin.ts:613,628`) ficam de fora, e `params` também.
- **`update_series`** (`tool-handlers-operation.ts:432-465`): não mostra `payerCaixaId` (só entra na conta do aviso, `:451-453`) nem as ocorrências afetadas. O serviço tem o plano pronto: `planSeriesChange(ctx, tx, rule, change, effectiveOn, lock=false)` (`series.ts:537-671`) devolve `affected`, `skipped` e `cardFrom`, e é o que `updateSeries` aplica (`:724-727`). Mudar o `anchorDay` move o vencimento de todas as seguintes em aberto, e o cartão só diz "Dia: 10 → 15". O `add_contract_amendment` faz o certo e lista as ocorrências pelo `dryRun` (`tool-handlers-operation.ts:331-358`).
- **`set_user_password`** na própria conta (`tool-handlers-admin.ts:592`): `warnings: i.userId === actor ? [] : [...]`. Mas `updateUser` (`users.ts:121-127`) encerra as outras sessões do próprio usuário também (tarefa 067): o cartão não avisa.
- **`end_series` por `ruleId`** (`tool-handlers.ts:518-520,543`): monta o alvo com `mirrorTitleId: null`, então o aviso "O espelho de cada ocorrência também é cancelado" nunca aparece por esse caminho, mesmo com ocorrências espelhadas.

### Verificação (tentativa de refutação)
- `AGENTS.md` (Regras, "Agentes"): escritas com `preview`; `docs/027` ("As escritas têm `preview` (antes→depois e avisos)"). A prévia existe, mas não cobre o que muda.
- Os testes de prévia conferem os campos que aparecem (`agent-tools-admin.test.ts`), não os que faltam.
- Nos cenários acima a execução segue normalmente, sem erro: o usuário aprova sem ver a mudança.

### Impacto
Aprovação às cegas de mudanças de configuração (custo e comportamento dos agentes, inclusive o dos fluxos automáticos) e de mudanças em séries com dinheiro (valor e vencimento de várias parcelas futuras). Afeta quem usa kits com essas tools em `ask`, que é o modo sugerido.

## Como reproduzir
1. Admin com `update_ai_agent` em `ask`: "mude a temperatura do agente X para 1,5 e o provedor de visão para Y". O cartão "Editar agente" vem sem linhas.
2. Série com 8 ocorrências em aberto: "passe o vencimento da série para o dia 20". O cartão mostra "Dia: 10 → 20" e o aviso genérico, sem as 8 ocorrências e as datas novas.

## Solução proposta
- `update_ai_agent`/`create_ai_agent`: linhas para `params` (por chave), `icon`, cada inferência como "capacidade: provedor · modelo", os servidores MCP pelo nome e o efeito do `defaultProviderId` (aplicar `applyDefaultProvider` na prévia, exportando-o de `ai-admin.ts`).
- `update_series`: chamar `planSeriesChange(..., lock=false)` dentro de uma leitura e listar `affected` (até 24, como no aditivo), `skipped` e `cardFrom`; acrescentar a linha da pagadora.
- `set_user_password` na própria conta: "As suas outras sessões são encerradas (fica só esta)".
- `end_series` por `ruleId`: saber se há ocorrência espelhada a cancelar (o plano já tem as ocorrências).

## Critérios de aceite
- [ ] Toda mudança que a execução aplica tem uma linha ou um aviso no cartão nas tools acima.
- [ ] A prévia do `update_series` lista as ocorrências que mudam, como a do aditivo.

## Testes recomendados
- `apps/server/test/agent-tools-admin.test.ts`: `update_ai_agent` só com `params` e só trocando o provedor de uma inferência → a prévia tem a linha.
- `apps/server/test/contracts.test.ts` (ou `agent-tools.test.ts`): `update_series` com `anchorDay` → a prévia lista as ocorrências e as datas novas, iguais às gravadas depois.
- `set_user_password` no próprio admin → o aviso de sessões.

## Limitações e suposições
Não verifiquei a tela equivalente (`SeriesEditModal`), que talvez já mostre o plano por outra rota; a proposta é a prévia da tool usar o mesmo plano do serviço.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `update_ai_agent`/`create_ai_agent` não mostravam `params`, `icon`, a troca de provedor de uma inferência, os servidores MCP pelo nome nem o efeito do `defaultProviderId`; `update_series` não mostrava a pagadora nem as ocorrências; `set_user_password` na própria conta não avisava; `end_series` por `ruleId` nunca dava o aviso do espelho.

## Resolução (executor)

- `tool-handlers-admin.ts`: `agentValues` com um campo por parâmetro (`param:<nome>`, ausente = null, porque a gravação troca o conjunto), as inferências como "Visão: Provedor · modelo" (modelo nulo = "modelo padrão"), os servidores MCP pelo nome (com as tools quando parciais) e o ícone; `agentInputAsSaved` aplica o `applyDefaultProvider` do serviço (exportado de `ai-admin.ts`) antes do diff, com o aviso do provedor padrão.
- `update_series` (`tool-handlers-operation.ts`): a linha da caixa pagadora e as ocorrências que mudam pelo mesmo plano que a execução aplica (`previewSeriesUpdate` em `services/series.ts`, sobre `planSeriesChange` com `lock = false`; até 24, como no aditivo), a cobrança do cartão e os avisos de quantas mudam e quantas ficam.
- `set_user_password` na própria conta: "As suas outras sessões são encerradas (fica só a do console em que você aprovar)".
- `end_series`: o aviso do espelho pelas próprias ocorrências canceladas (vale pelo `titleId` e pelo `ruleId`).
- Testes: `agent-tools-admin.test.ts` (criar com o provedor padrão, só `params`, só a troca do provedor da visão, ícone e a própria senha) e `agent-tools.test.ts` (o `update_series` com `anchorDay` lista as ocorrências e as datas, iguais às gravadas).
- Verificação: `pnpm verify:quick` (Biome, typecheck, os testes do shared relacionados e, passados depois de `--`, os de integração `agents`, `agent-tools`, `agent-tools-admin`, `titles`, `cards`, `contracts`, `statements`, `vision`, `reconcile-recipes`, `statement-supersede`, `autonomous` e `budgets` no Postgres local). Não rodei `verify:full` nem o e2e.
