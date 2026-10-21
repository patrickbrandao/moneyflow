# 034 — Contratos sobre séries recorrentes (F20)

O contrato deixa de gerar parcelas próprias. Passa a ser o **documento e o vínculo**: a entidade, a vigência, os documentos com as cláusulas, os avisos e as **obrigações** — séries recorrentes comuns ([005](005-titulos-baixas-e-movimentos.md)), cada uma presa à conta (ou ao cartão) onde o dinheiro de fato se move. O pagamento é sempre um fato: a movimentação na conta (extrato importado ou lançamento manual no cofre) ou a compra na fatura do cartão. Substitui o ciclo de parcelas da [020](020-contratos.md) e a conta das parcelas e a de passagem da [033](033-pagamentos-de-contrato-no-extrato.md).

Decisões do usuário (2026-10-20): o contrato lança séries recorrentes nas contas em vez de registros próprios; contas corrente, poupança e cofre, e também cartão de crédito; há contratos em produção a migrar; a regra de reconhecimento do pagamento fica para a sessão decidir (decidido: vale para toda série recorrente, com os ajustes na série).

## O contrato

- Caixa, entidade, direção (a receber ou a pagar), nome, número, categoria padrão, **vigência** (início e fim; sem fim = indeterminado), aviso prévio, renova automaticamente, reajuste (índice e data-base, informativo), notas, documentos (PDF e markdown versionado, como hoje) e aditivos.
- **Obrigações**: as séries ligadas a ele (`contract_id` na série). Um contrato pode ter várias (aluguel + condomínio; mensalidade + taxa anual). Cada uma tem descrição, valor, calendário (semanal, mensal com intervalo — trimestral = a cada 3 meses —, anual), dia, categoria (padrão a do contrato), a conta e os ajustes de reconhecimento (abaixo).
- Status: rascunho, ativo, encerrado, rescindido (sem `renewal_pending`: a renovação é uma ação, abaixo).

## Obrigação numa conta (corrente, poupança ou cofre)

- É uma série recorrente de títulos ([005](005-titulos-baixas-e-movimentos.md)) **na caixa da conta**, com a conta em cada ocorrência (`titles.planned_account_id`, que passa a aceitar `cash`). Não existe mais conta de passagem: a obrigação mora onde o dinheiro se move. O worker materializa as ocorrências até 12 meses à frente, como toda série.
- **Na tela da conta** ([004](004-caixas-e-contas.md)), o Extrato mostra as ocorrências previstas em aberto da conta (as das séries com essa conta), separadas dos movimentos, com "Baixar" (a baixa já vem na conta, na data de hoje e no valor previsto, editáveis).
- **Corrente e poupança**: o extrato importado baixa a ocorrência pela conciliação (abaixo).
- **Cofre**: não há extrato; o fato é o lançamento manual. "Baixar" na ocorrência registra a baixa e o movimento no cofre. Lançar um movimento avulso no cofre com a mesma entidade e um valor que a regra de reconhecimento aceita para uma ocorrência em aberto do cofre oferece "É o pagamento de <obrigação> de <mês>? Baixar a ocorrência" no lugar do avulso.

## Obrigação no cartão de crédito

- É uma **cobrança recorrente esperada** no cartão: calendário, valor, entidade, categoria e a caixa pagadora ([007](007-cartao-de-credito.md)). Não gera título nem compra adiantada: a fatura só tem o que de fato foi cobrado.
- As ocorrências esperadas são calculadas pelo calendário (não materializadas). Cada compra que atende uma ocorrência fica ligada a ela (`card_purchases.contract_id`, a série e o número da ocorrência).
- **Na importação da fatura**, a linha que a regra de reconhecimento casa com uma ocorrência esperada (mesmo mês, valor, descrição/entidade) vira a sugestão "Lançar como cobrança de <obrigação> de <mês>": confirmar cria a compra à vista na caixa pagadora da obrigação, já ligada (com baixa sem confirmação, se a série permitir). Uma compra lançada à mão no cartão também pode ser ligada a uma ocorrência ("É cobrança de um contrato?").
- **Não cobrada**: ocorrência cujo mês já fechou na fatura sem compra ligada aparece como "não cobrada" no contrato e gera o aviso do sino (`contract_charge_missing`), uma vez por ocorrência.

