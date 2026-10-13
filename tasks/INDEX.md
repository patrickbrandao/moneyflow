# Tarefas

Tarefas de revisão e correção pedidas entre agentes e achados do usuário. Formato, papéis e ciclo de vida em [docs/017-tarefas-entre-agentes.md](../docs/017-tarefas-entre-agentes.md). Abertas primeiro; concluídas e rejeitadas ficam como histórico.

| Nº | Tarefa | Status | Tipo | Responsável | Origem |
|---|---|---|---|---|---|
| 004 | [Aviso de conclusão do agente com várias réplicas da API](004-aviso-de-conclusao-multi-replica.md) (escopo: `dedup_key` por evento; presença no banco adiada) | concluida | debito-tecnico | app | agente |
| 006 | [Cobrir no e2e os fluxos do agente ainda sem teste contra a API real](006-front-sem-teste-contra-api-real.md) | em-andamento | debito-tecnico | app | agente |
| 011 | [Gravar e mostrar o uso de IA por finalidade](011-gravar-e-mostrar-uso-ia-por-finalidade.md) (depois da 001 e da 013) | concluida | melhoria | app | agente |
| 012 | [Escolher o agente dos fluxos em /admin/ai e remover `AI_FLOW_AGENT`](012-escolher-agente-dos-fluxos-na-tela.md) (depois da 002) | em-andamento | melhoria | app | agente |
| 013 | [Usar `ai_conversations.purpose` em vez de `screen_context.purpose`](013-usar-coluna-de-finalidade-da-conversa.md) (depois da 003) | concluida | debito-tecnico | app | agente |
| 005 | [Rastro de ator nas sugestões do agente em linhas de extrato](005-auditoria-das-sugestoes-no-extrato.md) (já atendido: `statement_lines` é auditada desde a 0015) | rejeitada | banco | dba | agente |
| 001 | [Separar o uso de IA da leitura de documento e da classificação](001-uso-ia-por-finalidade.md) (banco; junto com a 003; depois vêm 013 e 011) | concluida | banco | dba | agente |
| 002 | [Marcar no banco qual agente atende os fluxos automáticos](002-agente-dos-fluxos-no-banco.md) (banco; depois vem a 012) | concluida | banco | dba | agente |
| 003 | [Coluna própria para a finalidade da conversa](003-finalidade-da-conversa.md) (banco; junto com a 001; depois vem a 013) | concluida | banco | dba | agente |
| 007 | [Trocar as cores de tom roxo para tom azul em todo o frontend](007-acento-roxo-para-azul.md) | concluida | melhoria | app | usuario |
| 008 | [Agente concilia um lote inteiro do extrato (espelho, pagadora, desfazer, ignorar, candidatos e lote)](008-agente-conciliacao-completa.md) | concluida | melhoria | app | usuario |
| 009 | [Trocar ou dispensar o espelho ao lançar a linha do extrato como título](009-espelho-ao-lancar-linha-do-extrato.md) | concluida | melhoria | app | agente |
| 010 | [Agente estorna a baixa de um casamento errado (`reverse_settlement`)](010-agente-estorna-baixa.md) | concluida | melhoria | app | agente |
