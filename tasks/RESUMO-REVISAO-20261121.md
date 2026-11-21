# Resumo da revisão completa — 2026-11-21

Revisão completa do projeto, somente leitura, pedida pelo usuário: um arquivo por problema ou proposta de melhoria, no formato de `tasks/` (docs/017), com a linha de cada um em `tasks/INDEX.md`. Este arquivo não é uma tarefa. Resultado: **120 tarefas abertas, 070 a 189** (9 de prioridade alta, 50 média e 61 baixa), todas sem triagem (`responsavel` vazio).

## 1. Parâmetros
- Data: 2026-11-21. Commit: `7f0984f` (v0.1.22), `main` limpo (só a pasta solta `tmp/`).
- Escopo: o repositório inteiro — servidor, web, shared, `packages/db`, banco (`database/`), e2e, Docker, CI e documentação. Foco em correção, segurança, desempenho, testes, UX/acessibilidade e manutenção. A auditoria de segurança de 2026-11-07 (tarefas 048–069, todas concluídas) foi tomada como base: nada dela foi repetido; uma correção incompleta daquela leva virou tarefa nova citando a original.
- Método: doze revisores em paralelo, um por área, cada um lendo os arquivos da área por inteiro e tentando derrubar cada candidato (o banco já garante? há teste? a spec define assim?) antes de registrar. A sessão principal conferiu no código os nove achados de prioridade alta e os principais de cada área, e fundiu os repetidos entre áreas.

## 2. Checagens executadas
| Comando | Resultado |
|---|---|
| `pnpm typecheck` | passa |
| `pnpm test:unit` | passa (21 arquivos, 187 testes) |
| `pnpm lint` | **falha** por configuração: a pasta solta `tmp/` tem um `biome.json` aninhado (tarefa 189) |
| `pnpm audit` | 38 alertas: 7 altos, 22 moderados, 9 baixos (tarefa 071) |
| `pnpm outdated -r` | 29 pacotes atrás; as versões maiores pendentes são `pdfjs-dist` 6, `vite` 8, `@vitejs/plugin-react` 6, `@xyflow/react` 13 e `@anthropic-ai/sdk` 1.x |
| `vite build` (o `dist` de 2026-11-07) | arquivo principal de 1,79 MB (518 KB gzip) com as 26 telas (tarefa 128) |

Não rodaram: a integração (Testcontainers ou Postgres local), o pgTAP, o e2e e o Docker, para não disputar o banco entre os revisores. Alguns revisores confirmaram lógica pura do `packages/shared` com scripts descartáveis fora do repositório (diff de texto, formato contábil, regras de classificação, CSV, codificação, catálogo das tools).

## 3. Cobertura
| Lote | Área | Tarefas |
|---|---|---|
| A | Núcleo financeiro do servidor: títulos, baixas, espelho, séries, caixas, entidades, calendário, fechamento, `Access` | 11 |
| B | Cartão de crédito e contratos (servidor e worker) | 12 |
| C | Extratos, conciliação, parsers (OFX, CSV, NF-e, boleto, BR Code, PIX) e entrada de títulos | 11 |
| D | Runtime dos agentes: runner, worker, provedores, SSE, MCP, sessões, fluxos, tarefas, receitas | 11 |
| E | Tools dos agentes, registro do shared, administração de IA, orçamentos, `/mcp` | 10 |
| F | Mensagens, Telegram, sino, lembretes, autenticação, `config`, `app`/`main` | 12 |
| G | Relatórios, canvas, backup/restauração e a lógica pura do shared | 9 |
| H | Web: casca do console, `lib/`, `ui.tsx` e as telas financeiras | 12 |
| I | Web: agentes, administração de IA, conciliação, contratos e anotações | 12 |
| J | Banco: domínio financeiro (índices, integridade, funções de saldo e relatório) | 9 |
| K | Banco: IA, mensagens, auditoria, anotações e a infraestrutura de `database/` | 9 |
| L | Docker, compose, CI/CD, `verify.mjs`, e2e, TypeScript/Biome e documentação | 12 |
| — | Sessão principal: dependências, lint, bundle e o deadlock do espelho | 4 |

A soma por lote (134) passa de 120 porque 12 grupos de achados repetidos entre lotes viraram um arquivo só (seção 7).

## 4. Áreas não cobertas ou lidas em parte
- Testes de integração: lidos pelos nomes dos casos e por trechos; nenhum arquivo de teste foi lido inteiro em todas as áreas.
- Web: os CSS (só busca de padrões), `messages/SubscriptionsDrawer.tsx` (até a linha 140), o desempenho fino dos gráficos SVG de uso e a UI tri-estado dos kits. Nada foi testado num navegador nem com leitor de tela.
- Servidor: o corpo de `reconciliation.ts` fora das travas, `series-core.ts`, `title-pair.ts`, `backup/legacy-contracts.ts` (lido pelo lote B, não pelo G) e `contract-worker.ts` do ponto de vista das mensagens.
- Banco: as migrations 0040–0051 e a parte estrutural da 0052; nenhum `EXPLAIN` foi rodado, então os achados de desempenho do banco são dedução estática dos planos.
- O projeto externo de produção (proxy, compose, `COOKIE_SECURE`, tempo de parada dos contêineres) e as configurações do repositório no GitHub.

