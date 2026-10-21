# 020 — Contratos

- Um **contrato** registra um acordo com uma entidade ([003](003-entidades.md)) dentro de uma caixa: eu **recebo** (presto o serviço) ou eu **pago** (contrato o serviço). A permissão é a da caixa ([002](002-usuarios-e-permissoes.md)).
- Desde a F20 ([034](034-contratos-sobre-series.md)) o contrato é o **documento e o vínculo**: a contraparte, a vigência, os documentos com as cláusulas, os avisos e as **obrigações** — séries recorrentes comuns ([005](005-titulos-baixas-e-movimentos.md)), cada uma presa à conta (corrente, poupança ou cofre) ou ao cartão onde o dinheiro de fato se move. O contrato não gera parcelas próprias: as ocorrências são títulos normais da série (baixas, conciliação, calendário, relatórios, canvas e avisos funcionam sem nada especial) ou, no cartão, cobranças esperadas na fatura.
- O pagamento é sempre um fato: a movimentação na conta (extrato importado ou lançamento manual no cofre) ou a compra na fatura do cartão. Como a linha do extrato acha a ocorrência está na [033](033-pagamentos-de-contrato-no-extrato.md).
- Cada contrato guarda vários **documentos** (contrato original, aditivos, renovação, distrato…), em PDF (somente leitura) ou markdown (leitura e edição, com versões).

## Cadastro

- Campos: caixa, entidade (contraparte), direção (`receivable` eu recebo, `payable` eu pago), nome/objeto, número do contrato (opcional), **categoria padrão** (compatível com a direção; a das obrigações que não escolhem outra), anotações.
- **Vigência**: início e fim (sem fim = prazo indeterminado). Renova automaticamente (sim/não) e **aviso prévio** em dias (prazo para pedir a não renovação ou a rescisão).
- **Reajuste** (informativo): índice (IPCA, IGP-M, INPC, outro, nenhum) e data-base (padrão: aniversário do contrato). O sistema não busca índices; a data-base gera um lembrete e o novo valor entra por aditivo.
- Multa rescisória (opcional, texto ou valor) fica registrada para consulta na rescisão.
- **Obrigações** (uma ou várias: aluguel + condomínio; mensalidade + taxa anual): descrição, valor, calendário (semanal, mensal com intervalo — trimestral = a cada 3 meses —, anual), primeiro vencimento (o dia âncora sai dele), competência da primeira (padrão: o mês do primeiro vencimento; ex.: serviço de março que vence em abril), fim (padrão: o fim da vigência), categoria (padrão a do contrato) e:
  - **numa conta** (corrente, poupança ou cofre): a série de títulos na **caixa da conta** (que pode não ser a do contrato), com a conta prevista em cada ocorrência;
  - **no cartão** (só quando eu pago): a cobrança esperada no cartão, com a caixa pagadora ([007](007-cartao-de-credito.md));
  - e os **ajustes de reconhecimento** do pagamento (janela, multa, juros, desconto, tolerância e baixar sem confirmação; [033](033-pagamentos-de-contrato-no-extrato.md)), que o agente pode ler das cláusulas do documento.
- Uma série solta (criada como título recorrente) pode ser **ligada** ao contrato, desde que tenha a direção e a contraparte dele; e desligada pela série.

## Ciclo de vida

- Status: **rascunho** (sem obrigações, tudo editável), **vigente**, **encerrado** (chegou ao fim sem renovar) e **rescindido** (encerrado antes do fim, final). Não existe mais "renovação pendente": renovar é uma ação.
- Criar com obrigações já cria vigente; sem obrigações dá para salvar como rascunho e **ativar** depois. Rascunho não recebe obrigação (o banco recusa título ou compra ligada a rascunho).
- Vigente: caixa, contraparte e categoria padrão não mudam; a vigência muda ao **renovar** ou **rescindir**; nome, número, notas, documentos, renovação automática, aviso prévio, reajuste e multa ficam livres. Os valores e as datas das obrigações mudam pelo **aditivo** ou pela edição da série ("esta e as próximas").
- **Aditivo**: documento do tipo aditivo + data de efeito + as obrigações atingidas + o que muda (novo valor ou reajuste em %, dia, categoria, conta). Aplicar roda "esta e as próximas" ([005](005-titulos-baixas-e-movimentos.md)) a partir da primeira ocorrência em aberto na data de efeito; ocorrências com baixa (inclusive parcial) ou em mês fechado não mudam e aparecem na prévia. No cartão, muda o valor esperado dali em diante. O contrato guarda o histórico (antes → depois, obrigações atingidas, documento).
- **Renovar**: nova data de fim (ou sem fim). Estende a vigência (uma nova linha no histórico de vigências) e o fim das obrigações que iam até o fim do contrato, pelo mesmo tanto (o "estender série": reabre as canceladas depois do fim anterior e materializa o que faltar). Encerrado pode ser renovado; rescindido não; contrato sem fim não tem o que renovar.
- **Renovação automática**: ao passar do fim, o worker renova pelo mesmo prazo da última vigência (quantas vezes for preciso até cobrir hoje) e avisa no sino. Sem renovação automática, o contrato vira **encerrado** (as séries já terminam no fim da vigência).
- **Rescisão**: data de encerramento (dentro da vigência). As ocorrências sem baixa com competência depois dela são canceladas, com o espelho (nada é apagado); as com baixa ou em mês fechado ficam (a prévia avisa). A **última ocorrência** de cada obrigação (a que cobre a data) pode ter o valor ajustado — a prévia sugere o proporcional pelos dias cobertos. As séries terminam na data (ou no vencimento da última ocorrência mantida); a cobrança no cartão, na data. A multa ou o valor rescisório é um **título avulso** ligado ao contrato (valor, vencimento, categoria, conta prevista), espelhado como as ocorrências. O fim da vigência passa a ser a data da rescisão.
- O fechamento de mês ([008](008-categorias-auditoria-e-exclusao.md)) vale para as ocorrências como para qualquer título.

