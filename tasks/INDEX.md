# Tarefas

Tarefas de revisão e correção pedidas entre agentes e achados do usuário. Formato, papéis e ciclo de vida em [docs/017-tarefas-entre-agentes.md](../docs/017-tarefas-entre-agentes.md). Abertas primeiro; concluídas e rejeitadas ficam como histórico.

| Nº | Tarefa | Status | Tipo | Responsável | Origem |
|---|---|---|---|---|---|
| 035 | [Receitas de conciliação no banco (F16)](035-receitas-de-conciliacao-no-banco.md) | concluida | banco | dba | usuario |
| 036 | [Receitas de conciliação na aplicação (F16)](036-receitas-de-conciliacao-na-aplicacao.md) (depois da 035) | aberta | melhoria | app | usuario |
| 030 | [Orçamentos, visões de uso e avisos no banco (F14)](030-orcamentos-e-limites-no-banco.md) (depois da F13) | concluida | banco | dba | usuario |
| 031 | [Orçamentos com aviso e bloqueio, limite por minuto e painel de uso (F14)](031-orcamentos-e-limites-na-aplicacao.md) (depois da 030) | concluida | melhoria | app | usuario |
| 032 | [Tarefas agendadas, conciliação com IA e Telegram de entrada no banco (F15)](032-fluxos-autonomos-no-banco.md) (depois da F14) | concluida | banco | dba | usuario |
| 033 | [Tarefas agendadas, conciliação completa ao importar e conversa pelo Telegram (F15)](033-fluxos-autonomos-na-aplicacao.md) (depois da 032 e da 034) | concluida | melhoria | app | usuario |
| 034 | [Leitura do token do bot para a entrada do Telegram (F15)](034-token-do-bot-para-a-entrada-do-telegram.md) (banco; pedida pela 033) | concluida | banco | dba | agente |
| 029 | [Tools de controle total, lote F13b (administração e segredos)](029-tools-controle-total-lote-b.md) (depois da 028) | concluida | melhoria | app | usuario |
| 028 | [Tools de controle total, lote F13a (operação)](028-tools-controle-total-lote-a.md) (depois da F12) | concluida | melhoria | app | usuario |
| 027 | [Fio por agente, finalizar sessão e sessões anteriores (F12)](027-sessoes-dos-agentes-na-aplicacao.md) (depois da 026) | concluida | melhoria | app | usuario |
| 026 | [Sessão ativa única por usuário e agente no banco (F12)](026-sessoes-dos-agentes-no-banco.md) (depois da F11) | concluida | banco | dba | usuario |
| 025 | [Prévias, gravação, transcrição, player e modo áudio no chat (F11)](025-chat-multimidia-na-aplicacao.md) (depois da 024) | concluida | melhoria | app | usuario |
| 024 | [Áudio gerado por mensagem e metadados de anexo no banco (F11)](024-chat-multimidia-no-banco.md) (depois da F10) | concluida | banco | dba | usuario |
| 023 | [Capacidades, Anthropic compatível, provedor por inferência e visão por descrição (F10)](023-capacidades-dos-provedores-na-aplicacao.md) (depois da 022) | concluida | melhoria | app | usuario |
| 022 | [Capacidades, inferências por agente, derivados de anexo e embeddings por modelo no banco (F10)](022-capacidades-dos-provedores-no-banco.md) (depois da F9) | concluida | banco | dba | usuario |
| 021 | [Registro de requisições, tentativas próprias e detalhe do provedor (F9)](021-requisicoes-ao-provedor-na-aplicacao.md) (depois da 020) | concluida | melhoria | app | usuario |
| 020 | [Requisições, tentativas e app_settings no banco (F9)](020-requisicoes-ao-provedor-no-banco.md) (depois da F8) | concluida | banco | dba | usuario |
| 019 | [Montagem do prompt, variáveis, versões e instructions do MCP na aplicação (F8)](019-prompts-e-instrucoes-na-aplicacao.md) (depois da 018) | concluida | melhoria | app | usuario |
| 018 | [Instruções do usuário, versões do prompt e instructions do MCP no banco (F8)](018-prompts-e-instrucoes-no-banco.md) (depois da F7 (017)) | concluida | banco | dba | usuario |
| 017 | [Kit de ferramentas na aplicação (F7)](017-kit-de-ferramentas-na-aplicacao.md) (depois da 016) | concluida | melhoria | app | usuario |
| 016 | [Kit de ferramentas no banco (F7)](016-kit-de-ferramentas-no-banco.md) (primeira da F7; depois vem a 017) | concluida | banco | dba | usuario |
| 004 | [Aviso de conclusão do agente com várias réplicas da API](004-aviso-de-conclusao-multi-replica.md) (escopo: `dedup_key` por evento; presença no banco adiada) | concluida | debito-tecnico | app | agente |
| 006 | [Cobrir no e2e os fluxos do agente ainda sem teste contra a API real](006-front-sem-teste-contra-api-real.md) | concluida | debito-tecnico | app | agente |
| 011 | [Gravar e mostrar o uso de IA por finalidade](011-gravar-e-mostrar-uso-ia-por-finalidade.md) (depois da 001 e da 013) | concluida | melhoria | app | agente |
| 012 | [Escolher o agente dos fluxos em /admin/ai e remover `AI_FLOW_AGENT`](012-escolher-agente-dos-fluxos-na-tela.md) (depois da 002) | concluida | melhoria | app | agente |
| 013 | [Usar `ai_conversations.purpose` em vez de `screen_context.purpose`](013-usar-coluna-de-finalidade-da-conversa.md) (depois da 003) | concluida | debito-tecnico | app | agente |
| 015 | [CNPJ alfanumérico em toda a aplicação](015-cnpj-alfanumerico-na-aplicacao.md) (depois da 014) | concluida | bug | app | agente |
| 014 | [Chave de acesso da NF-e com CNPJ alfanumérico no banco (NT 2025.001)](014-chave-nfe-cnpj-alfanumerico-no-banco.md) (banco; depois vem a 015) | concluida | banco | dba | agente |
| 005 | [Rastro de ator nas sugestões do agente em linhas de extrato](005-auditoria-das-sugestoes-no-extrato.md) (já atendido: `statement_lines` é auditada desde a 0015) | rejeitada | banco | dba | agente |
| 001 | [Separar o uso de IA da leitura de documento e da classificação](001-uso-ia-por-finalidade.md) (banco; junto com a 003; depois vêm 013 e 011) | concluida | banco | dba | agente |
| 002 | [Marcar no banco qual agente atende os fluxos automáticos](002-agente-dos-fluxos-no-banco.md) (banco; depois vem a 012) | concluida | banco | dba | agente |
| 003 | [Coluna própria para a finalidade da conversa](003-finalidade-da-conversa.md) (banco; junto com a 001; depois vem a 013) | concluida | banco | dba | agente |
| 007 | [Trocar as cores de tom roxo para tom azul em todo o frontend](007-acento-roxo-para-azul.md) | concluida | melhoria | app | usuario |
| 008 | [Agente concilia um lote inteiro do extrato (espelho, pagadora, desfazer, ignorar, candidatos e lote)](008-agente-conciliacao-completa.md) | concluida | melhoria | app | usuario |
| 009 | [Trocar ou dispensar o espelho ao lançar a linha do extrato como título](009-espelho-ao-lancar-linha-do-extrato.md) | concluida | melhoria | app | agente |
| 010 | [Agente estorna a baixa de um casamento errado (`reverse_settlement`)](010-agente-estorna-baixa.md) | concluida | melhoria | app | agente |