## 5. Tarefas criadas

As nove de prioridade alta, em ordem de impacto:

| Nº | Tarefa | Severidade | Executor |
|---|---|---|---|
| 070 | [Senhas e tokens vão em texto claro para o log quando uma consulta falha](070-segredos-nos-logs-pelo-erro-do-drizzle.md) | média | app |
| 071 | [Dependências com alertas de segurança (`pnpm audit`: 7 altos) e sem checagem no CI](071-dependencias-com-alertas-de-seguranca.md) | alta | app |
| 072 | [Editor de qualquer caixa toma a caixa principal de outra entidade e passa a receber os espelhos dela](072-caixa-principal-de-outra-entidade-tomada-por-editor.md) | média | app |
| 073 | [O markdown "seguro" aceita HTML cru: `<style>`, `style=`, formulários e `popover` mudam o console inteiro](073-markdown-seguro-aceita-html-cru.md) | média | app |
| 074 | [Erro temporário do provedor devolve a execução à fila para sempre](074-retentativa-do-provedor-sem-limite.md) | alta | app |
| 075 | ["Este e os próximos" no formulário do título sobrescreve o valor e as notas das ocorrências seguintes, mesmo sem mudá-los](075-este-e-os-proximos-sobrescreve-valor-e-notas.md) | média | app |
| 076 | [Regra aprendida da correção não casa nem com a descrição de onde nasceu](076-regra-aprendida-nao-casa-com-a-propria-descricao.md) | média | dba e depois app (ou só app, na alternativa do passo 3) |
| 077 | [JSON completo com os anexos em hex: a exportação lê 500 anexos por consulta e a importação não lê arquivo acima de 512 MiB](077-json-completo-com-anexos-estoura-memoria.md) | média | app |
| 078 | [Release publica `:X.Y.Z` e `:latest` sem verificação e a partir da árvore de trabalho](078-release-publica-imagem-sem-verificacao.md) | média | app |

Todas, por área (prioridade e severidade de cada uma):

### Núcleo financeiro (servidor)

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 072 | [Editor de qualquer caixa toma a caixa principal de outra entidade e passa a receber os espelhos dela](072-caixa-principal-de-outra-entidade-tomada-por-editor.md) | alta | média | bug | app |
| 075 | ["Este e os próximos" no formulário do título sobrescreve o valor e as notas das ocorrências seguintes, mesmo sem mudá-los](075-este-e-os-proximos-sobrescreve-valor-e-notas.md) | alta | média | bug | app |
| 079 | [Do lado espelho, excluir, arquivar e "Excluir este e os próximos" mexem no título e na série da outra caixa sem escrita nela](079-lado-espelho-exclui-e-cancela-o-titulo-original.md) | média | média | bug | app |
| 080 | [Conta arquivada: o saldo some da caixa e ela ainda aceita movimentos e extratos](080-conta-arquivada-continua-recebendo-lancamentos.md) | média | baixa | bug | app |
| 081 | [Estorno com "desfazer transferência" apaga o movimento da conta de outra caixa sem escrita nela](081-estorno-apaga-transferencia-de-outra-caixa.md) | média | baixa | bug | app |
| 082 | [A API aceita fechar mês futuro, e o worker para de materializar as séries daquele mês sem dizer qual nem por quê](082-fechamento-de-mes-futuro-trava-series-em-silencio.md) | média | baixa | bug | app |
| 129 | [Cancelar, arquivar ou rescindir deixa a linha do extrato sugerida para o título cancelado](129-cancelar-titulo-deixa-sugestao-do-extrato.md) | baixa | baixa | bug | app |
| 130 | [O "saldo atual" da conta e da caixa soma movimentos com data futura](130-saldo-atual-soma-movimentos-futuros.md) | baixa | baixa | banco | dba e depois app |
| 131 | [O saldo projetado por conta no calendário é só o realizado: ignora os previstos da conta](131-saldo-projetado-da-conta-sem-previstos.md) | baixa | baixa | melhoria | dba e depois app |
| 132 | [O vencimento do título de fatura de cartão muda pelo calendário e pelo PATCH, descolando da fatura](132-vencimento-do-titulo-de-fatura-editavel.md) | baixa | baixa | bug | app |

