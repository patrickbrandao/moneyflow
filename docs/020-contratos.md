# 020 — Contratos

- Um **contrato** registra um acordo com uma entidade ([003](003-entidades.md)) dentro de uma caixa: eu **recebo** (presto o serviço; parcelas a receber) ou eu **pago** (contrato o serviço; parcelas a pagar). A permissão é a da caixa ([002](002-usuarios-e-permissoes.md)).
- O contrato **gera os títulos** das parcelas ([005](005-titulos-baixas-e-movimentos.md)), todos ligados a ele. Os títulos são títulos normais: baixas, conciliação, calendário, relatórios, canvas e avisos funcionam sem nada especial.
- Cada contrato guarda vários **documentos** (contrato original, aditivos, renovação, distrato…), em PDF (somente leitura) ou markdown (leitura e edição, com versões).
- A **renovação** nunca lança nada sozinha: vira uma **tarefa de renovação** que o usuário aprova informando o que muda (valor, vencimento, periodicidade) ou recusa (encerra).

## Cadastro

- Campos: caixa, entidade (contraparte), direção (`receivable` eu recebo, `payable` eu pago), nome/objeto, número do contrato (opcional), categoria (uma por contrato, compatível com a direção; aplicada a todas as parcelas), anotações.
- **Ciclo** (vigência): data de início, duração em meses (1–120) e valor total do ciclo em centavos. O fim é o dia anterior ao mesmo dia do mês, `duração` meses depois: início 01/03/2025 com 12 meses vai até 28/02/2026, com 12 parcelas (mar/2025 a fev/2026); março/2026 já é o primeiro mês do ciclo seguinte. Se esse dia não existe no mês final, o ciclo vai até o último dia dele (31/01 com 1 mês vai até 28/02, e o seguinte começa em 01/03).
- **Periodicidade**: mensal, trimestral, semestral, anual ou parcela única no ciclo. Número de parcelas = duração ÷ meses do período (a duração precisa ser múltipla do período; parcela única = 1).
- **Divisão**: valor total ÷ número de parcelas, em parcelas iguais; o resto em centavos fica na **primeira parcela** (como nas compras parceladas do cartão, [007](007-cartao-de-credito.md)). Depois de gerada, uma parcela pode ser editada como qualquer título.
- **Competência** da parcela = primeiro mês do período que ela cobre. **Vencimento**: dia fixo do mês (1–31; meses curtos usam o último dia) no mês da competência ou num mês depois (deslocamento 0–3; ex.: serviço de março vence em 10/abril = dia 10, deslocamento 1).
- **Renovação**: `renova automaticamente` (sim/não), **aviso prévio** em dias (prazo para pedir a não renovação ou a rescisão) e antecedência da tarefa de renovação (padrão 60 dias antes do fim).
- **Reajuste** (informativo): índice (IPCA, IGP-M, INPC, outro, nenhum) e data-base (padrão: aniversário do contrato). O sistema não busca índices; a data-base gera um lembrete e o percentual é informado na renovação ou no aditivo.
- Multa rescisória (opcional, texto ou valor) fica registrada para consulta no encerramento.

## Ciclo de vida

- Status: **rascunho** (sem títulos, tudo editável), **vigente** (títulos do ciclo gerados), **renovação pendente** (tarefa aberta), **encerrado** (chegou ao fim sem renovar) e **rescindido** (encerrado antes do fim).
- **Ativar** gera, numa transação, todas as parcelas do ciclo de uma vez (não pelo horizonte de 12 meses das séries). Os títulos têm `origin = contract`, o ciclo e o número da parcela (n de N), e o nome do contrato na descrição.
- Com o contrato vigente, valor, vencimento e categoria só mudam por **aditivo**, e prazo e periodicidade, na **renovação** (o próximo ciclo); nome, número, notas, documentos e a configuração de renovação, avisos e reajuste ficam livres.
- **Aditivo**: documento do tipo aditivo + data de efeito + o que muda (novo valor por parcela ou valor total restante, dia de vencimento, deslocamento, categoria). As parcelas **em aberto e sem baixa** com competência na data de efeito ou depois são recalculadas na mesma transação; parcelas com baixa (inclusive parcial) não mudam e aparecem como aviso. O contrato guarda o histórico dos aditivos (antes → depois).
- **Rescisão**: informo a data de encerramento; parcelas sem baixa com competência depois dela são canceladas; a parcela do mês da rescisão pode ter o valor ajustado (proporcional); e posso lançar um título extra de **multa ou valor rescisório** (valor, vencimento, categoria) ligado ao contrato. Parcelas pagas nunca mudam. Tudo numa transação, com prévia do que será cancelado.
- O fechamento de mês ([008](008-categorias-auditoria-e-exclusao.md)) vale para os títulos gerados: aditivo e rescisão não tocam parcelas de competência em mês fechado (a prévia avisa).

