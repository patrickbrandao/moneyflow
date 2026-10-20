# 032 — Regras de classificação por conta (F18)

As regras de classificação ([009](009-extratos-e-conciliacao.md)) deixam de ser da caixa ou globais e passam a ser **de uma conta**: cada conta que recebe extrato tem as suas, e uma regra só classifica as linhas dos extratos dessa conta. Duas contas da mesma caixa (a corrente e a poupança, por exemplo) não compartilham regra nenhuma. Os agentes de IA leem as regras de todas as contas que o usuário vê para decidir se vale copiar uma regra de outra conta para a conta em que estão trabalhando.

Decisões do usuário (2026-10-20): as regras de caixa já existentes são copiadas para cada conta da caixa; as globais deixam de existir, copiadas para todas as contas; copiar regras entre contas existe nos agentes (tool com prévia) e na tela.

## O que é "conta" aqui

- **Conta financeira** `checking` ou `savings` (as que importam extrato; o cofre `cash` não importa e não tem regra).
- **Cartão de crédito**: a caixa do cartão ([007](007-cartao-de-credito.md)) é a "conta" das regras da fatura importada. Cada cartão tem as suas.

Toda regra tem exatamente um alvo: a conta ou o cartão. Não existe mais regra global nem regra da caixa inteira.

## Regras

- **Escolha da regra**: para uma linha, só as regras ativas da conta (ou do cartão) da linha, na ordem de sempre: menor prioridade, `exact` > `starts_with` > `contains` > `regex`, padrão mais longo.
- **Unicidade**: o mesmo tipo + padrão (sem distinção de maiúsculas) + direção não se repete entre as regras ativas de uma conta. Contas diferentes podem ter a mesma regra.
- **Permissão**: ler a regra = ler a caixa da conta; criar, editar, arquivar, aplicar e copiar para a conta = escrever na caixa dela. O admin global vê e edita todas, como no resto (`Access`).
- **Aprendida da correção**: a regra que nasce da correção do usuário (`learnRule`) vai para a conta (ou cartão) da linha corrigida.
- **Sugerida pelo agente** (receitas e conciliação com IA, [029](029-fluxos-autonomos.md)/[030](030-receitas-de-conciliacao.md)): `create_classification_rule` cria na conta do lote.
- **Aplicar regras** ([009](009-extratos-e-conciliacao.md)): na guia Regras, às linhas `nova` de todos os lotes da conta escolhida; no detalhe do lote, às daquele lote, com as regras da conta dele. O resto do comportamento não muda (só linhas sem classificação ou classificadas por regra; contagem de uso).
- **Conta arquivada**: as regras ficam como estão (históricas); a conta arquivada não importa extrato novo.

## Copiar regras de outra conta

- Copia regras escolhidas de uma conta (ou cartão) de **origem**, de qualquer caixa que o usuário lê, para uma conta (ou cartão) de **destino**, onde ele escreve. Contas de tipos diferentes (corrente → cartão, por exemplo) podem trocar regras.
- A cópia é uma regra nova do destino, com o mesmo tipo, padrão, direção, entidade, categoria e prioridade, origem `copy`, contador de uso zerado e o vínculo com a regra de origem (`copied_from_rule_id`, só informativo; editar ou arquivar uma não mexe na outra).
- **Já existe**: a regra cujo tipo + padrão + direção já está ativa no destino é pulada e volta em `skipped` com o motivo (`exists`, com a regra do destino); as demais entram numa transação só. Copiar não reaplica as regras: o usuário usa "Aplicar regras" depois (a resposta lembra disso).
- Regras arquivadas não são copiadas: voltam em `skipped` com o motivo `archived`. Duas regras de origem iguais (tipo + padrão + direção) na mesma cópia: entra a primeira, a outra volta como `exists` (sem `existingRuleId`).

## Agentes

- `list_classification_rules`: lista as regras de **todas as contas e cartões que o usuário lê**, cada uma com a conta (ou cartão), a caixa e o contador de uso; filtros opcionais `accountId`, `cardCaixaId`, `caixaId` (todas as contas da caixa) e `archived`. A descrição diz para usar a lista para ver se uma regra de outra conta serve na conta atual e, servindo, propor a cópia.
- `create_classification_rule`: exige `accountId` ou `cardCaixaId` (um só); sem `caixaId` e sem regra global.
- `copy_classification_rules` (nova, escrita, categoria `categories`): `ruleIds` (as regras de origem, de uma ou mais contas) e o destino (`accountId` ou `cardCaixaId`). A prévia lista o que entra e o que é pulado (já existe), com conta de origem, padrão, entidade e categoria. Como toda tool nova, não entra sozinha em kit nenhum ([021](021-kit-de-ferramentas.md)); o seed de desenvolvimento a põe em `ask` onde já estão as de regra.
- O bloco do prompt da conciliação com IA e das receitas que hoje pede para propor `create_classification_rule` passa a dizer também: antes de criar, consulte as regras das outras contas; se uma já resolve, proponha copiá-la.

## Tela

