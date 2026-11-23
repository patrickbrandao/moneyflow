# MoneyFlow — Índice das especificações

## Especificação geral

MoneyFlow é um sistema multiusuário para contas a pagar e a receber, contas financeiras com conciliação de extrato, cartões de crédito, contratos, gestão de várias casas e empresas, e agentes de IA assistentes.

O usuário quer ver todas as contas organizadas por **caixa** e enxergar o **fluxo de dinheiro entre caixas e entidades**, rastreável até o recebedor final. Uma entidade (pessoa ou empresa) pode receber (nós pagamos a ela) ou pagar (recebemos dela).

Conceitos centrais:

- **Entidade**: pessoa (CPF) ou empresa (CNPJ). Cadastro global, com chaves PIX e dados bancários.
- **Caixa**: o livro financeiro de um titular (entidade). É a unidade de permissão. Não existe camada de "Espaço" acima dela.
- **Conta financeira**: conta corrente, cofre ou poupança/investimento, sempre dentro de uma caixa.
- **Título**: a pagar ou a receber, dentro de uma caixa. É liquidado por **baixas**, e cada baixa gera **movimentos**.
- **Espelho**: quando a contraparte de um título é titular de uma caixa, o lado oposto é criado nela e fica ligado ao original.
- **Cartão de crédito**: uma caixa própria. As compras ficam nela, e a fatura é um título espelhado em cada caixa pagadora.
- **Contrato**: documento e vínculo com uma entidade (eu recebo ou eu pago), com vigência, documentos em PDF e markdown e obrigações em séries recorrentes nas contas ou no cartão; aditivo, renovação (manual ou automática pelo worker) e rescisão operam sobre as séries.

Stack: monorepo pnpm, Node/TypeScript (Fastify, Drizzle), React 19 com Vite, PostgreSQL 18 com pgvector e imagem Docker única `tmsoftbrasil/moneyflow`. O banco vive em `database/` e é gerido por um subagente DBA independente. Decisões tomadas em 2026-10-10.

## Convenções destes documentos