## Renovação

- Contrato com renovação automática: na antecedência configurada, o worker abre a **tarefa de renovação** (uma por ciclo) e o contrato fica **renovação pendente**. Aviso no sino e nos destinos que assinam o evento ([013](013-mensagens-telegram.md)).
- A tarefa abre um formulário com o próximo ciclo pré-preenchido com as condições atuais: duração, valor total (ou reajuste em %, que calcula o novo total), periodicidade, dia de vencimento e deslocamento, categoria. Ações:
  - **Renovar**: cria o ciclo seguinte (início = dia seguinte ao fim do atual) e gera as parcelas numa transação; pode anexar o documento de renovação.
  - **Não renovar**: o contrato termina no fim do ciclo atual (vira **encerrado** nessa data).
- **Sem resposta**: nada é lançado. Passado o fim, a tarefa continua aberta e destacada como vencida (lembretes a cada N dias), o contrato aparece como "renovação pendente" e nenhuma parcela nova existe até a aprovação. A renovação aprovada depois do fim gera as parcelas desde o início do novo ciclo (inclusive meses já passados).
- Contrato sem renovação automática: avisos de fim de vigência; "Renovar" fica disponível na tela a qualquer momento, com o mesmo formulário.
- Só quem escreve na caixa aprova ou recusa a tarefa.

## Documentos

- Vários por contrato, cada um com tipo (`contract`, `amendment`, `renewal`, `termination`, `proposal`, `other`), data, descrição e formato.
- **PDF**: anexo imutável (até 20 MB, como os demais anexos). Visualizador embutido somente leitura (paginação e zoom) e download.
- **Markdown**: versionado. Cada salvamento cria uma versão imutável (autor, data, nota opcional); o documento aponta para a atual. Visões: **renderizado** (o mesmo renderizador seguro do chat dos agentes, sem HTML cru), **raw** e **editar** (editor com prévia lado a lado). Histórico com comparação entre duas versões (diff) e **restaurar** (cria uma versão nova com o conteúdo antigo; nada é apagado).
- Origens do markdown: **upload de .md** (UTF-8, até 1 MB, vira a versão 1), **novo em branco** no editor e **gerado do PDF por IA** (o agente dos fluxos converte um PDF do contrato; a versão 1 fica com autor = agente e aponta para o PDF de origem).
- Excluir documento: só arquiva (some da lista, fica no histórico), como o resto do sistema.

## IA

- Ao subir o PDF do contrato, `POST /api/contracts/document` pede ao agente dos fluxos ([011](011-agentes-de-ia.md)) uma leitura que sugere: contraparte (CNPJ/CPF → entidade cadastrada, ou dados para cadastrar), direção em relação ao titular da caixa, objeto, número, início, duração, valor total ou por parcela, periodicidade, dia de vencimento, renovação automática, aviso prévio, índice e data-base de reajuste e multa rescisória. O usuário revisa o formulário antes de salvar; nada é gravado pela leitura. Sem agente, 501 e cadastro manual.
- A conversão PDF → markdown usa o mesmo agente e espera até `AI_DOCUMENT_TIMEOUT_MS`.
- Tools de contrato para os agentes ficam fora desta etapa.

## Espelho

- Se a contraparte é titular de uma caixa, as parcelas espelham como qualquer título ([006](006-espelhamento-entre-caixas.md)): o lado oposto na caixa dela, com aceite pendente quando falta permissão.
- O contrato pertence à caixa que o cadastrou. Quem lê a caixa da contraparte vê o contrato e os documentos pelo título espelhado (somente leitura); editar, aditar, renovar e rescindir é de quem escreve na caixa dona. Aditivo e rescisão atualizam os dois lados do espelho na mesma transação.

## Avisos

Novos eventos no sino e nas assinaturas de mensagens ([013](013-mensagens-telegram.md)), com parâmetros e `dedup_key` por contrato e ciclo:

- **Aviso prévio** (`contract_notice_deadline`): D-N antes do último dia para pedir a não renovação ou a rescisão (fim − aviso prévio).
- **Fim da vigência** (`contract_ending`): D-N antes do fim do ciclo.
- **Renovação pendente** (`contract_renewal_pending`): ao abrir a tarefa e a cada N dias enquanto ela estiver aberta (inclusive vencida).
- **Reajuste** (`contract_readjustment`): na data-base.
- **Parcelas**: os avisos de vencimento e atraso que já existem passam a mostrar o contrato (nome e n/N).

## Visões

