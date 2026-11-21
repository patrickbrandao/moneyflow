# Tarefas

Tarefas de revisão e correção pedidas entre agentes e achados do usuário. Formato, papéis e ciclo de vida em [docs/017-tarefas-entre-agentes.md](../docs/017-tarefas-entre-agentes.md). Abertas primeiro; concluídas e rejeitadas ficam como histórico.

| Nº | Tarefa | Status | Tipo | Responsável | Origem |
|---|---|---|---|---|---|
| 070 | [Senhas e tokens vão em texto claro para o log quando uma consulta falha](070-segredos-nos-logs-pelo-erro-do-drizzle.md) | aberta | bug | — | agente |
| 071 | [Dependências com alertas de segurança (`pnpm audit`: 7 altos) e sem checagem no CI](071-dependencias-com-alertas-de-seguranca.md) | aberta | debito-tecnico | — | agente |
| 072 | [Editor de qualquer caixa toma a caixa principal de outra entidade e passa a receber os espelhos dela](072-caixa-principal-de-outra-entidade-tomada-por-editor.md) | aberta | bug | — | agente |
| 073 | [O markdown "seguro" aceita HTML cru: `<style>`, `style=`, formulários e `popover` mudam o console inteiro](073-markdown-seguro-aceita-html-cru.md) | aberta | bug | — | agente |
| 074 | [Erro temporário do provedor devolve a execução à fila para sempre](074-retentativa-do-provedor-sem-limite.md) | aberta | bug | — | agente |
| 075 | ["Este e os próximos" no formulário do título sobrescreve o valor e as notas das ocorrências seguintes, mesmo sem mudá-los](075-este-e-os-proximos-sobrescreve-valor-e-notas.md) | aberta | bug | — | agente |
| 076 | [Regra aprendida da correção não casa nem com a descrição de onde nasceu](076-regra-aprendida-nao-casa-com-a-propria-descricao.md) | aberta | banco | — | agente |
| 077 | [JSON completo com os anexos em hex: a exportação lê 500 anexos por consulta e a importação não lê arquivo acima de 512 MiB](077-json-completo-com-anexos-estoura-memoria.md) | aberta | bug | — | agente |
| 078 | [Release publica `:X.Y.Z` e `:latest` sem verificação e a partir da árvore de trabalho](078-release-publica-imagem-sem-verificacao.md) | aberta | melhoria | — | agente |
| 079 | [Do lado espelho, excluir, arquivar e "Excluir este e os próximos" mexem no título e na série da outra caixa sem escrita nela](079-lado-espelho-exclui-e-cancela-o-titulo-original.md) | aberta | bug | — | agente |
| 080 | [Conta arquivada: o saldo some da caixa e ela ainda aceita movimentos e extratos](080-conta-arquivada-continua-recebendo-lancamentos.md) | aberta | bug | — | agente |
| 081 | [Estorno com "desfazer transferência" apaga o movimento da conta de outra caixa sem escrita nela](081-estorno-apaga-transferencia-de-outra-caixa.md) | aberta | bug | — | agente |
| 082 | [A API aceita fechar mês futuro, e o worker para de materializar as séries daquele mês sem dizer qual nem por quê](082-fechamento-de-mes-futuro-trava-series-em-silencio.md) | aberta | bug | — | agente |
| 083 | [Contrato encerrado sem renovar mantém as obrigações sem fim gerando ocorrências](083-contrato-encerrado-sem-renovar-nao-encerra-as-series.md) | aberta | bug | — | agente |
| 084 | [Detalhe da fatura carrega até 1.000 títulos por caixa e perde os da fatura em caixas grandes](084-detalhe-da-fatura-perde-titulos-em-caixas-grandes.md) | aberta | bug | — | agente |
| 085 | [Pagamento parcial da fatura (e o crédito do fechamento) falha quando a fatura seguinte já fechou](085-pagamento-parcial-da-fatura-falha-com-a-seguinte-fechada.md) | aberta | bug | — | agente |
| 086 | [Renovação automática atrasada vira uma vigência só e multiplica o prazo das seguintes](086-renovacao-automatica-atrasada-multiplica-o-prazo.md) | aberta | bug | — | agente |
| 087 | [Renovar o contrato encurta o fim das obrigações e perde a última ocorrência](087-renovar-encurta-o-fim-das-obrigacoes.md) | aberta | bug | — | agente |
| 088 | [Codificação do CSV nunca é detectada: arquivo em Latin-1 entra com "�" nas descrições](088-codificacao-do-csv-nunca-detectada.md) | aberta | bug | — | agente |
| 089 | [Dedup por FITID ignora data e valor: FITID repetido descarta lançamento real ou derruba o import](089-dedup-por-fitid-ignora-data-e-valor.md) | aberta | bug | — | agente |
| 090 | [Saldo do banco do lote CSV sai errado quando o arquivo vem do mais recente para o mais antigo](090-saldo-do-csv-errado-em-arquivo-decrescente.md) | aberta | bug | — | agente |
| 091 | [Sinal da fatura do cartão em CSV decidido pela maioria das linhas de cada arquivo](091-sinal-da-fatura-csv-decidido-por-maioria.md) | aberta | banco | — | agente |
| 092 | [Saldo da conta somado desde a abertura várias vezes por linha (lotes, resumo e projeção)](092-saldo-da-conta-recalculado-do-zero-varias-vezes-por-linha.md) | aberta | banco | — | agente |
| 093 | [Saldos em aberto e vencidos recalculam a baixa de todos os títulos já pagos](093-saldo-em-aberto-varre-todo-o-historico-de-titulos.md) | aberta | banco | — | agente |
| 094 | [O cursor da indexação de embeddings perde registros (empate de `updated_at` acima de 500 e COMMIT tardio)](094-embeddings-pulam-registros-com-mesmo-updated-at.md) | aberta | bug | — | agente |
| 095 | [Os fluxos de documento aceitam como completa a resposta cortada por `max_tokens`](095-fluxo-json-aceita-resposta-cortada-por-max-tokens.md) | aberta | bug | — | agente |
| 096 | [O histórico da sessão nunca entra no cache do prompt da Anthropic](096-historico-fora-do-cache-do-prompt.md) | aberta | melhoria | — | agente |
| 097 | ["Parar" e "Finalizar sessão" não interrompem um lote de tools em andamento](097-parar-nao-interrompe-lote-de-tools.md) | aberta | bug | — | agente |
| 098 | [Uma sessão que passa do limite do provedor falha em toda mensagem nova, sem orientar o usuário](098-sessao-sem-controle-de-tamanho-do-contexto.md) | aberta | melhoria | — | agente |
| 099 | [Erros inesperados das tools viram "Algo deu errado" sem nenhum log](099-erros-inesperados-das-tools-sem-log.md) | aberta | bug | — | agente |
| 100 | [Cartão de aprovação não mostra parte do que a tool vai mudar (agente, série, senha, encerrar série)](100-previas-omitem-o-que-a-execucao-muda.md) | aberta | bug | — | agente |
| 101 | [Resultados das tools cortados no meio do JSON em 60 mil caracteres, em listas sem paginação (inclusive o extrato sem período)](101-resultados-das-tools-truncados-sem-paginacao.md) | aberta | bug | — | agente |
| 102 | [Papel da aplicação, pool e migrations sem nenhum timeout no Postgres](102-conexoes-sem-timeouts-no-banco.md) | aberta | banco | — | agente |
| 103 | [Fila, sino, logs operacionais e anexos órfãos crescem sem nenhuma purga](103-tabelas-operacionais-sem-retencao.md) | aberta | banco | — | agente |
| 104 | [Uma falha ao gerar as notificações do sino para o Telegram e os alarmes dos lembretes](104-falha-no-sino-trava-outbox-e-lembretes.md) | aberta | bug | — | agente |
| 105 | [Aviso de vencimento no Telegram para no 30º título: "o resto na seguinte" nunca vem](105-lembrete-de-vencimento-para-no-30-titulo.md) | aberta | bug | — | agente |
| 106 | [Limite de corpo do JSON: o `/mcp` recusa acima de 1 MB e as rotas públicas leem até 20 MB antes de recusar](106-limite-de-corpo-json-quebra-upload-do-mcp.md) | aberta | bug | — | agente |
| 107 | [Parada do processo sem prazo nem ordem, e healthcheck do worker que não diz nada](107-parada-do-processo-e-healthcheck-do-worker.md) | aberta | melhoria | — | agente |
| 108 | [Pool do Postgres sem `on('error')`: conexão ociosa que cai derruba a API e o worker](108-pool-sem-tratamento-de-erro-derruba-o-processo.md) | aberta | bug | — | agente |
| 109 | [Rajada para o mesmo chat: cada 429 gasta uma das 5 tentativas e a mensagem vira falha definitiva](109-rajada-ao-mesmo-chat-esgota-tentativas-no-429.md) | aberta | bug | — | agente |
| 110 | [Variáveis de ambiente numéricas vazias ou inválidas viram 0 ou NaN em silêncio](110-variaveis-de-ambiente-numericas-sem-validacao.md) | aberta | bug | — | agente |
| 111 | [Relatório consolidado de uma caixa soma as compras de cartão feitas por outra pagadora](111-consolidado-soma-compras-de-outra-pagadora.md) | aberta | bug | — | agente |
| 112 | [Diff de texto guarda o vetor inteiro a cada passo: documento grande trava o worker e o navegador](112-diff-de-texto-quadratico-em-memoria.md) | aberta | bug | — | agente |
| 113 | [Falha de escrita do zip do JSON completo vira rejeição sem tratamento e derruba a API](113-falha-de-escrita-no-json-completo-derruba-a-api.md) | aberta | bug | — | agente |
| 114 | [Listas que só abrem com o mouse, chat sem anúncios ao leitor de tela, e as regras do Biome que pegariam isso desligadas](114-acessibilidade-teclado-e-leitor-de-tela.md) | aberta | melhoria | — | agente |
| 115 | [Esc fecha todas as camadas de uma vez: fechar a lista do seletor de entidade descarta o formulário inteiro](115-esc-fecha-todas-as-camadas.md) | aberta | bug | — | agente |
| 116 | [Listas de títulos, compras, entidades e transferências cortadas em silêncio (300 linhas), com totais só do que veio](116-listas-cortadas-em-300-com-totais-parciais.md) | aberta | bug | — | agente |
| 117 | [Telas mostram e aplicam a prévia ou os dados do filtro anterior enquanto o novo carrega](117-previas-e-dados-antigos-enquanto-o-novo-carrega.md) | aberta | bug | — | agente |
| 118 | [Resposta de um filtro ou arquivo anterior sobrescreve a atual em cinco telas](118-resposta-atrasada-sobrescreve-a-atual.md) | aberta | bug | — | agente |
| 119 | [Sessão que cai desmonta o console inteiro e perde o formulário que estava sendo preenchido](119-sessao-expirada-descarta-formulario.md) | aberta | melhoria | — | agente |
| 120 | [Janelas do agente re-renderizam a conversa inteira a cada token e a página aberta a cada clique na janela](120-janelas-do-agente-re-renderizam-a-cada-token-e-clique.md) | aberta | melhoria | — | agente |
| 121 | [Miniatura de PDF no chat mantém um worker do pdf.js por anexo e vaza o documento ao desmontar cedo](121-miniatura-de-pdf-mantem-um-worker-por-anexo.md) | aberta | bug | — | agente |
| 122 | [SSE do chat fica aberto enquanto a execução espera aprovação, uma conexão por janela e por aba](122-sse-e-sondagem-abertos-durante-a-aprovacao.md) | aberta | melhoria | — | agente |
| 123 | [Microfone fica gravando até 10 minutos se a janela fecha enquanto o navegador pede a permissão](123-microfone-continua-aberto-apos-fechar-a-janela.md) | aberta | bug | — | agente |
| 124 | [`AGENTS.md` + `docs/INDEX.md` carregam ~67 mil caracteres em todo contexto de agente; a "Estrutura" é metade disso](124-agents-md-estrutura-grande-demais.md) | aberta | melhoria | — | agente |
| 125 | [E2E: arquivos rodam em paralelo na mesma pilha e o agente ativo de um spec muda o resultado dos outros](125-e2e-specs-compartilham-estado-global-em-paralelo.md) | aberta | debito-tecnico | — | agente |
| 126 | [Rotas de escrita sem nenhum teste (integração, tool ou e2e) e cobertura nunca medida](126-rotas-sem-nenhum-teste-e-sem-cobertura.md) | aberta | melhoria | — | agente |
| 127 | [`verify:quick` sai verde sem rodar teste nenhum na maior parte das mudanças do servidor](127-verify-quick-deixa-passar-mudanca-sem-teste.md) | aberta | melhoria | — | agente |
| 128 | [O SPA carrega as 26 telas num arquivo só (1,79 MB, 518 KB gzip) antes do login](128-spa-em-bundle-unico-sem-divisao-por-rota.md) | aberta | melhoria | — | agente |
| 129 | [Cancelar, arquivar ou rescindir deixa a linha do extrato sugerida para o título cancelado](129-cancelar-titulo-deixa-sugestao-do-extrato.md) | aberta | bug | — | agente |
| 130 | [O "saldo atual" da conta e da caixa soma movimentos com data futura](130-saldo-atual-soma-movimentos-futuros.md) | aberta | banco | — | agente |
| 131 | [O saldo projetado por conta no calendário é só o realizado: ignora os previstos da conta](131-saldo-projetado-da-conta-sem-previstos.md) | aberta | melhoria | — | agente |
| 132 | [O vencimento do título de fatura de cartão muda pelo calendário e pelo PATCH, descolando da fatura](132-vencimento-do-titulo-de-fatura-editavel.md) | aberta | bug | — | agente |
| 133 | [Cartão: encargo aceita pagadora sem Access, e o detalhe da fatura abre com uma pagadora que não é dela](133-cartao-encargo-e-detalhe-da-fatura-sem-access-da-pagadora.md) | aberta | bug | — | agente |
| 134 | [Contrato mostra dados de caixas que o usuário não lê (próxima ocorrência e cobranças no cartão)](134-contrato-mostra-dados-de-caixas-nao-legiveis.md) | aberta | bug | — | agente |
| 135 | [Markdown do contrato: a última gravação vence sem aviso (edição concorrente e tool aprovada depois)](135-edicao-concorrente-do-markdown-sem-aviso.md) | aberta | melhoria | — | agente |
| 136 | [Falhas engolidas sem log no worker de faturas, de contratos, das séries e na baixa automática](136-falhas-engolidas-sem-log-nos-workers.md) | aberta | debito-tecnico | — | agente |
| 137 | [Mudar o dia de uma cobrança no cartão (aditivo ou edição da série) reescreve as datas esperadas do passado](137-mudar-o-dia-da-cobranca-no-cartao-reescreve-o-passado.md) | aberta | bug | — | agente |
| 138 | [Rescisão com data em mês fechado falha inteira (última ocorrência proporcional e multa)](138-rescisao-retroativa-em-mes-fechado-falha-inteira.md) | aberta | bug | — | agente |
| 139 | [Importação, casamento e "Aplicar regras" fazem consultas por linha (N+1) numa transação longa](139-importacao-e-aplicar-regras-com-consultas-por-linha.md) | aberta | melhoria | — | agente |
| 140 | [Linhas do CSV com data ou valor inválidos somem do import sem aviso (API e tools)](140-linhas-do-csv-descartadas-sem-aviso-no-import.md) | aberta | melhoria | — | agente |
| 141 | [Linha da fatura casa com qualquer parcela da compra, sem olhar a fatura do lote](141-parcelas-da-fatura-casam-sem-olhar-a-fatura.md) | aberta | melhoria | — | agente |
| 142 | [Prévia do `import_statement` lê lotes de `supersedeImportIds` sem `Access` e sem validar o alvo](142-previa-do-import-statement-sem-validar-supersede.md) | aberta | bug | — | agente |
| 143 | [Consultas do extrato escritas de um jeito que impede o uso dos índices feitos para elas](143-consultas-do-extrato-escritas-de-modo-que-o-indice-nao-serve.md) | aberta | melhoria | — | agente |
| 144 | [`contract_payments` procura a linha conciliada de cada baixa varrendo todas as linhas do sistema](144-contract-payments-procura-a-linha-do-extrato-sem-indice.md) | aberta | banco | — | agente |
| 145 | [Fechar o mês não espera as escritas em andamento naquele mês (escrita entra no mês fechado)](145-fechamento-de-mes-sem-trava-contra-escrita-concorrente.md) | aberta | banco | — | agente |
| 146 | [O canvas de fluxo lê todos os títulos das caixas, de qualquer data, a cada chamada](146-flow-graph-materializa-todos-os-titulos-das-caixas.md) | aberta | banco | — | agente |
| 147 | [Índices que faltam: busca na descrição dos títulos, compras por pagadora e data, espelhos pendentes](147-indices-que-faltam-busca-de-titulos-compras-por-pagadora-e-espelhos-pendentes.md) | aberta | banco | — | agente |
| 148 | [Regras do espelho e da conciliação que a docs/016 atribui ao banco, mas só a aplicação garante](148-invariantes-do-espelho-e-da-conciliacao-abertas-no-banco.md) | aberta | banco | — | agente |
| 149 | [A materialização da série corre sem trava contra "excluir este e os próximos" e "esta e as próximas" do título](149-materializacao-da-serie-sem-trava-contra-esta-e-as-proximas.md) | aberta | banco | — | agente |
| 150 | [Leitura e conversão de documento desistem em 120 s, mas a execução continua e é paga](150-fluxo-sincrono-nao-cancela-execucao-no-timeout.md) | aberta | bug | — | agente |
| 151 | [Na volta à fila por erro do provedor, o console junta o texto parcial ao novo e deixa o erro na tela](151-retentativa-mistura-texto-e-deixa-erro-no-console.md) | aberta | bug | — | agente |
| 152 | [A tool de copiar regras manda "aplicar as regras", mas não existe tool para aplicar](152-aplicar-regras-de-classificacao-sem-tool.md) | aberta | melhoria | — | agente |
| 153 | [set_message_subscriptions grava cada assinatura numa transação: falha no meio deixa metade aplicada](153-assinaturas-do-destino-gravadas-em-varias-transacoes.md) | aberta | bug | — | agente |
| 154 | [Campos de centavos anuláveis vão ao modelo sem a dica "centavos" (aditivo, multa, limite do cartão)](154-dica-de-centavos-ausente-nos-campos-anulaveis.md) | aberta | bug | — | agente |
| 155 | [Auxiliares das prévias duplicados entre os handlers: dinheiro em dois formatos e o filtro de zeros do settle_title que nunca casa](155-duplicacao-e-formato-de-dinheiro-nos-handlers.md) | aberta | debito-tecnico | — | agente |
| 156 | ["Excluir preço" promete que o uso passa ao preço anterior, mas o custo é congelado na gravação e o preço usado não sai](156-excluir-preco-de-modelo-nao-recalcula-o-uso.md) | aberta | bug | — | agente |
| 157 | [Leitura (e o notify_user) em ask mostra cartão vazio, e leituras com efeito externo vão ao /mcp como inofensivas](157-leituras-em-ask-com-cartao-vazio.md) | aberta | melhoria | — | agente |
| 158 | [Specs 021 e 027 descrevem tools de contrato e de regra que não existem mais, e um teste confere uma tool removida](158-registro-de-tools-desatualizado-nas-specs-e-teste-vestigial.md) | aberta | debito-tecnico | — | agente |
| 159 | [Auditoria: a remoção dos segredos e das colunas ruidosas vive só no `audit_row()`, e 11 triggers próprios a contornam](159-auditoria-segredos-fora-do-audit-write.md) | aberta | banco | — | agente |
| 160 | [Bifurcar a sessão não religa os arquivos gerados pelas tools](160-bifurcacao-nao-religa-arquivos-gerados.md) | aberta | banco | — | agente |
| 161 | [A busca semântica recalcula o tamanho de todas as fontes e do índice a cada chamada](161-busca-semantica-conta-todas-as-fontes-a-cada-chamada.md) | aberta | banco | — | agente |
| 162 | [Requisição ao provedor interrompida por queda do processo fica "em andamento" até a purga](162-requisicoes-ao-provedor-presas-em-running.md) | aberta | banco | — | agente |
| 163 | [`schema.sql` sem privilégios e sem conferência no CI, e imagens do banco sem versão fixa](163-schema-de-referencia-e-versoes-sem-checagem.md) | aberta | banco | — | agente |
| 164 | [SSE e hub de eventos consultam o banco a cada delta de texto (e o aviso do banco não diz o tipo do evento)](164-sse-e-hub-consultam-o-banco-a-cada-delta.md) | aberta | banco | — | agente |
| 165 | [O teste de migração com dados roda as migrations como superusuário, ao contrário da produção (tarefa 054)](165-teste-de-migracao-roda-como-superusuario.md) | aberta | banco | — | agente |
| 166 | [O laço de mensagens recalcula resumos e views pesadas a cada 30 s só para a dedup descartar](166-laco-de-mensagens-recalcula-tudo-a-cada-30s.md) | aberta | melhoria | — | agente |
| 167 | [Regravar o token do mesmo bot com a entrada ligada apaga o webhook recém-criado](167-mesmo-token-com-entrada-ligada-apaga-o-webhook.md) | aberta | bug | — | agente |
| 168 | [Resposta e botões do agente no Telegram são marcados como enviados antes do envio e se perdem numa falha](168-resposta-do-telegram-perdida-em-falha-de-envio.md) | aberta | bug | — | agente |
| 169 | [Sino: as não lidas não vêm primeiro e as que passam das 30 mais recentes ficam inalcançáveis](169-sino-sem-nao-lidas-primeiro-nem-paginacao.md) | aberta | bug | — | agente |
| 170 | [Competência das ocorrências novas da série escorrega para o dia 28 depois de fevereiro](170-competencia-da-serie-escorrega-para-o-dia-28.md) | aberta | bug | — | agente |
| 171 | [Gaveta de um grupo grande do canvas falha: os ids das entidades vão na query string](171-gaveta-de-grupo-grande-do-canvas-falha.md) | aberta | bug | — | agente |
| 172 | ["Uma operação de backup por vez" usa duas travas diferentes e deixa a restauração correr junto com a importação](172-operacoes-de-backup-sem-exclusao-mutua.md) | aberta | debito-tecnico | — | agente |
| 173 | [Paginação do JSON completo compara a parte numérica da chave composta como texto, e nenhum teste passa de um lote](173-paginacao-do-json-completo-por-chave-composta.md) | aberta | debito-tecnico | — | agente |
| 174 | [Zero negativo aparece como "-R$ 0,00" no formato contábil](174-zero-negativo-aparece-como-menos-zero.md) | aberta | bug | — | agente |
| 175 | [Texto secundário e valores verdes/vermelhos abaixo do AA (4,5:1), sobretudo no tema escuro padrão](175-contraste-de-texto-abaixo-do-aa.md) | aberta | melhoria | — | agente |
| 176 | [Canvas de fluxo recria `data` de todos os nós e arestas a cada quadro do arrasto e anula o `memo` dos nós](176-canvas-anula-memo-dos-nos-no-arrasto.md) | aberta | melhoria | — | agente |
| 177 | [Nova entidade importa o endereço e os contatos de um CNPJ consultado antes de trocar o documento](177-consulta-de-cnpj-antiga-importada.md) | aberta | bug | — | agente |
| 178 | [Gaveta do título mostra a NF-e emitida à noite com a data do dia seguinte](178-data-de-emissao-da-nfe-um-dia-depois.md) | aberta | bug | — | agente |
| 179 | [Fluxo projetado exportado mostra o "a pagar" positivo, ao contrário da tela e da spec 014](179-pdf-do-fluxo-projetado-sem-sinal-do-a-pagar.md) | aberta | bug | — | agente |
| 180 | [Textos pt-BR fixos fora do `t` do shared e datas no fuso do navegador nas telas](180-textos-e-datas-fora-das-regras-do-projeto.md) | aberta | debito-tecnico | — | agente |
| 181 | [Ajustes de reconhecimento da série têm dois editores e dois resumos que se comportam diferente](181-ajustes-de-reconhecimento-duplicados-e-divergentes.md) | aberta | bug | — | agente |
| 182 | [Cortar `ObligationFormModal.tsx` (898 linhas) e `ContractPage.tsx` (831) e unificar o diff de versões](182-corte-de-obligationformmodal-e-contractpage.md) | aberta | debito-tecnico | — | agente |
| 183 | [Estado das janelas do agente não sincroniza entre abas: a última aba a gravar desfaz o que a outra fechou](183-janelas-do-agente-nao-sincronizam-entre-abas.md) | aberta | bug | — | agente |
| 184 | [CI sem `permissions`, sem `timeout-minutes`, actions e imagens por tag flutuante e o CI do `main` cancelável](184-ci-sem-endurecimento.md) | aberta | melhoria | — | agente |
| 185 | [Documentação de entrada contradiz as specs e o código (contrato, agentes, variáveis de ambiente)](185-documentacao-de-entrada-desatualizada.md) | aberta | debito-tecnico | — | agente |
| 186 | [Erro 500 sem identificador: o usuário vê "Algo deu errado" e o log não tem como ser achado](186-erro-500-sem-id-de-correlacao.md) | aberta | melhoria | — | agente |
| 187 | [Node 26 no desenvolvimento, 22 no CI e na imagem, `@types/node` 26 e `corepack enable` que não existe mais](187-versao-do-node-divergente.md) | aberta | debito-tecnico | — | agente |
| 188 | [Baixas simultâneas nos dois lados do espelho entram em deadlock e voltam como erro 500](188-baixas-simultaneas-nos-dois-lados-do-espelho-em-deadlock.md) | aberta | bug | — | agente |
| 189 | [`pnpm lint` falha quando há uma pasta solta com `biome.json` (hoje, `tmp/`)](189-pnpm-lint-quebra-com-pasta-solta.md) | aberta | debito-tecnico | — | agente |
| 045 | [Corrigir a data do estorno de uma baixa, com auditoria](045-corrigir-data-do-estorno.md) | aberta | melhoria | — | usuario |
| 048 | [XSS armazenado por anexo aberto inline com o Content-Type de quem envia](048-xss-por-anexo-aberto-inline.md) | concluida | bug | app | agente |
| 049 | [Eventos de agente vão para destinos de caixa que o usuário não lê](049-eventos-de-agente-para-destinos-de-caixa-alheia.md) | concluida | bug | app | agente |
| 050 | [Limite de login contornável por X-Forwarded-For](050-limite-de-login-contornavel-por-x-forwarded-for.md) | concluida | bug | app | agente |
| 051 | [Guard de sessão contornável por caminho codificado (`/%61pi/...`)](051-guard-de-sessao-contornavel-por-caminho-codificado.md) | concluida | bug | app | agente |
| 052 | [Parsers OFX e XML quadráticos, sem limite de profundidade](052-parser-ofx-e-xml-quadratico.md) | concluida | bug | app | agente |
| 053 | [Escrita aprovada repetida na retomada da execução do agente](053-escrita-aprovada-repetida-na-retomada.md) | concluida | bug | app | agente |
| 054 | [Dono do banco do dump e da restauração é superusuário](054-dono-do-banco-e-superusuario.md) (dba e depois app) | concluida | banco | dba, app | agente |
| 055 | [Zip bomb nos uploads de backup e de dump](055-zip-bomb-no-upload-de-backup.md) | concluida | bug | app | agente |
| 056 | [Conversa de fluxo arquivada aceita mensagem e perde o escopo da receita](056-mensagem-em-conversa-de-fluxo-arquivada.md) | concluida | bug | app | agente |
| 057 | [Escopo da receita não cobre as tools de lote inteiro](057-escopo-da-receita-sem-tools-de-lote.md) | concluida | debito-tecnico | app | agente |
| 058 | [Prévias das tools leem movimento e contas sem Access](058-previas-de-tools-leem-sem-access.md) | concluida | bug | app | agente |
| 059 | [Texto→áudio e transcrição fora do orçamento](059-audio-fora-do-orcamento.md) | concluida | bug | app | agente |
| 060 | [Limite de execuções por minuto sem trava (TOCTOU)](060-limite-por-minuto-sem-trava.md) | concluida | debito-tecnico | app | agente |
| 061 | [Telegram recebe a resposta depois de desfazer o pareamento](061-telegram-responde-apos-desfazer-pareamento.md) | concluida | bug | app | agente |
| 062 | [Falha transitória do token vira falha definitiva na outbox](062-falha-transitoria-do-token-vira-definitiva.md) | concluida | bug | app | agente |
| 063 | [Erro de assinatura engolido sem log em `produceMessages`](063-erro-de-assinatura-engolido-sem-log.md) | concluida | bug | app | agente |
| 064 | [Dedup do webhook do Telegram fora do processamento](064-dedup-do-webhook-fora-da-transacao.md) | concluida | bug | app | agente |
| 065 | [Cabeçalhos de segurança ausentes (CSP, X-Frame-Options)](065-cabecalhos-de-seguranca-ausentes.md) | concluida | debito-tecnico | app | agente |
| 066 | [Sessão sem expiração por inatividade e cookie sem Secure por padrão](066-sessao-sem-expiracao-por-inatividade.md) | concluida | melhoria | app | agente |
| 067 | [Troca da própria senha pelo admin não revoga as outras sessões](067-troca-da-propria-senha-nao-revoga-sessoes.md) | concluida | bug | app | agente |
| 068 | [Postgres de desenvolvimento exposto na rede com a senha padrão](068-postgres-de-desenvolvimento-exposto-na-rede.md) | concluida | banco | dba, app | agente |
| 069 | [Listas de leitores de segredo incompletas na documentação](069-listas-de-leitores-de-segredo-incompletas.md) | concluida | banco | dba | agente |
| 046 | [Anotações e lembretes no banco (F21)](046-anotacoes-no-banco.md) | concluida | banco | dba | usuario |
| 047 | [Anotações e lembretes na aplicação (F21)](047-anotacoes-na-aplicacao.md) (depois da 046) | concluida | melhoria | app | usuario |
| 043 | [Contratos sobre séries recorrentes no banco (F20)](043-contratos-sobre-series-no-banco.md) | concluida | banco | dba | usuario |
| 044 | [Contratos sobre séries recorrentes na aplicação (F20)](044-contratos-sobre-series-na-aplicacao.md) (depois da 043) | concluida | melhoria | app | usuario |
| 041 | [Pagamentos de contrato no extrato no banco (F19)](041-pagamentos-de-contrato-no-banco.md) (depois da 039) | concluida | banco | dba | usuario |
| 042 | [Pagamentos de contrato no extrato na aplicação (F19)](042-pagamentos-de-contrato-na-aplicacao.md) (depois da 040 e da 041) | concluida | melhoria | app | usuario |
| 040 | [Regras de classificação por conta na aplicação (F18)](040-regras-por-conta-na-aplicacao.md) (depois da 039) | concluida | melhoria | app | usuario |
| 039 | [Regras de classificação por conta no banco (F18)](039-regras-por-conta-no-banco.md) | concluida | banco | dba | usuario |
| 038 | [Lote provisório e a troca pelo consolidado na aplicação (F17)](038-lote-provisorio-na-aplicacao.md) (depois da 037) | concluida | melhoria | app | usuario |
| 037 | [Lote provisório e a troca pelo consolidado no banco (F17)](037-lote-provisorio-no-banco.md) | concluida | banco | dba | usuario |
| 035 | [Receitas de conciliação no banco (F16)](035-receitas-de-conciliacao-no-banco.md) | concluida | banco | dba | usuario |
| 036 | [Receitas de conciliação na aplicação (F16)](036-receitas-de-conciliacao-na-aplicacao.md) (depois da 035) | concluida | melhoria | app | usuario |
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
