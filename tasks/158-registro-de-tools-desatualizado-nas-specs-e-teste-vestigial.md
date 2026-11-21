---
status: aberta
tipo: debito-tecnico
origem: agente
autor: principal
responsavel:
prioridade: baixa
criada: 2026-11-21
commit:
---

# Specs 021 e 027 descrevem tools de contrato e de regra que não existem mais, e um teste confere uma tool removida

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência (spec × código)
- **Subcategoria:** documentação desatualizada / teste que engana
- **Arquivos afetados:** `docs/021-kit-de-ferramentas.md:25-41`, `docs/027-tools-de-controle-total.md:34-35,64`, `packages/shared/test/agents.test.ts:152`, `packages/shared/src/agents/tools-operation.ts:64-229`
- **Depende de / relacionado a:** —
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
As especificações das ferramentas dos agentes ainda falam do modelo antigo de contratos (parcelas e "decidir renovação") e de regras globais, que saíram nas fases F18 e F20. Quem lê a spec para mexer nas tools é levado a erro, e um teste dá verde sem testar nada.

### Evidência e análise técnica
- `docs/027:34-35`: `get_contract` com "ciclos, parcelas, … tarefa de renovação"; `create_contract` "sempre rascunho: a tool não tem o `activate` da API"; `activate_contract` "gera as parcelas"; `decide_contract_renewal`. O código (`tools-operation.ts:64-229`) tem `create_contract` com obrigações e `activate` (nasce vigente), `activate_contract` que só ativa, `renew_contract`, `add_contract_obligation`, `link_series_to_contract`, `get_series`, `create_series` e `update_series`; não existe `decide_contract_renewal`.
- `docs/027:64`: "a regra global exige admin" — a F18 (`docs/032`) acabou com a regra global.
- `docs/021:25-41`, a tabela das categorias (a da tela do kit): traz `decide_contract_renewal` e não traz as tools de série, `renew_contract`, `create_card_charge_from_line`, `copy_classification_rules`, orçamentos, tarefas agendadas, receitas, provisório e anotações.
- `packages/shared/test/agents.test.ts:152`: `expect(() => agentTool('decide_contract_renewal')!.input.parse({...})).toThrow()`. Como a tool não existe, `agentTool` devolve `undefined` e o `TypeError` de `undefined.input` satisfaz o `toThrow()`: o teste passa sem conferir regra nenhuma.

### Verificação (tentativa de refutação)
- `docs/INDEX.md` diz que a 034 substitui o ciclo de parcelas da 020, mas a regra do projeto é atualizar o arquivo da decisão ("Uma decisão alterada é atualizada no arquivo dela", `docs/INDEX.md`, Convenções); a 027 diz que os nomes são "indicativos", mas descreve o comportamento.
- A 011 (`docs/011:57-58`) já está atualizada para a F20; a 021 e a 027 não.

### Impacto
Retrabalho e decisões erradas de quem segue a spec (humano ou agente de código); o teste vestigial dá falsa cobertura.

## Como reproduzir
Ler `docs/027:35` e procurar `decide_contract_renewal` em `packages/shared/src/agents`: não existe. Rodar `pnpm --filter @moneyflow/shared exec vitest run test/agents.test.ts`: passa.

## Solução proposta
- `docs/027`: reescrever o bloco de Contratos com as tools da F20 (obrigações, séries, renovar, aditivo e rescisão sobre as séries) e tirar a "regra global" do bloco de regras.
- `docs/021`: refazer a tabela a partir do registro (ou trocar por "a lista vem de `AGENT_TOOLS`, agrupada por `category`", para não desatualizar de novo).
- `agents.test.ts:152`: apagar a linha ou trocar por `expect(agentTool('decide_contract_renewal')).toBeUndefined()`.

## Critérios de aceite
- [ ] Toda tool citada na 021 e na 027 existe no registro, e as do registro estão na tabela da 021 (ou a tabela deixa de existir).
- [ ] Nenhum teste chama `.input` de uma tool que pode não existir.

## Testes recomendados
`packages/shared/test/agents.test.ts`: um caso que lê os nomes entre crases da tabela da `docs/021` e confere contra `AGENT_TOOL_NAMES` (opcional; evita a deriva).

## Limitações e suposições
A conferência das specs foi por leitura e `grep`. `test/agents.test.ts` do shared foi rodado nesta revisão (16 testes, todos passam, inclusive o da linha 152).

## Análise (triagem)

## Resolução (executor)