### Cartão e contratos

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 083 | [Contrato encerrado sem renovar mantém as obrigações sem fim gerando ocorrências](083-contrato-encerrado-sem-renovar-nao-encerra-as-series.md) | média | média | bug | app |
| 084 | [Detalhe da fatura carrega até 1.000 títulos por caixa e perde os da fatura em caixas grandes](084-detalhe-da-fatura-perde-titulos-em-caixas-grandes.md) | média | média | bug | app |
| 085 | [Pagamento parcial da fatura (e o crédito do fechamento) falha quando a fatura seguinte já fechou](085-pagamento-parcial-da-fatura-falha-com-a-seguinte-fechada.md) | média | média | bug | app |
| 086 | [Renovação automática atrasada vira uma vigência só e multiplica o prazo das seguintes](086-renovacao-automatica-atrasada-multiplica-o-prazo.md) | média | média | bug | app |
| 087 | [Renovar o contrato encurta o fim das obrigações e perde a última ocorrência](087-renovar-encurta-o-fim-das-obrigacoes.md) | média | média | bug | app |
| 133 | [Cartão: encargo aceita pagadora sem Access, e o detalhe da fatura abre com uma pagadora que não é dela](133-cartao-encargo-e-detalhe-da-fatura-sem-access-da-pagadora.md) | baixa | baixa | bug | app |
| 134 | [Contrato mostra dados de caixas que o usuário não lê (próxima ocorrência e cobranças no cartão)](134-contrato-mostra-dados-de-caixas-nao-legiveis.md) | baixa | baixa | bug | app |
| 135 | [Markdown do contrato: a última gravação vence sem aviso (edição concorrente e tool aprovada depois)](135-edicao-concorrente-do-markdown-sem-aviso.md) | baixa | baixa | melhoria | app |
| 136 | [Falhas engolidas sem log no worker de faturas, de contratos, das séries e na baixa automática](136-falhas-engolidas-sem-log-nos-workers.md) | baixa | baixa | debito-tecnico | app |
| 137 | [Mudar o dia de uma cobrança no cartão (aditivo ou edição da série) reescreve as datas esperadas do passado](137-mudar-o-dia-da-cobranca-no-cartao-reescreve-o-passado.md) | baixa | baixa | bug | app |
| 138 | [Rescisão com data em mês fechado falha inteira (última ocorrência proporcional e multa)](138-rescisao-retroativa-em-mes-fechado-falha-inteira.md) | baixa | baixa | bug | app |

### Extratos, conciliação e parsers

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 076 | [Regra aprendida da correção não casa nem com a descrição de onde nasceu](076-regra-aprendida-nao-casa-com-a-propria-descricao.md) | alta | média | banco | dba e depois app (ou só app, na alternativa do passo 3) |
| 088 | [Codificação do CSV nunca é detectada: arquivo em Latin-1 entra com "�" nas descrições](088-codificacao-do-csv-nunca-detectada.md) | média | média | bug | app |
| 089 | [Dedup por FITID ignora data e valor: FITID repetido descarta lançamento real ou derruba o import](089-dedup-por-fitid-ignora-data-e-valor.md) | média | média | bug | app |
| 090 | [Saldo do banco do lote CSV sai errado quando o arquivo vem do mais recente para o mais antigo](090-saldo-do-csv-errado-em-arquivo-decrescente.md) | média | média | bug | app |
| 091 | [Sinal da fatura do cartão em CSV decidido pela maioria das linhas de cada arquivo](091-sinal-da-fatura-csv-decidido-por-maioria.md) | média | média | banco | dba e depois app |
| 139 | [Importação, casamento e "Aplicar regras" fazem consultas por linha (N+1) numa transação longa](139-importacao-e-aplicar-regras-com-consultas-por-linha.md) | baixa | baixa | melhoria | app |
| 140 | [Linhas do CSV com data ou valor inválidos somem do import sem aviso (API e tools)](140-linhas-do-csv-descartadas-sem-aviso-no-import.md) | baixa | baixa | melhoria | app |
| 141 | [Linha da fatura casa com qualquer parcela da compra, sem olhar a fatura do lote](141-parcelas-da-fatura-casam-sem-olhar-a-fatura.md) | baixa | baixa | melhoria | app |
| 142 | [Prévia do `import_statement` lê lotes de `supersedeImportIds` sem `Access` e sem validar o alvo](142-previa-do-import-statement-sem-validar-supersede.md) | baixa | baixa | bug | app |

### Banco: domínio financeiro

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 092 | [Saldo da conta somado desde a abertura várias vezes por linha (lotes, resumo e projeção)](092-saldo-da-conta-recalculado-do-zero-varias-vezes-por-linha.md) | média | média | banco | dba e depois app |
| 093 | [Saldos em aberto e vencidos recalculam a baixa de todos os títulos já pagos](093-saldo-em-aberto-varre-todo-o-historico-de-titulos.md) | média | média | banco | dba e depois app |
| 143 | [Consultas do extrato escritas de um jeito que impede o uso dos índices feitos para elas](143-consultas-do-extrato-escritas-de-modo-que-o-indice-nao-serve.md) | baixa | baixa | melhoria | app |
| 144 | [`contract_payments` procura a linha conciliada de cada baixa varrendo todas as linhas do sistema](144-contract-payments-procura-a-linha-do-extrato-sem-indice.md) | baixa | baixa | banco | dba |
| 145 | [Fechar o mês não espera as escritas em andamento naquele mês (escrita entra no mês fechado)](145-fechamento-de-mes-sem-trava-contra-escrita-concorrente.md) | baixa | baixa | banco | dba |
| 146 | [O canvas de fluxo lê todos os títulos das caixas, de qualquer data, a cada chamada](146-flow-graph-materializa-todos-os-titulos-das-caixas.md) | baixa | baixa | banco | dba |
| 147 | [Índices que faltam: busca na descrição dos títulos, compras por pagadora e data, espelhos pendentes](147-indices-que-faltam-busca-de-titulos-compras-por-pagadora-e-espelhos-pendentes.md) | baixa | baixa | banco | dba e depois app |
| 148 | [Regras do espelho e da conciliação que a docs/016 atribui ao banco, mas só a aplicação garante](148-invariantes-do-espelho-e-da-conciliacao-abertas-no-banco.md) | baixa | baixa | banco | dba |
| 149 | [A materialização da série corre sem trava contra "excluir este e os próximos" e "esta e as próximas" do título](149-materializacao-da-serie-sem-trava-contra-esta-e-as-proximas.md) | baixa | baixa | banco | dba e depois app |