## Documentos

- Vários por contrato, cada um com tipo (`contract`, `amendment`, `renewal`, `termination`, `proposal`, `other`), data, descrição e formato.
- **PDF**: anexo imutável (até 20 MB, como os demais anexos). Visualizador embutido somente leitura (paginação e zoom) e download.
- **Markdown**: versionado. Cada salvamento cria uma versão imutável (autor, data, nota opcional); o documento aponta para a atual. Visões: **renderizado** (o mesmo renderizador seguro do chat dos agentes, sem HTML cru), **raw** e **editar** (editor com prévia lado a lado). Histórico com comparação entre duas versões (diff) e **restaurar** (cria uma versão nova com o conteúdo antigo; nada é apagado).
- Origens do markdown: **upload de .md** (UTF-8, até 1 MB, vira a versão 1), **novo em branco** no editor e **gerado do PDF por IA** (o agente dos fluxos converte um PDF do contrato; a versão 1 fica com autor = agente e aponta para o PDF de origem).
- Excluir documento: só arquiva (some da lista, fica no histórico), como o resto do sistema.

## IA

- Ao subir o PDF do contrato, `POST /api/contracts/document` pede ao agente dos fluxos ([011](011-agentes-de-ia.md)) uma leitura que sugere: contraparte (CNPJ/CPF → entidade cadastrada, ou dados para cadastrar), direção em relação ao titular da caixa, objeto, número, início, duração, valor total ou por parcela, periodicidade, dia de vencimento, renovação automática, aviso prévio, índice e data-base de reajuste e multa rescisória. O formulário converte em vigência (fim = início + duração) e numa obrigação (calendário pela periodicidade, valor por ocorrência, primeiro vencimento pelo dia). O usuário revisa antes de salvar; nada é gravado pela leitura. Sem agente, 501 e cadastro manual.
- A conversão PDF → markdown usa o mesmo agente e espera até `AI_DOCUMENT_TIMEOUT_MS`.
- Tools de contrato ([034](034-contratos-sobre-series.md)): `list_contracts`, `get_contract`, `create_contract` (com as obrigações), `update_contract`, `activate_contract`, `add_contract_obligation`, `link_series_to_contract`, `add_contract_amendment`, `terminate_contract`, `renew_contract`, os documentos (`get_contract_document`, `save_contract_markdown`, `convert_contract_pdf`) e as de série (`get_series`, `create_series`, `update_series`, `end_series` com `titleId` ou `ruleId`), todas com prévia nas escritas.

## Espelho

- Se a contraparte é titular de uma caixa, as ocorrências das obrigações nas contas espelham como qualquer título ([006](006-espelhamento-entre-caixas.md)): o lado oposto na caixa dela (a do contrato, `counterparty_caixa_id`), com aceite pendente quando falta permissão. A cobrança no cartão não espelha.
- O contrato pertence à caixa que o cadastrou. Quem lê a caixa da contraparte vê o contrato e os documentos pelo título espelhado (somente leitura); editar, aditar, renovar e rescindir é de quem escreve na caixa dona (e na caixa de cada obrigação). Aditivo e rescisão atualizam os dois lados do espelho na mesma transação.

## Avisos

Eventos no sino e nas assinaturas de mensagens ([013](013-mensagens-telegram.md)), com parâmetros e `dedup_key` por contrato e fim da vigência:

- **Aviso prévio** (`contract_notice_deadline`): D-N antes do último dia para pedir a não renovação ou a rescisão (fim − aviso prévio).
- **Fim da vigência** (`contract_ending`): D-N antes do fim; também o aviso "renovado automaticamente" quando o worker renova.
- **Reajuste** (`contract_readjustment`): na data-base.
- **Cobrança não feita** (`contract_charge_missing`, só sino): ocorrência de cobrança no cartão cuja fatura fechou sem a compra ligada, uma vez por ocorrência.
- `contract_renewal_pending` ficou só como histórico (assinaturas antigas não recebem mais mensagens).
- **Ocorrências**: os avisos de vencimento e atraso que já existem mostram o contrato.

