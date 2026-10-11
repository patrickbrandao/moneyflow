# MoneyFlow — Índice das especificações

## Especificação geral

MoneyFlow é um sistema multiusuário para contas a pagar e a receber, contas financeiras com conciliação de extrato, cartões de crédito, gestão de várias casas e empresas, e agentes de IA assistentes.

O usuário quer ver todas as contas organizadas por **caixa** e enxergar o **fluxo de dinheiro entre caixas e entidades**, rastreável até o recebedor final. Uma entidade (pessoa ou empresa) pode receber (nós pagamos a ela) ou pagar (recebemos dela).

Conceitos centrais:

- **Entidade**: pessoa (CPF) ou empresa (CNPJ). Cadastro global, com chaves PIX e dados bancários.
- **Caixa**: o livro financeiro de um titular (entidade). É a unidade de permissão. Não existe camada de "Espaço" acima dela.
- **Conta financeira**: conta corrente, cofre ou poupança/investimento, sempre dentro de uma caixa.
- **Título**: a pagar ou a receber, dentro de uma caixa. É liquidado por **baixas**, e cada baixa gera **movimentos**.
- **Espelho**: quando a contraparte de um título é titular de uma caixa, o lado oposto é criado nela e fica ligado ao original.
- **Cartão de crédito**: uma caixa própria. As compras ficam nela, e a fatura é um título espelhado em cada caixa pagadora.

Stack: monorepo pnpm, Node/TypeScript (Fastify, Drizzle), React 19 com Vite, PostgreSQL 18 com pgvector e imagem Docker única `tmsoftbrasil/moneyflow`. O banco vive em `database/` e é gerido por um subagente DBA independente. Decisões tomadas em 2026-10-10.

## Convenções destes documentos

- Cada especificação fica em `docs/nnn-titulo.md`: número de 3 dígitos com zeros à esquerda e título em kebab-case, em português.
- Uma especificação nova recebe o próximo número livre e entra na tabela abaixo no mesmo commit.
- Uma decisão alterada é atualizada no arquivo dela, não acrescentada como nota avulsa.

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| [001-stack-e-entrega.md](001-stack-e-entrega.md) | Frontend (template da skill do console), backend, banco, estrutura do monorepo, testes, imagem Docker, Compose, CI/CD, locale e moeda. |
| [002-usuarios-e-permissoes.md](002-usuarios-e-permissoes.md) | Campos do usuário, senha em texto puro e suas restrições de exposição, login e sessão, admin inicial, papéis globais e por caixa. |
| [003-entidades.md](003-entidades.md) | Pessoas e empresas, validação de CPF e CNPJ (inclusive alfanumérico), autopreenchimento, contatos, dados bancários, chaves PIX e vínculos. |
| [004-caixas-e-contas.md](004-caixas-e-contas.md) | A caixa como livro do titular, caixa principal, tipos de caixa e tipos de conta financeira. |
| [005-titulos-baixas-e-movimentos.md](005-titulos-baixas-e-movimentos.md) | Títulos, baixas parciais, movimentos, recorrência e parcelamento, transferências, e o pagamento de uma caixa por conta de outra. |
| [006-espelhamento-entre-caixas.md](006-espelhamento-entre-caixas.md) | Título espelho, caixa da contraparte, aceite pendente quando falta permissão, e a baixa única com duas pernas. |
| [007-cartao-de-credito.md](007-cartao-de-credito.md) | A caixa do tipo cartão, compras com recebedor final, parcelas, estornos, datas da fatura, fechamento por pagadora (espelho aceito no lado da pagadora), pagamento parcial e antecipado, encargos, status da fatura (inclusive rolada), relatórios por competência pelas compras (sem os títulos de fatura) e, no regime de caixa, o pagamento da fatura com a categoria do título. |
| [008-categorias-auditoria-e-exclusao.md](008-categorias-auditoria-e-exclusao.md) | Plano global de categorias, regime de competência e de caixa, arquivamento em vez de exclusão, auditoria (sem retenção por enquanto) e fechamento de mês após a conciliação. |
| [009-extratos-e-conciliacao.md](009-extratos-e-conciliacao.md) | Import OFX/CSV, deduplicação, casamento assistido, divergência de saldo e regras de classificação. |
| [010-entrada-de-titulos.md](010-entrada-de-titulos.md) | Boleto (linha digitável), PIX copia-e-cola, leitura de PDF/imagem por IA e import de NF-e. |
| [011-agentes-de-ia.md](011-agentes-de-ia.md) | Provedores (Anthropic e OpenAI-compatível), agentes, registro único de tools com prévia/diff e confirmação de escrita, MCP client e servidor `/mcp` com token pessoal, execução no worker com SSE, retomada e cancelamento, histórico, uso e custo, UX das janelas e do painel lateral, IA na leitura de documentos e na conciliação, embeddings. |
| [012-calendario.md](012-calendario.md) | Visões, status, reagendamento e saldo projetado. |
| [013-mensagens-telegram.md](013-mensagens-telegram.md) | Cadastro central de destinos Telegram (token write-only, dono pessoal, de caixa ou global), eventos com parâmetros e dedup, a fila de envio no worker (retry, 429, histórico) e as notificações do sino. |
| [014-visualizacao-e-relatorios.md](014-visualizacao-e-relatorios.md) | O canvas de fluxo de dinheiro (layout, agrupamento, gaveta, posições por usuário), os relatórios (categoria, projeção, entidade; competência × caixa; consolidado sem o interno) e a exportação CSV/PDF. |
| [015-fases.md](015-fases.md) | As fases de entrega F1 a F4 e as especificações que cada uma cobre. |
| [016-banco-de-dados.md](016-banco-de-dados.md) | O agente DBA e a pasta `database/`, PostgreSQL 18 com pgvector e pgTAP, migrations dbmate, fronteira com a aplicação (schema Drizzle gerado), blindagem dos segredos no banco (senha, bot token, chave do provedor de IA, cabeçalhos MCP, hash dos tokens pessoais), regras de integridade (usuários, documentos, PIX, caixas, categorias, recorrência, títulos, espelho, baixas, movimentos, transferências, anexos, boleto/PIX/NF-e, cartão e faturas, extratos e conciliação, auditoria, fechamento de mês, calendário, relatórios, canvas de fluxo, mensagens e outbox, notificações, agentes de IA — provedores, agentes, MCP, conversas, execuções e confirmações, uso e custo, tokens pessoais, embeddings — e saldos, com checagens no COMMIT), o ator da sessão (`app.user_id`) e convenções. |