- **Lista** `/contracts`: filtros por caixa, entidade, direção, status e "vence/renova em X dias"; colunas com contraparte, vigência atual, valor do ciclo, próxima parcela e status; exporta CSV/PDF.
- **Detalhe do contrato**: cabeçalho, ciclos (atual e anteriores), parcelas de cada ciclo com status, documentos, aditivos, tarefa de renovação e **realizado × contratado** (previsto no ciclo, pago/recebido, em aberto, em atraso).
- **Painel de recorrentes**: receita e despesa contratadas por mês nos próximos 12 meses e o líquido; contratos a renovar em 90 dias; renovações pendentes e vencidas.
- **Aba Contratos na entidade**: os contratos com aquela empresa ou pessoa, nas caixas que o usuário lê.

## Fora do escopo agora

- Busca automática de índices de reajuste, assinatura eletrônica, modelos de contrato com campos, rateio da parcela por várias categorias e tools de agente.

## Decisões da implementação (F5)

- **Ativar** muda o status e gera as parcelas na mesma transação; em seguida aplica o calendário: um contrato com o ciclo já terminado vira **encerrado** (ou **renovação pendente**, se renova automaticamente), e um dentro da antecedência já abre a tarefa. Parcela em mês fechado (em qualquer das duas caixas) impede a ativação e a renovação, com a mensagem do mês.
- **Ciclo atual** na tela: o último que já começou (antes do início, o primeiro). Avisos, tarefa e "termina em" usam o último ciclo cadastrado.
- **Aditivo**: a data de efeito precisa cair dentro de um ciclo; atinge as parcelas desse ciclo e dos seguintes com competência ≥ efeito. O total do ciclo passa a ser a soma das parcelas não canceladas. A categoria nova vale para as parcelas atingidas e para o contrato (as próximas renovações).
- **Rescisão**: a data vai do início do contrato até o fim do último ciclo. A parcela cujo período contém a data recebe o proporcional sugerido pelos dias cobertos (editável). A multa é um título do contrato sem ciclo, em qualquer direção, espelhado como as parcelas. A tarefa aberta é recusada junto.
- **Não renovar** antes de a tarefa abrir registra a recusa do ciclo (a tarefa nasce recusada), e o worker não abre outra. Encerrado pode ser renovado ("Renovar" na tela); rescindido é final.
- **Worker** (no laço das séries): abre as tarefas e encerra os vencidos, contrato por contrato, como ator `system`; nunca gera parcelas. Os avisos do sino saem no horário `NOTIFY_AT` para os membros da caixa do contrato e os admins (aviso prévio D-15/7/1/0, fim D-30/7/0, renovação pendente no dia em que abre e a cada `reminder_every_days`, reajuste na data-base).
- **Documentos**: PDF fica como anexo (visualizador com pdf.js carregado sob demanda: página, zoom e download); markdown com as visões renderizado (o renderizador seguro do chat), raw, editar (editor e prévia lado a lado) e versões (comparar duas com diff por linhas e restaurar). O PDF → markdown cria um documento novo com `source_document_id` = o PDF e a versão 1 com autor `agent`.
- **Rotas**: `GET/POST /api/contracts`, `GET /api/contracts/panel`, `POST /api/contracts/document` (leitura por IA), `GET/PATCH/DELETE /api/contracts/:id`, `POST /api/contracts/:id/{restore,activate,amendments,terminate,renew,decline-renewal}` (aditivo, rescisão e renovação aceitam `?dryRun=1` para a prévia), `POST /api/contracts/:id/documents` (upload cru de PDF ou .md) e `/documents/markdown`, `GET/PATCH/DELETE /api/contract-documents/:id`, `POST …/restore`, `POST …/convert`, `GET/POST …/versions`, `GET …/versions/:v` e `POST …/versions/:v/restore`.
- **Backup** ([019](019-backup-e-restauracao.md)): as tabelas de contratos entram no JSON completo; contrato, ciclos, tarefas, documentos, versões e parcelas importam juntos (checagens no COMMIT).

```
Caixa "Minha Empresa"
 Contrato "Suporte mensal ACME"   recebo · ACME Ltda CNPJ …
 categoria: Receita de serviços
 ciclo 1: 01/03/2025 – 28/02/2026 · 12 meses · mensal
 valor do ciclo: 60.000,01 → 1ª 5.000,01 · 2ª–12ª 5.000,00
 vence dia 10 do mês seguinte · renova automaticamente · aviso prévio 30 dias

 Parcelas
  03/2025  vence 10/04/2025  5.000,01  recebida
  …
  02/2026  vence 10/03/2026  5.000,00  em aberto

 01/01/2026  tarefa de renovação aberta (60 dias antes do fim)
             [Renovar: 12 meses, reajuste 4,5% → 62.700,01]  [Não renovar]

 Documentos
  contrato-acme.pdf         contrato   01/03/2025   PDF
  contrato-acme.md          contrato   v3 · editado em 12/06/2025
  aditivo-01.pdf            aditivo    efeito 01/08/2025
```