### Runtime dos agentes

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 074 | [Erro temporário do provedor devolve a execução à fila para sempre](074-retentativa-do-provedor-sem-limite.md) | alta | alta | bug | app |
| 094 | [O cursor da indexação de embeddings perde registros (empate de `updated_at` acima de 500 e COMMIT tardio)](094-embeddings-pulam-registros-com-mesmo-updated-at.md) | média | média | bug | app |
| 095 | [Os fluxos de documento aceitam como completa a resposta cortada por `max_tokens`](095-fluxo-json-aceita-resposta-cortada-por-max-tokens.md) | média | média | bug | app |
| 096 | [O histórico da sessão nunca entra no cache do prompt da Anthropic](096-historico-fora-do-cache-do-prompt.md) | média | média | melhoria | app |
| 097 | ["Parar" e "Finalizar sessão" não interrompem um lote de tools em andamento](097-parar-nao-interrompe-lote-de-tools.md) | média | média | bug | app |
| 098 | [Uma sessão que passa do limite do provedor falha em toda mensagem nova, sem orientar o usuário](098-sessao-sem-controle-de-tamanho-do-contexto.md) | média | média | melhoria | app |
| 150 | [Leitura e conversão de documento desistem em 120 s, mas a execução continua e é paga](150-fluxo-sincrono-nao-cancela-execucao-no-timeout.md) | baixa | baixa | bug | app |
| 151 | [Na volta à fila por erro do provedor, o console junta o texto parcial ao novo e deixa o erro na tela](151-retentativa-mistura-texto-e-deixa-erro-no-console.md) | baixa | baixa | bug | app |

### Tools e administração de IA

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 099 | [Erros inesperados das tools viram "Algo deu errado" sem nenhum log](099-erros-inesperados-das-tools-sem-log.md) | média | média | bug | app |
| 100 | [Cartão de aprovação não mostra parte do que a tool vai mudar (agente, série, senha, encerrar série)](100-previas-omitem-o-que-a-execucao-muda.md) | média | média | bug | app |
| 101 | [Resultados das tools cortados no meio do JSON em 60 mil caracteres, em listas sem paginação (inclusive o extrato sem período)](101-resultados-das-tools-truncados-sem-paginacao.md) | média | média | bug | app |
| 152 | [A tool de copiar regras manda "aplicar as regras", mas não existe tool para aplicar](152-aplicar-regras-de-classificacao-sem-tool.md) | baixa | baixa | melhoria | app |
| 153 | [set_message_subscriptions grava cada assinatura numa transação: falha no meio deixa metade aplicada](153-assinaturas-do-destino-gravadas-em-varias-transacoes.md) | baixa | baixa | bug | app |
| 154 | [Campos de centavos anuláveis vão ao modelo sem a dica "centavos" (aditivo, multa, limite do cartão)](154-dica-de-centavos-ausente-nos-campos-anulaveis.md) | baixa | baixa | bug | app |
| 155 | [Auxiliares das prévias duplicados entre os handlers: dinheiro em dois formatos e o filtro de zeros do settle_title que nunca casa](155-duplicacao-e-formato-de-dinheiro-nos-handlers.md) | baixa | baixa | debito-tecnico | app |
| 156 | ["Excluir preço" promete que o uso passa ao preço anterior, mas o custo é congelado na gravação e o preço usado não sai](156-excluir-preco-de-modelo-nao-recalcula-o-uso.md) | baixa | baixa | bug | app |
| 157 | [Leitura (e o notify_user) em ask mostra cartão vazio, e leituras com efeito externo vão ao /mcp como inofensivas](157-leituras-em-ask-com-cartao-vazio.md) | baixa | baixa | melhoria | app |
| 158 | [Specs 021 e 027 descrevem tools de contrato e de regra que não existem mais, e um teste confere uma tool removida](158-registro-de-tools-desatualizado-nas-specs-e-teste-vestigial.md) | baixa | baixa | debito-tecnico | app |