- **Guia Regras da caixa**: escolhe a conta (as `checking`/`savings` ativas da caixa; numa caixa de cartão, o próprio cartão, sem seletor, na aba **Regras de classificação** do cartão, ao lado de Importar fatura), lembrando a última no navegador (`moneyflow:rules-account`, por caixa) e no endereço (`account`). A lista, "Nova regra" e "Aplicar regras" valem para a conta escolhida. Caixa sem conta de extrato mostra o aviso "Esta caixa não tem conta que importe extrato".
- **Tela da conta** ([004](004-caixas-e-contas.md)): ganha a aba **Regras**, a mesma lista presa na conta.
- **Copiar regras de outra conta**: botão na guia Regras (com escrita). O modal escolhe a conta de origem (todas as legíveis, agrupadas por caixa, cartões inclusive), lista as regras ativas dela com caixas de seleção, marca as que já existem no destino (desabilitadas) e copia as marcadas, mostrando quantas entraram e quantas foram puladas.

## Banco (dba)

- `classification_rules`: `caixa_id` passa a `NOT NULL` (sem regra global); `financial_account_id` (FK para `financial_accounts`, `ON DELETE CASCADE`) obrigatório quando a caixa não é de cartão e nulo quando é; a conta é `checking`/`savings` e da mesma caixa (conferido também se a conta mudar de caixa). `origin` aceita `copy`; `copied_from_rule_id` (FK para a própria tabela, `ON DELETE SET NULL`), só com `origin = 'copy'`.
- Unicidade das ativas por (caixa, conta, tipo, `lower(padrão)`, direção), com `NULLS NOT DISTINCT` (o cartão tem conta nula).
- `classification_rule_for` recebe o alvo da linha (conta ou cartão, exatamente um) e só olha as regras dele; a versão por caixa sai.
- **Migração dos dados** (numa transação, sem perder o histórico das linhas):
  - regra de caixa de cartão: fica como está (alvo = o cartão);
  - regra de outra caixa: uma cópia em cada conta `checking`/`savings` ativa da caixa e em cada conta (mesmo arquivada) com linha classificada por ela; a linha original fica com uma dessas contas e as cópias são linhas novas;
  - regra global: o mesmo, em todas as contas `checking`/`savings` ativas e em todos os cartões ativos de todas as caixas, mais as contas e cartões com linha classificada por ela; depois a global sai;
  - `statement_lines.classification_rule_id` passa para a cópia da conta (ou cartão) da linha; o contador de uso de cada cópia = as linhas dela classificadas pela regra, e `last_used_at` só fica onde o contador > 0;
  - regra (de caixa ou global) que não tem conta para ir e nenhuma linha ligada é removida; arquivadas seguem o mesmo critério e continuam arquivadas;
  - as cópias saem da migração com origem igual à da regra original (não `copy`), porque não foram copiadas pelo usuário.
- O índice de embeddings (`ai_embeddings`, objeto `classification_rule`) das regras removidas cai pela checagem que já existe; as cópias são indexadas pela aplicação no fluxo normal.
- O down volta ao escopo por caixa juntando as cópias iguais da mesma caixa (melhor esforço; as cópias entre caixas diferentes não viram global).
- pgTAP: alvo obrigatório e coerente (conta de outra caixa, cofre, cartão com conta), unicidade por conta, `classification_rule_for` só da conta, `copy` com e sem `copied_from_rule_id` e a migração (caixa com duas contas, global, linhas reapontadas, contadores).

## Aplicação (app)

- Shared: `classificationRuleInput` com `accountId`/`cardCaixaId` (exatamente um) no lugar de `caixaId`; `ruleListQuery` com `accountId`, `cardCaixaId`, `caixaId` e `archived`; `applyRulesInput` com o alvo; `copyRulesInput` (`ruleIds` 1–500 e o destino); `ClassificationRuleRow` com conta (ou cartão), caixa, `copiedFromRuleId`; textos em `i18n/areas/statements.ts`.
- Serviços (`reconciliation.ts`, `statements.ts`): `ruleFor` pelo alvo da linha (importação, aplicar regras, `learnRule`), `listRules` com `Access` pelas caixas legíveis, `createRule`/`updateRule`/`archiveRule` pela caixa da conta, `applyRulesToAccount` no lugar de `applyRulesToCaixa`, `copyRules` (transação única; `skipped` com o motivo). Nada de regra global (o caminho de admin sem caixa sai).
- Rotas: `GET /api/classification-rules?accountId|cardCaixaId|caixaId`, `POST` com o alvo, `POST /api/classification-rules/apply` com o alvo, `POST /api/classification-rules/copy`.
- Tools: as mudanças e a nova da seção Agentes, com prévia, e o handler sobre `copyRules`.
- Backup ([019](019-backup-e-restauracao.md)): arquivo antigo com regra de caixa ou global é convertido na importação pelo mesmo critério da migração (cópia por conta da caixa; global para todas as contas e cartões importados no arquivo ou já existentes). O desempate de unicidade da migração não é refeito: a regra repetida no alvo volta como conflito da importação.
- Embeddings: a busca semântica não indexa regras de classificação (os textos-fonte são entidades, títulos, compras e linhas de extrato), então as regras novas e as cópias não pedem índice; se as regras passarem a ser indexadas, entram pelo fluxo normal.
- Testes de integração (`test/statements.test.ts` e `test/agent-tools.test.ts`): duas contas da mesma caixa classificam diferente a mesma descrição; a correção aprende só na conta da linha; aplicar regras não toca a outra conta; listar regras de outra caixa só se legível; copiar com pulado; permissão negada no destino só leitura; as tools (prévia, execução, `/mcp`). E2E: criar regra na corrente, ver que não aparece na poupança e copiar pelo modal.
