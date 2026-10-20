# 015 — Fases de entrega

1. **F1, Núcleo**: banco e agente DBA ([016](016-banco-de-dados.md)); monorepo, Docker, CI; auth, usuários e permissões ([002](002-usuarios-e-permissoes.md)); entidades, PIX e dados bancários ([003](003-entidades.md)); caixas e contas ([004](004-caixas-e-contas.md)); categorias ([008](008-categorias-auditoria-e-exclusao.md)); títulos, baixas, recorrência, transferências ([005](005-titulos-baixas-e-movimentos.md)) e espelhamento ([006](006-espelhamento-entre-caixas.md)).
2. **F2, Operação**: cartão ([007](007-cartao-de-credito.md)); OFX/CSV e conciliação ([009](009-extratos-e-conciliacao.md)); calendário ([012](012-calendario.md)); anexos; auditoria e fechamento de mês ([008](008-categorias-auditoria-e-exclusao.md)); boleto, PIX copia-e-cola e NF-e ([010](010-entrada-de-titulos.md)).
3. **F3, Visão**: canvas, relatórios e exportações ([014](014-visualizacao-e-relatorios.md)); Telegram ([013](013-mensagens-telegram.md)).
4. **F4, IA**: agentes, janelas, tools, MCP client/server, sugestões e leitura de documentos ([011](011-agentes-de-ia.md)).
5. **F5, Contratos**: contratos, documentos, renovação e avisos ([020](020-contratos.md)).
6. **F6, Cadastro organizado**: tags e favoritas de entidade, filtro por entidade em relatórios e canvas, e o CNPJ alfanumérico em todo o sistema ([003](003-entidades.md), [014](014-visualizacao-e-relatorios.md)).
7. **F7, Kit de Ferramentas**: perfis de tools com `allow`/`ask` por tool e categorias; substitui a lista de tools e a flag de confirmação do agente ([021](021-kit-de-ferramentas.md)).
8. **F8, Prompts e instruções**: instruções do usuário, contexto automático, variáveis, versões do prompt e as `instructions` dos MCP ([022](022-prompts-e-instrucoes.md)).
9. **F9, Requisições**: registro das requisições ao provedor com tentativas, retenção (variável e banco) e detalhe do provedor ([023](023-requisicoes-ao-provedor.md)).
10. **F10, Capacidades**: flags e modelos por capacidade no provedor, Anthropic compatível, provedor por inferência no agente, visão por descrição e embeddings por modelo em uso ([024](024-capacidades-dos-provedores.md)).
11. **F11, Chat multimídia**: prévia de imagem/PDF/markdown, gravação e transcrição de áudio, player com velocidades e modo áudio ([025](025-chat-multimidia.md)).
12. **F12, Sessões**: fio contínuo por usuário e agente, dividido em sessões; finalizar sessão ([026](026-sessoes-dos-agentes.md)).
13. **F13, Controle total**: tools para tudo o que a interface faz, inclusive a configuração de IA, usuários e backup, em dois lotes F13a/F13b ([027](027-tools-de-controle-total.md)).
14. **F14, Limites e uso**: orçamentos mensais com aviso e bloqueio, limite de execuções por minuto e painel de uso ([028](028-limites-e-uso.md)).
15. **F15, Fluxos autônomos**: tarefas agendadas, conciliação completa ao importar e conversa pelo Telegram por webhook ([029](029-fluxos-autonomos.md)).
16. **F16, Receitas de conciliação**: instruções reutilizáveis de conciliação, cada uma com o seu agente, rodadas pelo play na tela do lote numa sessão nova e em sequência ao importar ([030](030-receitas-de-conciliacao.md); entregue).
17. **F17, Lote provisório**: extrato parcial do mês como lote provisório e a troca pelo consolidado do banco, transferindo as conciliações sem relançar ([031](031-lote-provisorio-e-consolidado.md); entregue).
18. **F18, Regras por conta**: regras de classificação exclusivas de cada conta (e de cada cartão), sem regra global, com a cópia entre contas pela tela e pelos agentes ([032](032-regras-de-classificacao-por-conta.md)). Entregue (tarefas 039 e 040).
19. **F19, Pagamentos de contrato no extrato**: conta das parcelas (com troca por parcela e caixa pagadora), a parcela achada no mesmo mês com encargos, desconto e tolerância, baixa repartida e opcionalmente sem confirmação, e a seção Pagamentos com gráficos no detalhe do contrato ([033](033-pagamentos-de-contrato-no-extrato.md)). Entregue (tarefas 041 e 042).