### Banco: IA, mensagens, auditoria e infraestrutura

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 102 | [Papel da aplicação, pool e migrations sem nenhum timeout no Postgres](102-conexoes-sem-timeouts-no-banco.md) | média | média | banco | dba e depois app |
| 103 | [Fila, sino, logs operacionais e anexos órfãos crescem sem nenhuma purga](103-tabelas-operacionais-sem-retencao.md) | média | média | banco | dba e depois app |
| 159 | [Auditoria: a remoção dos segredos e das colunas ruidosas vive só no `audit_row()`, e 11 triggers próprios a contornam](159-auditoria-segredos-fora-do-audit-write.md) | baixa | baixa | banco | dba |
| 160 | [Bifurcar a sessão não religa os arquivos gerados pelas tools](160-bifurcacao-nao-religa-arquivos-gerados.md) | baixa | baixa | banco | dba |
| 161 | [A busca semântica recalcula o tamanho de todas as fontes e do índice a cada chamada](161-busca-semantica-conta-todas-as-fontes-a-cada-chamada.md) | baixa | baixa | banco | dba e depois app |
| 162 | [Requisição ao provedor interrompida por queda do processo fica "em andamento" até a purga](162-requisicoes-ao-provedor-presas-em-running.md) | baixa | baixa | banco | dba e depois app |
| 163 | [`schema.sql` sem privilégios e sem conferência no CI, e imagens do banco sem versão fixa](163-schema-de-referencia-e-versoes-sem-checagem.md) | baixa | baixa | banco | dba e depois app |
| 164 | [SSE e hub de eventos consultam o banco a cada delta de texto (e o aviso do banco não diz o tipo do evento)](164-sse-e-hub-consultam-o-banco-a-cada-delta.md) | baixa | baixa | banco | dba e depois app |
| 165 | [O teste de migração com dados roda as migrations como superusuário, ao contrário da produção (tarefa 054)](165-teste-de-migracao-roda-como-superusuario.md) | baixa | baixa | banco | dba |

### Mensagens, Telegram, lembretes, autenticação e esqueleto do servidor

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 070 | [Senhas e tokens vão em texto claro para o log quando uma consulta falha](070-segredos-nos-logs-pelo-erro-do-drizzle.md) | alta | média | bug | app |
| 104 | [Uma falha ao gerar as notificações do sino para o Telegram e os alarmes dos lembretes](104-falha-no-sino-trava-outbox-e-lembretes.md) | média | média | bug | app |
| 105 | [Aviso de vencimento no Telegram para no 30º título: "o resto na seguinte" nunca vem](105-lembrete-de-vencimento-para-no-30-titulo.md) | média | média | bug | app |
| 106 | [Limite de corpo do JSON: o `/mcp` recusa acima de 1 MB e as rotas públicas leem até 20 MB antes de recusar](106-limite-de-corpo-json-quebra-upload-do-mcp.md) | média | média | bug | app |
| 107 | [Parada do processo sem prazo nem ordem, e healthcheck do worker que não diz nada](107-parada-do-processo-e-healthcheck-do-worker.md) | média | média | melhoria | app |
| 108 | [Pool do Postgres sem `on('error')`: conexão ociosa que cai derruba a API e o worker](108-pool-sem-tratamento-de-erro-derruba-o-processo.md) | média | média | bug | app |
| 109 | [Rajada para o mesmo chat: cada 429 gasta uma das 5 tentativas e a mensagem vira falha definitiva](109-rajada-ao-mesmo-chat-esgota-tentativas-no-429.md) | média | média | bug | dba e depois app |
| 110 | [Variáveis de ambiente numéricas vazias ou inválidas viram 0 ou NaN em silêncio](110-variaveis-de-ambiente-numericas-sem-validacao.md) | média | média | bug | app |
| 166 | [O laço de mensagens recalcula resumos e views pesadas a cada 30 s só para a dedup descartar](166-laco-de-mensagens-recalcula-tudo-a-cada-30s.md) | baixa | baixa | melhoria | app |
| 167 | [Regravar o token do mesmo bot com a entrada ligada apaga o webhook recém-criado](167-mesmo-token-com-entrada-ligada-apaga-o-webhook.md) | baixa | baixa | bug | app |
| 168 | [Resposta e botões do agente no Telegram são marcados como enviados antes do envio e se perdem numa falha](168-resposta-do-telegram-perdida-em-falha-de-envio.md) | baixa | baixa | bug | app |
| 169 | [Sino: as não lidas não vêm primeiro e as que passam das 30 mais recentes ficam inalcançáveis](169-sino-sem-nao-lidas-primeiro-nem-paginacao.md) | baixa | baixa | bug | app |