- Cada especificação fica em `docs/nnn-titulo.md`: número de 3 dígitos com zeros à esquerda e título em kebab-case, em português.
- Uma especificação nova recebe o próximo número livre e entra na tabela abaixo no mesmo commit.
- Uma decisão alterada é atualizada no arquivo dela, não acrescentada como nota avulsa.
- A tabela tem uma frase por especificação. O resumo completo fica na linha **Conteúdo** do topo de cada uma, e o estado das fases só na [015](015-fases.md).

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| [001-stack-e-entrega.md](001-stack-e-entrega.md) | Stack, monorepo (e onde ficam as instruções dos agentes), testes e os dois níveis de verificação, configuração, imagem Docker, Compose, CI/CD, cabeçalhos de segurança, locale e moeda. |
| [002-usuarios-e-permissoes.md](002-usuarios-e-permissoes.md) | Usuários, a senha em texto puro e onde ela nunca aparece, login e sessão, admin inicial e os papéis globais e por caixa. |
| [003-entidades.md](003-entidades.md) | Pessoas e empresas, CPF e CNPJ (o alfanumérico inclusive), autopreenchimento de CNPJ e CEP, PIX, dados bancários, tags e favoritas. |
| [004-caixas-e-contas.md](004-caixas-e-contas.md) | Caixas e contas financeiras, a tela da conta (resumo, extrato, conciliação e previstos), o filtro de período e as listagens que cortam no servidor. |
| [005-titulos-baixas-e-movimentos.md](005-titulos-baixas-e-movimentos.md) | Títulos, baixas e estorno, movimentos, recorrência e parcelamento (a série com a conta prevista e os ajustes), transferências e o pagamento por outra caixa. |
| [006-espelhamento-entre-caixas.md](006-espelhamento-entre-caixas.md) | O título espelho na caixa da contraparte, o aceite pendente e a baixa com duas pernas. |
| [007-cartao-de-credito.md](007-cartao-de-credito.md) | O cartão como caixa: compras, parcelas, estornos, faturas por pagadora, pagamento, encargos e a cobrança recorrente esperada. |
| [008-categorias-auditoria-e-exclusao.md](008-categorias-auditoria-e-exclusao.md) | Plano global de categorias, regimes de competência e de caixa, arquivar em vez de excluir, auditoria e fechamento de mês. |
| [009-extratos-e-conciliacao.md](009-extratos-e-conciliacao.md) | Import OFX/CSV, deduplicação, casamento assistido, divergência de saldo, regras de classificação e o desfazer da conciliação. |
| [010-entrada-de-titulos.md](010-entrada-de-titulos.md) | Boleto, PIX copia-e-cola, leitura de PDF/imagem por IA e import de NF-e. |
| [011-agentes-de-ia.md](011-agentes-de-ia.md) | Agentes de IA: provedores, agentes, tools com prévia e aprovação, MCP (cliente e `/mcp`), execução no worker com SSE, uso e custo, a IA nos fluxos e o mapa da F7 à F16. |
| [012-calendario.md](012-calendario.md) | Calendário: visões, reagendamento e saldo projetado. |
| [013-mensagens-telegram.md](013-mensagens-telegram.md) | Telegram: destinos, eventos, a fila de envio, o sino e a entrada por webhook. |
| [014-visualizacao-e-relatorios.md](014-visualizacao-e-relatorios.md) | Canvas de fluxo de dinheiro, relatórios, filtro por entidade, exportação CSV/PDF e o formato contábil dos valores. |
| [015-fases.md](015-fases.md) | As fases F1 a F21, o estado de cada uma e as especificações que cobrem. |
| [016-banco-de-dados.md](016-banco-de-dados.md) | O banco e o agente DBA: Postgres 18 com pgvector, migrations, o dono sem superusuário, os segredos blindados, as regras de integridade de cada área e o ator da sessão. |
| [017-tarefas-entre-agentes.md](017-tarefas-entre-agentes.md) | As tarefas entre agentes em `tasks/`: formato, triagem, executores e ciclo de vida. |
| [018-versoes-e-publicacao.md](018-versoes-e-publicacao.md) | Versões 0.1.x, a publicação (`make release` com o `release-check`, ou o CI), versões fixas, parada e healthcheck da imagem e os prazos do Postgres. |
| [019-backup-e-restauracao.md](019-backup-e-restauracao.md) | Backup e restauração: exportar e importar com merge, dump do PostgreSQL e o JSON completo. |
| [020-contratos.md](020-contratos.md) | Contratos como documento e vínculo: vigência, obrigações em séries, aditivo, renovação e rescisão, documentos PDF e markdown e os avisos. |
| [021-kit-de-ferramentas.md](021-kit-de-ferramentas.md) | F7: kits de ferramentas dos agentes, com as tools liberadas e o modo `allow`/`ask` de cada uma. |
| [022-prompts-e-instrucoes.md](022-prompts-e-instrucoes.md) | F8: montagem do prompt com cache, instruções do usuário, contexto automático, variáveis, versões do prompt e as `instructions` dos MCP. |
| [023-requisicoes-ao-provedor.md](023-requisicoes-ao-provedor.md) | F9: registro das requisições ao provedor, tentativas próprias, retenção e o detalhe do provedor. |
| [024-capacidades-dos-provedores.md](024-capacidades-dos-provedores.md) | F10: capacidades dos provedores, provedor por inferência no agente, visão, embeddings por par em uso e o uso de áudio. |
| [025-chat-multimidia.md](025-chat-multimidia.md) | F11: chat multimídia, com prévias, gravação e transcrição de áudio, player e modo áudio. |
| [026-sessoes-dos-agentes.md](026-sessoes-dos-agentes.md) | F12: sessões dos agentes, o fio por usuário e agente, uma sessão ativa, finalizar e bifurcar. |
| [027-tools-de-controle-total.md](027-tools-de-controle-total.md) | F13: tools de controle total, as de admin, os segredos digitados no cartão e os arquivos gerados. |
| [028-limites-e-uso.md](028-limites-e-uso.md) | F14: orçamentos mensais, limite de execuções por minuto e o painel de uso. |
| [029-fluxos-autonomos.md](029-fluxos-autonomos.md) | F15: tarefas agendadas, conciliação completa ao importar e conversa pelo Telegram. |
| [030-receitas-de-conciliacao.md](030-receitas-de-conciliacao.md) | F16: receitas de conciliação, instruções reutilizáveis com o seu agente, rodadas pelo play no lote ou ao importar. |
| [031-lote-provisorio-e-consolidado.md](031-lote-provisorio-e-consolidado.md) | F17: o lote provisório de extrato e a troca pelo consolidado, transferindo as conciliações. |
| [032-regras-de-classificacao-por-conta.md](032-regras-de-classificacao-por-conta.md) | F18: regras de classificação por conta (e por cartão), a migração e a cópia entre contas. |
| [033-pagamentos-de-contrato-no-extrato.md](033-pagamentos-de-contrato-no-extrato.md) | F19, generalizada na F20: o pagamento das séries reconhecido no extrato, com a conta prevista, os ajustes, a baixa repartida e a guia Pagamentos do contrato. |
| [034-contratos-sobre-series.md](034-contratos-sobre-series.md) | F20: contratos sobre séries, com as obrigações nas contas ou no cartão, aditivo, renovação e rescisão pela série e a migração. |
| [035-anotacoes.md](035-anotacoes.md) | F21: anotações e lembretes presos à entidade, com alarme, sino, Telegram, calendário, tools e `/mcp`. |