## Visões

- **Lista** `/contracts`: filtros por caixa, entidade, direção, status e "termina em X dias"; colunas com contraparte, vigência, obrigações, próxima ocorrência e status; exporta CSV/PDF.
- **Detalhe do contrato** ([034](034-contratos-sobre-series.md)): cabeçalho, vigência e histórico (vigências anteriores — as de antes da F20 com o resumo do ciclo de parcelas —, aditivos, rescisão, tarefas de renovação antigas), obrigações (cada série com a conta ou o cartão, a próxima ocorrência, o valor, os ajustes, o aviso "obrigação sem conta", editar e encerrar/estender), títulos avulsos, documentos e a guia **Pagamentos** ([033](033-pagamentos-de-contrato-no-extrato.md)).
- **Painel de recorrentes**: receita e despesa contratadas por mês nos próximos 12 meses (ocorrências das obrigações e cobranças esperadas no cartão) e o líquido; contratos que terminam em 90 dias e os encerrados nos últimos 90 dias.
- **Aba Contratos na entidade**: os contratos com aquela empresa ou pessoa, nas caixas que o usuário lê.

## Fora do escopo agora

- Busca automática de índices de reajuste, assinatura eletrônica, modelos de contrato com campos e rateio de uma ocorrência por várias categorias.

## Decisões da implementação

- **Rotas**: `GET/POST /api/contracts`, `GET /api/contracts/panel`, `POST /api/contracts/document` (leitura por IA), `GET/PATCH/DELETE /api/contracts/:id`, `POST /api/contracts/:id/{restore,activate}`, `POST /api/contracts/:id/obligations` (obrigação nova) e `/obligations/link` (`{ruleId}`), `POST /api/contracts/:id/{amendments,terminate,renew}` (aceitam `?dryRun=1` para a prévia), `GET /api/contracts/:id/payments?cycleId=`, os documentos (`POST /api/contracts/:id/documents` com upload cru de PDF ou .md e `/documents/markdown`, `GET/PATCH/DELETE /api/contract-documents/:id`, `POST …/restore`, `POST …/convert`, `GET/POST …/versions`, `GET …/versions/:v` e `POST …/versions/:v/restore`) e as séries (`GET/POST /api/series`, `GET/PATCH /api/series/:id`, `GET/POST /api/series/:id/end`).
- **Vigências**: criar grava a vigência 1 em `contract_cycles` (só início e fim); renovar acrescenta a seguinte (começa no dia seguinte ao fim anterior). Editar a vigência do rascunho atualiza a 1.
- **Renovar**: estende as séries com fim por data cujo fim estava a menos de um período do fim da vigência (as que já tinham acabado antes não voltam); o novo fim da série é o antigo deslocado pelo mesmo prazo da renovação (meses; dias no semanal), ou sem fim.
- **Rescisão**: as ocorrências canceladas são as de competência depois da data; a "última" de cada obrigação é a não cancelada cuja competência ≤ data < fim do período dela, com o proporcional pelos dias (mínimo 1 centavo); o valor pedido só muda ocorrência sem baixa.
- **Worker**: no laço das séries, renova (renovação automática) ou encerra cada contrato vigente que passou do fim, numa transação por contrato, como ator `system`; o aviso da renovação vai para os membros da caixa e os admins. Os avisos do sino saem no horário `NOTIFY_AT` (aviso prévio D-15/7/1/0, fim D-30/7/0, reajuste na data-base, cobrança não feita até 120 dias para trás).
- **Backup** ([019](019-backup-e-restauracao.md)): contratos, vigências, documentos, versões, aditivos, tarefas antigas, séries, cobranças no cartão (e os degraus do valor) e as ocorrências importam juntos (checagens no COMMIT); arquivos de antes da F20 são convertidos pelo critério da migração 0052.

```
Caixa "Casa"
 Contrato "Locação Rua A"   eu pago · Imobiliária Alfa CNPJ …
 vigência 01/11/2026 – 31/10/2027 · renova automaticamente · aviso prévio 30 dias

 Obrigações
  Aluguel        R$ 2.000,00 · mensal dia 10 · conta Banco A (corrente)   multa 2% · juros 1% a.m. · janela 30 dias
  Condomínio     R$ 500,00   · mensal dia 5  · Cofre (caixa Casa)
  Seguro fiança  R$ 89,90    · mensal dia 15 · cartão Visa (pagadora Casa)

 Documentos
  contrato-alfa.pdf         contrato   01/11/2026   PDF
  contrato-alfa.md          contrato   v3 · editado em 12/02/2027
```