### Relatórios, canvas, backup e shared

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 077 | [JSON completo com os anexos em hex: a exportação lê 500 anexos por consulta e a importação não lê arquivo acima de 512 MiB](077-json-completo-com-anexos-estoura-memoria.md) | alta | média | bug | app |
| 111 | [Relatório consolidado de uma caixa soma as compras de cartão feitas por outra pagadora](111-consolidado-soma-compras-de-outra-pagadora.md) | média | média | bug | app |
| 112 | [Diff de texto guarda o vetor inteiro a cada passo: documento grande trava o worker e o navegador](112-diff-de-texto-quadratico-em-memoria.md) | média | média | bug | app |
| 113 | [Falha de escrita do zip do JSON completo vira rejeição sem tratamento e derruba a API](113-falha-de-escrita-no-json-completo-derruba-a-api.md) | média | média | bug | app |
| 170 | [Competência das ocorrências novas da série escorrega para o dia 28 depois de fevereiro](170-competencia-da-serie-escorrega-para-o-dia-28.md) | baixa | baixa | bug | app |
| 171 | [Gaveta de um grupo grande do canvas falha: os ids das entidades vão na query string](171-gaveta-de-grupo-grande-do-canvas-falha.md) | baixa | baixa | bug | app |
| 172 | ["Uma operação de backup por vez" usa duas travas diferentes e deixa a restauração correr junto com a importação](172-operacoes-de-backup-sem-exclusao-mutua.md) | baixa | baixa | debito-tecnico | app |
| 173 | [Paginação do JSON completo compara a parte numérica da chave composta como texto, e nenhum teste passa de um lote](173-paginacao-do-json-completo-por-chave-composta.md) | baixa | baixa | debito-tecnico | app |
| 174 | [Zero negativo aparece como "-R$ 0,00" no formato contábil](174-zero-negativo-aparece-como-menos-zero.md) | baixa | baixa | bug | app |

### Web: casca e telas financeiras

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 114 | [Listas que só abrem com o mouse, chat sem anúncios ao leitor de tela, e as regras do Biome que pegariam isso desligadas](114-acessibilidade-teclado-e-leitor-de-tela.md) | média | média | melhoria | app |
| 115 | [Esc fecha todas as camadas de uma vez: fechar a lista do seletor de entidade descarta o formulário inteiro](115-esc-fecha-todas-as-camadas.md) | média | média | bug | app |
| 116 | [Listas de títulos, compras, entidades e transferências cortadas em silêncio (300 linhas), com totais só do que veio](116-listas-cortadas-em-300-com-totais-parciais.md) | média | média | bug | app |
| 117 | [Telas mostram e aplicam a prévia ou os dados do filtro anterior enquanto o novo carrega](117-previas-e-dados-antigos-enquanto-o-novo-carrega.md) | média | média | bug | app |
| 118 | [Resposta de um filtro ou arquivo anterior sobrescreve a atual em cinco telas](118-resposta-atrasada-sobrescreve-a-atual.md) | média | média | bug | app |
| 119 | [Sessão que cai desmonta o console inteiro e perde o formulário que estava sendo preenchido](119-sessao-expirada-descarta-formulario.md) | média | média | melhoria | app |
| 175 | [Texto secundário e valores verdes/vermelhos abaixo do AA (4,5:1), sobretudo no tema escuro padrão](175-contraste-de-texto-abaixo-do-aa.md) | baixa | média | melhoria | app |
| 176 | [Canvas de fluxo recria `data` de todos os nós e arestas a cada quadro do arrasto e anula o `memo` dos nós](176-canvas-anula-memo-dos-nos-no-arrasto.md) | baixa | baixa | melhoria | app |
| 177 | [Nova entidade importa o endereço e os contatos de um CNPJ consultado antes de trocar o documento](177-consulta-de-cnpj-antiga-importada.md) | baixa | baixa | bug | app |
| 178 | [Gaveta do título mostra a NF-e emitida à noite com a data do dia seguinte](178-data-de-emissao-da-nfe-um-dia-depois.md) | baixa | baixa | bug | app |
| 179 | [Fluxo projetado exportado mostra o "a pagar" positivo, ao contrário da tela e da spec 014](179-pdf-do-fluxo-projetado-sem-sinal-do-a-pagar.md) | baixa | baixa | bug | app |
| 180 | [Textos pt-BR fixos fora do `t` do shared e datas no fuso do navegador nas telas](180-textos-e-datas-fora-das-regras-do-projeto.md) | baixa | baixa | debito-tecnico | app |

### Web: agentes, IA, conciliação, contratos e anotações

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 073 | [O markdown "seguro" aceita HTML cru: `<style>`, `style=`, formulários e `popover` mudam o console inteiro](073-markdown-seguro-aceita-html-cru.md) | alta | média | bug | app |
| 120 | [Janelas do agente re-renderizam a conversa inteira a cada token e a página aberta a cada clique na janela](120-janelas-do-agente-re-renderizam-a-cada-token-e-clique.md) | média | média | melhoria | app |
| 121 | [Miniatura de PDF no chat mantém um worker do pdf.js por anexo e vaza o documento ao desmontar cedo](121-miniatura-de-pdf-mantem-um-worker-por-anexo.md) | média | média | bug | app |
| 122 | [SSE do chat fica aberto enquanto a execução espera aprovação, uma conexão por janela e por aba](122-sse-e-sondagem-abertos-durante-a-aprovacao.md) | média | média | melhoria | app |
| 123 | [Microfone fica gravando até 10 minutos se a janela fecha enquanto o navegador pede a permissão](123-microfone-continua-aberto-apos-fechar-a-janela.md) | média | baixa | bug | app |
| 181 | [Ajustes de reconhecimento da série têm dois editores e dois resumos que se comportam diferente](181-ajustes-de-reconhecimento-duplicados-e-divergentes.md) | baixa | baixa | bug | app |
| 182 | [Cortar `ObligationFormModal.tsx` (898 linhas) e `ContractPage.tsx` (831) e unificar o diff de versões](182-corte-de-obligationformmodal-e-contractpage.md) | baixa | baixa | debito-tecnico | app |
| 183 | [Estado das janelas do agente não sincroniza entre abas: a última aba a gravar desfaz o que a outra fechou](183-janelas-do-agente-nao-sincronizam-entre-abas.md) | baixa | baixa | bug | app |