## Reconhecer o pagamento (toda série recorrente)

A regra da [033](033-pagamentos-de-contrato-no-extrato.md) passa a valer para **qualquer série recorrente**, ligada a contrato ou não (contas de luz, escola, assinaturas também variam e atrasam). Os ajustes ficam **na série**:

- janela (`match_window_days`, padrão 15, 0–45) além do mesmo mês do vencimento;
- multa (%), juros ao mês (%, pró-rata), desconto por pontualidade (%), tolerância (centavos, até 10% do valor);
- baixar sem confirmação (`auto_settle`, padrão desligado).

Sem ajustes, a série casa no mesmo mês ou na janela com valor exato. Título avulso (fora de série) continua com a regra de hoje (valor exato, ±3 dias). O resto da 033 fica: candidatos pela conta da ocorrência, desempate do valor igual (o mês da linha; se pago, a mais antiga em aberto), parcial só como sugestão, baixa repartida em principal, multa, juros e desconto, `auto_settled` e o aviso do sino. Na fatura do cartão, a mesma regra compara a linha com as ocorrências esperadas (sem encargos, só valor e tolerância).

## Eventos do contrato como operações da série

- **Aditivo / reajuste**: o aditivo registra o documento, a data de efeito e o que muda; aplicar escolhe as obrigações e o novo valor (ou dia, categoria, conta) e roda "esta e as próximas" ([005](005-titulos-baixas-e-movimentos.md)) a partir da primeira ocorrência em aberto na data de efeito. Ocorrências com baixa não mudam. Na obrigação do cartão, muda o valor esperado dali em diante.
- **Renovar**: estende a vigência e o fim das séries (o "estender série"); na renovação automática, o worker estende sozinho ao chegar o fim e avisa. O aviso de fim de vigência e o de aviso prévio continuam pelas datas do contrato.
- **Rescindir**: data de encerramento; encerra as séries nessa data ("encerrar série": as ocorrências seguintes em aberto são canceladas, nada é apagado); a última ocorrência pode ter o valor editado (proporcional, à mão ou pelo agente); multa ou valor rescisório é um título avulso ligado ao contrato.
- **Encerrar** (fim da vigência sem renovar): encerra as séries no fim.

## Detalhe do contrato

Cabeçalho, vigência e histórico (vigências anteriores, aditivos, rescisão), obrigações (cada série com conta ou cartão, próxima ocorrência, valor, ajustes, editar), documentos e a guia **Pagamentos** da 033 somando as obrigações: valores por mês (previsto × pago, encargos e desconto), dias de atraso ou adiantamento por ocorrência, resumo e tabela (no cartão, a data da compra e "não cobrada").

## Agentes

As tools de contrato passam a operar sobre as obrigações: criar o contrato com as obrigações, ligar uma série existente a um contrato, aplicar aditivo, renovar e rescindir com prévia; as tools de série (editar esta e as próximas, encerrar e estender) e de conciliação servem às obrigações. O agente lê o documento do contrato (cláusulas, multa, reajuste) para preencher os ajustes e propor aditivos.

## Migração dos contratos existentes (produção)

Numa migration, sem perder baixa, conciliação, auditoria nem documento:

- Cada contrato vira um contrato da nova forma, com vigência = do início do primeiro ciclo ao fim do último (rescindido: até a data da rescisão).
- As parcelas (`titles` com `origin = 'contract'`) de cada contrato viram **uma série**: uma `recurrence_rule` com o calendário da periodicidade (mensal 1, trimestral 3, semestral 6, anual 12 meses; parcela única = título avulso ligado ao contrato), o dia do vencimento, início no primeiro vencimento e fim no último; os títulos passam a `origin = 'recurrence'` com a ocorrência na ordem do vencimento e continuam com o `contract_id`. Valores diferentes (o resto na 1ª, aditivos) ficam como estão em cada título. Canceladas continuam canceladas.
- A conta de cada ocorrência: a conta prevista que já tiver (F19); senão, a conta da última baixa do contrato; senão, nenhuma (o usuário escolhe na obrigação, e a tela do contrato avisa "obrigação sem conta").
- `contracts.payment_account_id`/`transit_account_id` e `titles.planned_transit_account_id` saem: a ocorrência com conta de passagem fica com a de passagem como conta (é da caixa dela). Linhas conciliadas com `transfer_settlement` continuam válidas (histórico; desfazer segue funcionando); a baixa nova não cria mais transferência.
- Os ajustes de reconhecimento do contrato (encargos, tolerância, janela, `auto_settle`) passam para a série.
- `contract_cycles` vira o histórico de vigências (somente leitura para os antigos; renovar acrescenta um); `contract_renewal_tasks` fica como histórico, sem tarefas novas (as abertas são fechadas, e o aviso de fim de vigência assume).
- O backup ([019](019-backup-e-restauracao.md)) converte arquivos antigos pelo mesmo critério.

## Banco (dba)

- Séries: `recurrence_rules.contract_id` (FK, `SET NULL`), o alvo (caixa da série e, para cartão, `card_caixa_id`, entidade, categoria, valor, caixa pagadora da cobrança esperada) e os ajustes de reconhecimento. Avalie se a cobrança esperada do cartão cabe em `recurrence_rules` com colunas próprias ou numa tabela `card_recurring_charges` com o calendário em `recurrence_rules`; a regra de negócio é a desta especificação.
- `titles.planned_account_id` aceita `checking|savings|cash` e é da caixa do título; sai `planned_transit_account_id`.
- `card_purchases`: `contract_id`, a série e a ocorrência (única por série e ocorrência entre as compras não estornadas).
- `contracts`: vigência; saem as colunas da 033 (conta das parcelas, passagem, encargos, janela, `auto_settle`) depois de migradas; status sem `renewal_pending`. Ciclos e tarefas de renovação como histórico.
- `contract_payments` passa a ler as obrigações (ocorrências de título e as esperadas do cartão com a compra ligada).
- A migração da seção anterior, o down de melhor esforço e o pgTAP (migração de um contrato com dois ciclos, aditivo e rescisão; conta da ocorrência; cartão; não cobrada).

## Aplicação (app)

- Reescrever a [020](020-contratos.md) e a [033](033-pagamentos-de-contrato-no-extrato.md) por esta (a 020 fica com documentos, avisos, espelho e visões; a 033 com a regra de reconhecimento, generalizada para a série).
- Serviços: contratos com obrigações; séries com contrato, conta e ajustes; o worker de contratos (renovação automática, avisos, não cobrada); a regra de reconhecimento pela série em `candidatesFor`/`pickMatch`; a sugestão da fatura do cartão; o "É o pagamento de…?" do cofre; a baixa sem transferência.
- Telas: formulário do contrato (vigência + obrigações), formulário de série com conta/cartão e ajustes, detalhe do contrato, previstos no Extrato da conta, sugestões na conciliação da conta e da fatura.
- Tools e testes: integração (contrato com duas obrigações em contas diferentes; aluguel atrasado baixado pelo extrato; cofre; cobrança no cartão casada na fatura e a não cobrada; aditivo; renovar; rescindir; a migração de um contrato antigo) e e2e (criar contrato com obrigação na conta, importar o extrato com o pagamento e ver a parcela paga no contrato).

## Decisões da implementação (F20)

Entregue nas tarefas [043](../tasks/043-contratos-sobre-series-no-banco.md) (banco) e [044](../tasks/044-contratos-sobre-series-na-aplicacao.md) (aplicação). O que a especificação deixava em aberto ficou assim:

- **Rascunho** não tem obrigações (o banco recusa título ou compra ligada a rascunho): criar com obrigações já cria vigente; sem elas, o contrato pode ficar em rascunho e as obrigações entram depois de ativar (`POST /api/contracts/:id/obligations`). Criar com `activate: false` e obrigações é recusado (400).
- **Obrigação nova**: o dia âncora sai do primeiro vencimento; a competência da primeira ocorrência é informada ou, omitida, o mês do primeiro vencimento (as seguintes mantêm o deslocamento); o fim omitido é o fim da vigência. Na conta, a série vai para a caixa da conta (escrita nela exigida; conta de uma caixa da contraparte é recusada) e espelha na caixa do espelho do contrato; no cartão, só em contrato que eu pago, com a pagadora padrão do cartão quando omitida.
- **Candidatos pela conta**: a ocorrência entra quando é da caixa da conta e a conta prevista é a da linha **ou não tem conta** (séries antigas sem conta continuam achadas).
- **Edição da série** (`PATCH /api/series/:id`): os ajustes valem na hora (teto da tolerância pelo valor atual); valor, dia, descrição, categoria e conta mudam as ocorrências em aberto sem baixa com vencimento a partir da data de efeito (padrão hoje); mudar o dia recalcula o vencimento delas pelo calendário novo. Na cobrança no cartão, o valor muda a partir da primeira ocorrência na data (o degrau em `card_recurring_charge_amounts`; na 1ª, o próprio valor da cobrança), e descrição, categoria e pagadora valem para as próximas.
- **Aditivo**: grava as obrigações atingidas (`recurrence_rule_ids`), as ocorrências mudadas e puladas e o antes → depois (valor, dia, categoria, conta, reajuste %); o ciclo é a vigência que contém a data de efeito (ou nenhum).
- **Renovar**: estende as séries com fim por data cujo fim estava a menos de um período do fim da vigência, pelo mesmo prazo (meses; dias no semanal) ou sem fim; o contrato encerrado volta a vigente. Renovação automática: o worker renova pelo prazo da última vigência até cobrir hoje e avisa no sino (`contract_ending`, "renovado automaticamente", dedup por contrato e vigência).
- **Rescindir**: cancela as ocorrências sem baixa com competência depois da data (as com baixa e as de mês fechado ficam), ajusta a "última" de cada obrigação pelo valor pedido (a prévia sugere o proporcional pelos dias do período), termina cada série no maior entre a data e o vencimento da última mantida, a cobrança no cartão na data, e grava `terminated_on = ends_on` no mesmo UPDATE. A multa é um título avulso (`origin = manual`) com a conta prevista opcional.
- **Fatura do cartão**: a sugestão "Lançar como cobrança de…" é calculada ao abrir o lote (não é gravada: não há lançamento para ligar) e não repete a mesma ocorrência em duas linhas; a baixa sem confirmação no cartão só com o valor exato. A compra criada é à vista, na pagadora da obrigação, com a descrição, o recebedor e a categoria da cobrança.
- **"Não cobrada"**: pelo critério do `contract_payments` (a primeira fatura do cartão que fecha na data esperada ou depois fechou sem compra ligada); o sino avisa os membros da caixa do contrato e os admins, até 120 dias para trás, uma vez por ocorrência (`contract_charge_missing:<série>:<n>`).
- **Cofre**: "É o pagamento de…?" usa a mesma regra da série sobre as ocorrências previstas no cofre com a entidade do lançamento (`GET /api/accounts/:id/obligation-matches`, que vale para qualquer conta; a tela oferece no cofre); confirmar faz a baixa repartida no cofre no lugar do avulso.
- **Avisos por mensagem**: aviso prévio e fim pela vigência do contrato (dedup `<contrato>:<fim>`); as assinaturas antigas de `contract_renewal_pending` deixam de receber mensagens.
- **Worker**: as séries de cartão ficam fora da materialização (não têm títulos); a ocorrência nova copia a conta prevista e o contrato do modelo e tira o " · n/N" das parcelas antigas. A renovação automática roda com um acesso de sistema (sem ator humano na transação: auditoria `system`).
- **Tools**: `create_contract` (com as obrigações), `add_contract_obligation`, `link_series_to_contract`, `renew_contract` (no lugar de `decide_contract_renewal`), `get_series`, `create_series`, `update_series`, `create_card_charge_from_line`, e `end_series` aceita `ruleId`.
- **Backup**: os arquivos antigos são convertidos pelo critério da migração (sem a baixa usada para a conta prevista quando não há baixa ativa no arquivo); `card_recurring_charges`/`card_recurring_charge_amounts` entram como tabelas de chave composta.
