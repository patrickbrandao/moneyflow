---
status: concluida
tipo: melhoria
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-10-13
commit:
---

# Agente estorna a baixa de um casamento errado (`reverse_settlement`)

## Descrição
Depois da tarefa 008, o agente desfaz a conciliação de uma linha (`unmatch_statement_line`), mas a baixa criada ao casar a linha com o título errado continua lançada: o título segue (parcial ou totalmente) baixado e a conta mantém o movimento. Não há tool para estornar a baixa (`settlements.reverseSettlement`, `POST /api/settlements/:id/reverse`), então o agente não corrige o erro sozinho.

## Como reproduzir
Importar um OFX, pedir ao agente para casar uma linha com o título errado (vira baixa) e depois para corrigir: ele desfaz a conciliação, mas não tem como estornar a baixa; o título errado continua baixado.

## Análise (triagem)
Só aplicação: `packages/shared/src/agents/tools.ts` (`AGENT_TOOLS`) e `apps/server/src/agents/tool-handlers.ts` (`TOOL_HANDLERS`), sobre `reverseSettlement` com o schema `settlementReverseInput`. Spec 011. Executor: app.

## Resolução (executor)
- Tool de escrita `reverse_settlement` (destrutiva; `destructiveHint` no `/mcp`): `settlementId` + os campos de `settlementReverseInput` (`reason`, `reversedOn` — omitida = hoje —, `undoTransfer`), executada por `reverseSettlement` com a mesma autorização da API.
- Prévia ("Estornar pagamento/recebimento", ação `delete`): título e entidade, data da baixa, valor, conta (ou "conta a definir"), a perna do espelho (caixa e conta, quando legível), a transferência gerada (desfeita ou mantida), o em aberto antes → depois, a data e o motivo. Avisa que cada perna recebe o movimento oposto e, se uma linha do extrato ainda está conciliada com o movimento da baixa, para desfazê-la antes com `unmatch_statement_line`. Baixa já estornada ou estorno antes da data da baixa voltam ao modelo como erro, sem pedir confirmação.
- A descrição e o aviso da prévia de `unmatch_statement_line` apontam para `reverse_settlement`.
- Teste (`apps/server/test/agents.test.ts`, "casamento errado corrigido pelo agente", provedor falso): linha casada com o título errado (espelhado na caixa B); estorno pedido antes de desfazer mostra o aviso e é recusado; desfaz; estorno com prévia (valor, data, conta, perna do espelho, em aberto) aprovado; título e espelho voltam a em aberto, a baixa fica estornada com o motivo, os movimentos dela somam zero, auditoria com ator `agent`; estornar de novo devolve o erro; a linha é casada com o título certo.
- Spec 011: lista de tools de escrita e a correção de um casamento errado.