### Infraestrutura, CI, testes e documentação

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 078 | [Release publica `:X.Y.Z` e `:latest` sem verificação e a partir da árvore de trabalho](078-release-publica-imagem-sem-verificacao.md) | alta | média | melhoria | app |
| 124 | [`AGENTS.md` + `docs/INDEX.md` carregam ~67 mil caracteres em todo contexto de agente; a "Estrutura" é metade disso](124-agents-md-estrutura-grande-demais.md) | média | média | melhoria | app |
| 125 | [E2E: arquivos rodam em paralelo na mesma pilha e o agente ativo de um spec muda o resultado dos outros](125-e2e-specs-compartilham-estado-global-em-paralelo.md) | média | média | debito-tecnico | app |
| 126 | [Rotas de escrita sem nenhum teste (integração, tool ou e2e) e cobertura nunca medida](126-rotas-sem-nenhum-teste-e-sem-cobertura.md) | média | média | melhoria | app |
| 127 | [`verify:quick` sai verde sem rodar teste nenhum na maior parte das mudanças do servidor](127-verify-quick-deixa-passar-mudanca-sem-teste.md) | média | média | melhoria | app |
| 184 | [CI sem `permissions`, sem `timeout-minutes`, actions e imagens por tag flutuante e o CI do `main` cancelável](184-ci-sem-endurecimento.md) | baixa | baixa | melhoria | app |
| 185 | [Documentação de entrada contradiz as specs e o código (contrato, agentes, variáveis de ambiente)](185-documentacao-de-entrada-desatualizada.md) | baixa | baixa | debito-tecnico | app |
| 186 | [Erro 500 sem identificador: o usuário vê "Algo deu errado" e o log não tem como ser achado](186-erro-500-sem-id-de-correlacao.md) | baixa | baixa | melhoria | app |
| 187 | [Node 26 no desenvolvimento, 22 no CI e na imagem, `@types/node` 26 e `corepack enable` que não existe mais](187-versao-do-node-divergente.md) | baixa | baixa | debito-tecnico | app |

### Sessão principal

| Nº | Tarefa | Prioridade | Severidade | Tipo | Executor |
|---|---|---|---|---|---|
| 071 | [Dependências com alertas de segurança (`pnpm audit`: 7 altos) e sem checagem no CI](071-dependencias-com-alertas-de-seguranca.md) | alta | alta | debito-tecnico | app |
| 128 | [O SPA carrega as 26 telas num arquivo só (1,79 MB, 518 KB gzip) antes do login](128-spa-em-bundle-unico-sem-divisao-por-rota.md) | média | média | melhoria | app |
| 188 | [Baixas simultâneas nos dois lados do espelho entram em deadlock e voltam como erro 500](188-baixas-simultaneas-nos-dois-lados-do-espelho-em-deadlock.md) | baixa | baixa | bug | app |
| 189 | [`pnpm lint` falha quando há uma pasta solta com `biome.json` (hoje, `tmp/`)](189-pnpm-lint-quebra-com-pasta-solta.md) | baixa | baixa | debito-tecnico | app |


## 6. Ordem sugerida de correção
1. **Logs e queda do processo:** 070 (senhas e tokens no log), 108 (pool sem `on('error')`) e 113 (rejeição sem tratamento no backup). A 070 fere uma regra explícita do `AGENTS.md`, e as três aparecem juntas num reinício do Postgres.
2. **Conteúdo malicioso no navegador:** 071 (o `pdfjs-dist` com execução de JavaScript por PDF), 073 (HTML cru no markdown, inclusive `<style>` com a CSP de `style-src 'unsafe-inline'`) e 121 (workers do pdf.js que vazam).
3. **Permissões entre caixas:** 072 (caixa principal tomada), 079 (o lado espelho mexe no original), 081 (estorno apaga a transferência de outra caixa), 133, 134 e 142.
4. **Custo e travamento dos agentes:** 074 (retentativa sem fim), 097 (parar não para o lote de tools), 095 (resposta cortada aceita), 150 e 151.
5. **Dados errados em silêncio:** 075 ("este e os próximos" apaga reajustes), 076 (regra aprendida que nunca casa), 086 e 087 (renovação de contrato), 083, 088–091 (importação de extrato), 111 (consolidado com compras de outra pagadora) e 105 (aviso de vencimento que para no 30º título).
6. **Backup:** 077 e 113, depois 172 e 173.
7. **Entrega e testes:** 078 (release sem verificação) e 184 (CI), 127 (`verify:quick` verde sem teste), 126 (rotas sem teste e cobertura) e 125 (e2e em paralelo na mesma pilha).
8. **Banco (dba):** 092 e 093 (saldos recalculados do zero), 102 (timeouts), 103 (retenção), depois as baixas de índice e integridade (143–149, 159–165).
9. **Web:** 117 e 118 (dados antigos na tela), 115 (Esc apaga o formulário), 119 (sessão expirada perde o formulário), 114 (teclado e leitor de tela), 128 (bundle único), depois as demais.
10. As baixas restantes, agrupadas por área.

## 7. Achados fundidos
Doze grupos vistos por mais de um revisor viraram uma tarefa só: 080 (conta arquivada), 099 (erros das tools sem log), 101 (resultados das tools truncados, com o extrato sem limite), 107 (parada do processo e healthcheck do worker), 110 (variáveis de ambiente numéricas), 114 (acessibilidade, com as regras do Biome desligadas), 117 (prévias e dados antigos: `useApi` e `usePreview`), 118 (respostas atrasadas), 129 (sugestão do extrato presa em título cancelado), 136 (falhas engolidas sem log nos workers), 164 (SSE e o NOTIFY sem o tipo) e 180 (textos e datas fora das regras).

Relacionadas, mas mantidas separadas por terem correções diferentes: 084 × 116 (o mesmo `LIMIT` de `listTitles`, no servidor e na tela), 174 × 179 (o fluxo projetado: o −0 e o sinal da exportação), 070 × 186 (o tratamento de erro central: o que vai ao log e o id de correlação), 108 × 113 (duas causas de queda do processo).

## 8. Hipóteses não confirmadas
- FITID repetido entre arquivos de bancos reais (tarefa 089): depende do comportamento dos bancos e conversores, sem rede para conferir.
- Explorabilidade dos alertas do `pdfjs-dist`, do `zod` e do `undici` neste projeto (071): o texto dos alertas não foi lido.
- O `include` do `docker-compose.yml` pode interpolar o arquivo incluído com o `database/.env` em vez do `.env` da raiz. Se for assim, trocar `APP_DB_PASSWORD`/`OWNER_DB_PASSWORD` só na raiz, como o README manda, dessincroniza o initdb e a aplicação. Não virou tarefa; vale conferir na documentação do Compose.
- A conexão do LISTEN que fica meio aberta sem erro (`events-hub.ts`): rara em rede local, só hipótese.
- Os ganhos dos índices e das reescritas de consulta (092, 093, 143–147) não foram medidos.

## 9. Candidatos refutados (resumo)
Cada revisor listou os seus; os principais:
- **Financeiro:** baixas simultâneas no mesmo título e acima do aberto (o banco trava e barra); datas de fatura em 29–31, fevereiro e virada de ano (corretas); divisão das parcelas com resto (correta, e o banco confere); `now()::date` no fuso do servidor (não existe no schema); estouro de `bigint` (todo dinheiro é `bigint`); FKs sem índice (nenhuma no domínio nem na IA).
- **Extratos:** separador e decimal brasileiros, aspas e sufixo D/C no CSV (corretos); boleto com o fator depois de 2025-02-22, BR Code, PIX e chave da NF-e alfanumérica (conferidos); regex inválida numa regra (o banco valida).
- **Agentes:** NOTIFY acima de 8 KB (o payload é só `{run_id, seq}`); transação aberta durante a chamada ao modelo (não há); segredos do cartão de aprovação (fora do schema, limpos depois do envio, fora de log); sobreposição e disparo perdido das tarefas agendadas (o banco trata); toda tool do registro tem handler.
- **Mensagens e lembretes:** mensagem presa em "enviando" (a reserva vence em 5 min); "todo dia 31", adiar e dedup dos lembretes (no banco e testados); fuso de SP no agendamento (correto).
- **Backup e relatórios:** tabela sem `id` ou coluna sem SELECT sumindo do export (todas cobertas); injeção de fórmula no CSV (coberta, inclusive tab e CR); `scopeCaixas` contornado (só `vision.ts` chama as funções).
- **Web:** hex em componente, `dangerouslySetInnerHTML` fora do markdown, URLs `javascript:`, `localStorage` com JSON inválido e object URL sem revoke (nenhum caso); SSE duplicado ou fora de ordem (tolerado); `useExhaustiveDependencies` desligado (35 avisos, os amostrados propositais).
- **Infra:** segredo em camada da imagem (nenhum); `schema.sql` defasado (em dia com a 0056); migrations sem `down` (todas têm).

## 10. Prompt injection
Nenhum texto do projeto tentou dar instruções aos revisores.

## 11. Limitações
Revisão estática, sem executar a integração, o pgTAP, o e2e nem o Docker, e sem rede além do `pnpm audit`. As confianças "confirmado" vêm da leitura do caminho inteiro (e, onde marcado, de um script descartável); "provável" e "hipótese" dizem o que falta conferir. Os diffs das tarefas são ilustrativos e não foram aplicados. Nada no repositório foi alterado além de `tasks/` (as 120 tarefas, este resumo e o `tasks/INDEX.md`).
