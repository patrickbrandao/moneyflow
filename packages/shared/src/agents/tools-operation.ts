import { z } from 'zod';
import { CONTRACT_DOCUMENT_KINDS } from '../contracts';
import {
  ACCOUNT_KINDS,
  ATTACHMENT_TARGETS,
  accountCreateInput,
  accountUpdateInput,
  adjustmentInput,
  CHARGE_KINDS,
  CONTRACT_LIST_STATUSES,
  caixaCreateInput,
  caixaUpdateInput,
  cardChargeInput,
  cardRefundInput,
  categoryCreateInput,
  categoryUpdateInput,
  classificationRuleInput,
  classificationRuleUpdateInput,
  contractAmendmentInput,
  contractCreateFields,
  contractRenewalInput,
  contractTerminationInput,
  contractUpdateInput,
  contractVersionCreateInput,
  csvMappingInput,
  durationFitsPeriod,
  id,
  invoiceCloseInput,
  isoDate,
  nonNegativeCents,
  optionalText,
  positiveCents,
  SCOPES,
} from '../schemas';
import { attachmentId, date, define, limit } from './tool-def';

/*
 * Tools de controle total, lote F13a (spec 027): Contratos, Importação (a
 * partir de anexo da sessão), Cartão de crédito, Caixas e contas, Títulos e
 * baixas, e Categorias e regras. Mesmos schemas e serviços da API; escritas
 * com prévia; as só de administrador (`adminOnly`) espelham o assertAdmin do
 * serviço; `destructive` nas que apagam ou desfazem algo.
 */

const CONTRACT_DIRECTIONS = ['receivable', 'payable'] as const;

/** Cadastro do contrato pelo agente: sempre rascunho (ativar é activate_contract). */
const contractCreateTool = contractCreateFields.omit({ activate: true }).superRefine(durationFitsPeriod);

/** Mapeamento CSV informado pelo agente: o da API, sem o alvo (vem da importação). */
const csvMappingTool = csvMappingInput
  .omit({ financialAccountId: true, cardCaixaId: true })
  .describe('Mapeamento das colunas do CSV; é salvo na conta/cartão com este nome e usado na importação.');

const chargeLine = z.object({
  chargeKind: z.enum(CHARGE_KINDS),
  amountCents: positiveCents,
  categoryId: id,
  description: optionalText(300),
});

export const OPERATION_TOOLS = [
  /* ---------------- Contratos (spec 020) ---------------- */
  define({
    name: 'list_contracts',
    category: 'contracts',
    title: 'Listar contratos',
    description:
      'Contratos a receber e a pagar das caixas que o usuário vê, com o ciclo atual, a próxima parcela e a tarefa de renovação aberta. Filtros: caixa, entidade, direção, status (current = vigente ou com renovação pendente), término ou renovação nos próximos N dias e texto.',
    kind: 'read',
    input: z.object({
      caixaId: id.optional(),
      entityId: id.optional(),
      direction: z.enum(CONTRACT_DIRECTIONS).optional().describe('receivable = eu recebo; payable = eu pago.'),
      status: z.enum(CONTRACT_LIST_STATUSES).optional(),
      withinDays: z.number().int().min(0).max(3650).optional().describe('Termina ou tem renovação nos próximos N dias.'),
      q: z.string().trim().max(200).optional(),
      archived: z.boolean().default(false).describe('true = só os arquivados.'),
      limit: limit(500, 100),
    }),
  }),
  define({
    name: 'get_contract',
    category: 'contracts',
    title: 'Ver contrato',
    description:
      'Detalhe de um contrato: condições, ciclos com as parcelas (títulos), títulos extras (multa), documentos (PDF e markdown), aditivos e tarefas de renovação.',
    kind: 'read',
    input: z.object({ contractId: id }),
  }),
  define({
    name: 'create_contract',
    category: 'contracts',
    title: 'Criar contrato',
    description:
      'Cadastra um contrato em RASCUNHO (nenhuma parcela é gerada; use activate_contract). Ciclo: início, duração em meses (múltiplo da periodicidade), valor total do ciclo, periodicidade, dia de vencimento e deslocamento em meses. Espelho: omitido = caixa principal da entidade; null = sem espelho.',
    kind: 'write',
    input: contractCreateTool,
  }),
  define({
    name: 'update_contract',
    category: 'contracts',
    title: 'Editar contrato',
    description:
      'Altera um contrato. No rascunho muda tudo; vigente, só a configuração livre (nome, número, observações, renovação automática, aviso prévio, reajuste, multa) — valores e datas mudam por add_contract_amendment.',
    kind: 'write',
    input: z.object({ contractId: id, changes: contractUpdateInput }),
  }),
  define({
    name: 'activate_contract',
    category: 'contracts',
    title: 'Ativar contrato',
    description: 'Ativa um contrato em rascunho: gera os títulos das parcelas do ciclo (com o espelho, se houver).',
    kind: 'write',
    input: z.object({ contractId: id }),
  }),
  define({
    name: 'add_contract_amendment',
    category: 'contracts',
    title: 'Registrar aditivo',
    description:
      'Aditivo a partir da data de efeito: novo valor da parcela (installmentCents) OU novo total restante (remainingTotalCents), dia de vencimento, deslocamento ou categoria. Recalcula as parcelas em aberto a partir da data (as pagas e as de mês fechado ficam).',
    kind: 'write',
    input: z.object({ contractId: id, amendment: contractAmendmentInput }),
  }),
  define({
    name: 'terminate_contract',
    category: 'contracts',
    title: 'Rescindir contrato',
    description:
      'Rescinde o contrato na data: cancela as parcelas em aberto depois dela, ajusta (opcional) a parcela que cobre a data e lança (opcional) o título da multa.',
    kind: 'write',
    destructive: true,
    input: z.object({ contractId: id, termination: contractTerminationInput }),
  }),
  define({
    name: 'decide_contract_renewal',
    category: 'contracts',
    title: 'Decidir renovação',
    description:
      'Aprova (decision approve, com o próximo ciclo em renewal: duração, periodicidade, valor total, reajuste, vencimento) ou recusa (decline, com notes) a renovação do contrato. Aprovar gera as parcelas do novo ciclo.',
    kind: 'write',
    input: z
      .object({
        contractId: id,
        decision: z.enum(['approve', 'decline']),
        renewal: contractRenewalInput.optional().describe('Próximo ciclo (obrigatório para aprovar).'),
        notes: optionalText(2000),
      })
      .refine((v) => v.decision === 'decline' || v.renewal !== undefined, {
        path: ['renewal'],
        message: 'Informe o próximo ciclo (renewal) para aprovar.',
      }),
  }),
  define({
    name: 'get_contract_document',
    category: 'contracts',
    title: 'Ler documento do contrato',
    description:
      'Um documento do contrato (ids em get_contract): os dados, as versões e, no markdown, o conteúdo da versão atual ou da versão pedida. PDF: só os dados (para o texto, convert_contract_pdf).',
    kind: 'read',
    input: z.object({ documentId: id, versionId: id.optional().describe('Versão do markdown; omitida = a atual.') }),
  }),
  define({
    name: 'save_contract_markdown',
    category: 'contracts',
    title: 'Salvar markdown do contrato',
    description:
      'Grava o markdown de um contrato: com documentId, uma versão nova do documento markdown; com contractId, um documento markdown novo (versão 1, com title). Nada é apagado: as versões anteriores ficam.',
    kind: 'write',
    input: z
      .object({
        documentId: id.optional().describe('Documento markdown existente (nova versão).'),
        contractId: id.optional().describe('Contrato (documento novo).'),
        title: z.string().trim().min(1).max(200).optional().describe('Título do documento novo.'),
        kind: z.enum(CONTRACT_DOCUMENT_KINDS).default('contract').describe('Tipo do documento novo.'),
        content: contractVersionCreateInput.shape.content,
        note: optionalText(500),
      })
      .refine((v) => (v.documentId ? 1 : 0) + (v.contractId ? 1 : 0) === 1, {
        path: ['documentId'],
        message: 'Informe documentId (nova versão) ou contractId (documento novo).',
      })
      .refine((v) => !v.contractId || v.title, { path: ['title'], message: 'Informe o título do documento novo.' }),
  }),
  define({
    name: 'convert_contract_pdf',
    category: 'contracts',
    title: 'Converter PDF em markdown',
    description:
      'Converte um documento PDF do contrato em markdown pela IA (agente dos fluxos): cria um documento markdown novo (versão 1) ligado ao PDF. Pode levar até alguns minutos.',
    kind: 'write',
    input: z.object({ documentId: id.describe('Documento PDF do contrato.') }),
  }),

  /* ---------------- Importação (a partir de anexo) ---------------- */
  define({
    name: 'import_statement',
    category: 'imports',
    title: 'Importar extrato',
    description:
      'Importa um extrato OFX ou CSV anexado na sessão para uma conta (accountId) ou para a fatura de um cartão (cardCaixaId). CSV: mappingId (salvo; omitido = o padrão da conta) ou csvMapping (informado, é salvo). Linhas repetidas são puladas; as novas passam pelas regras e pelo casamento automático. Devolve o lote com as linhas (use depois as tools de conciliação).',
    kind: 'write',
    input: z
      .object({
        attachmentId,
        accountId: id.optional().describe('Conta corrente ou poupança.'),
        cardCaixaId: id.optional().describe('Caixa do cartão (extrato da fatura).'),
        cardInvoiceId: id.optional().describe('Fatura do cartão a que o extrato se refere (opcional).'),
        mappingId: id.optional(),
        csvMapping: csvMappingTool.optional(),
        bankBalanceCents: z.number().int().safe().optional().describe('Saldo do banco informado (centavos), com bankBalanceOn.'),
        bankBalanceOn: isoDate.optional(),
        ofxStatement: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'OFX com extratos de várias contas (ex.: corrente e poupança juntas): a posição (1, 2, …) do extrato a importar. Omitida = o que casa com a conta de destino; sem casamento, o erro lista as contas do arquivo.',
          ),
      })
      .refine((v) => (v.accountId ? 1 : 0) + (v.cardCaixaId ? 1 : 0) === 1, {
        path: ['accountId'],
        message: 'Informe accountId ou cardCaixaId.',
      })
      .refine((v) => !(v.mappingId && v.csvMapping), { path: ['csvMapping'], message: 'Use mappingId ou csvMapping, não os dois.' })
      .refine((v) => (v.bankBalanceCents === undefined) === (v.bankBalanceOn === undefined), {
        path: ['bankBalanceOn'],
        message: 'Saldo e data do saldo vão juntos.',
      }),
  }),
  define({
    name: 'import_nfe',
    category: 'imports',
    title: 'Importar NF-e',
    description:
      'Importa o XML de uma NF-e anexado na sessão: o emitente vira entidade (se não existir), a nota e os itens são gravados com o XML. Devolve o título sugerido (entidade, valor, vencimentos das duplicatas e nfeDocumentId): crie o título com create_title passando nfeDocumentId.',
    kind: 'write',
    input: z.object({ attachmentId }),
  }),
  define({
    name: 'read_document',
    category: 'imports',
    title: 'Ler documento',
    description:
      'Lê um boleto, nota ou comprovante (PDF ou imagem) anexado na sessão pela IA (agente dos fluxos) e devolve os dados do título (tipo, beneficiário, documento, valor, vencimento, linha digitável, PIX), sem gravar nada.',
    kind: 'read',
    input: z.object({ attachmentId }),
  }),
  define({
    name: 'parse_payment_code',
    category: 'imports',
    title: 'Ler linha digitável ou PIX',
    description:
      'Interpreta uma linha digitável/código de barras de boleto ou um PIX copia-e-cola: valor, vencimento, banco ou chave PIX, recebedor (e a entidade cadastrada com a chave, se houver). Não grava nada.',
    kind: 'read',
    input: z.object({ code: z.string().trim().min(1).max(512).describe('Linha digitável, código de barras ou PIX copia-e-cola.') }),
  }),
  define({
    name: 'attach_file',
    category: 'imports',
    title: 'Anexar arquivo a um registro',
    description:
      'Liga um anexo da sessão a um título, baixa, movimento, compra de cartão ou entidade; em contract, vira um documento do contrato (PDF, ou markdown a partir de um .md).',
    kind: 'write',
    input: z.object({
      attachmentId,
      target: z.enum([...ATTACHMENT_TARGETS, 'contract']),
      targetId: id,
      title: z.string().trim().max(200).optional().describe('Contrato: título do documento (omitido = nome do arquivo).'),
      kind: z.enum(CONTRACT_DOCUMENT_KINDS).default('contract').describe('Contrato: tipo do documento.'),
    }),
  }),

  /* ---------------- Cartão de crédito (spec 007) ---------------- */
  define({
    name: 'close_invoice',
    category: 'cards',
    title: 'Fechar fatura',
    description:
      'Fecha a fatura do cartão: cada caixa pagadora recebe o título "a pagar" do total dela (espelhado no cartão; sem permissão na pagadora, aguarda aceite). Categorias omitidas = escolhidas automaticamente.',
    kind: 'write',
    input: z.object({ invoiceId: id, ...invoiceCloseInput.shape }),
  }),
  define({
    name: 'pay_invoice',
    category: 'cards',
    title: 'Pagar fatura',
    description:
      'Paga a fatura por uma caixa pagadora. Fatura fechada: total (valor = aberto) ou parcial (o resto rola para a próxima, com os encargos em charges; 0 = nada pago). Fatura aberta: pagamento antecipado (valor > 0 e conta obrigatórios). sourceAccountId = conta de outra caixa que paga de fato.',
    kind: 'write',
    input: z.object({
      invoiceId: id,
      payerCaixaId: id,
      settledOn: date,
      amountCents: nonNegativeCents,
      financialAccountId: id.nullish().describe('Conta da pagadora; null = conta a definir (só fatura fechada).'),
      sourceAccountId: id.nullish(),
      charges: z.array(chargeLine).max(10).default([]).describe('Encargos do emissor no pagamento parcial (juros, IOF, multa).'),
      categoryId: id.nullish().describe('Pagamento antecipado: categoria do título da pagadora (omitida = automática).'),
      notes: optionalText(),
    }),
  }),
  define({
    name: 'reopen_invoice',
    category: 'cards',
    title: 'Reabrir fatura',
    description: 'Reabre uma fatura fechada sem pagamentos: os títulos da fatura nas pagadoras e no cartão são desfeitos.',
    kind: 'write',
    destructive: true,
    input: z.object({ invoiceId: id }),
  }),
  define({
    name: 'create_card_charge',
    category: 'cards',
    title: 'Lançar encargo do cartão',
    description: 'Lança um encargo do emissor (juros, IOF, multa, tarifa) no cartão, na fatura aberta da data; recebedor = o emissor.',
    kind: 'write',
    input: z.object({ cardId: id.describe('Id da caixa do cartão.'), charge: cardChargeInput }),
  }),
  define({
    name: 'refund_card_purchase',
    category: 'cards',
    title: 'Estornar compra do cartão',
    description: 'Lança o estorno (crédito) de uma compra do cartão, total ou parcial, na fatura aberta da data do estorno.',
    kind: 'write',
    input: z.object({ purchaseId: id, refund: cardRefundInput }),
  }),

  /* ---------------- Caixas e contas ---------------- */
  define({
    name: 'create_caixa',
    category: 'caixas',
    title: 'Criar caixa',
    description:
      'Cria uma caixa (livro de um titular). kind credit_card = cartão de crédito, com pagadora padrão, limite, dia de fechamento, dia de vencimento e os 4 últimos dígitos. Quem cria (sem ser admin) vira editor dela.',
    kind: 'write',
    input: caixaCreateInput,
  }),
  define({
    name: 'update_caixa',
    category: 'caixas',
    title: 'Editar caixa',
    description: 'Altera nome, descrição, titular (sem títulos ligados), principal e, no cartão, pagadora padrão, limite, dias e dígitos.',
    kind: 'write',
    input: z.object({ caixaId: id, changes: caixaUpdateInput }),
  }),
  define({
    name: 'archive_caixa',
    category: 'caixas',
    title: 'Arquivar caixa',
    description: 'Arquiva uma caixa (com lançamentos, contas ou fechamentos); sem nenhum uso, ela é excluída. Só administrador.',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ caixaId: id }),
  }),
  define({
    name: 'create_account',
    category: 'caixas',
    title: 'Criar conta financeira',
    description: `Cria uma conta financeira na caixa (${ACCOUNT_KINDS.join(', ')}: corrente, cofre, poupança/investimento), com saldo e data de abertura.`,
    kind: 'write',
    input: z.object({ caixaId: id, account: accountCreateInput }),
  }),
  define({
    name: 'update_account',
    category: 'caixas',
    title: 'Editar conta financeira',
    description: 'Altera nome, dados bancários, saldo ou data de abertura de uma conta financeira.',
    kind: 'write',
    input: z.object({ accountId: id, changes: accountUpdateInput }),
  }),
  define({
    name: 'archive_account',
    category: 'caixas',
    title: 'Arquivar conta financeira',
    description: 'Arquiva uma conta financeira com movimentos; sem nenhum uso, ela é excluída.',
    kind: 'write',
    destructive: true,
    input: z.object({ accountId: id }),
  }),
  define({
    name: 'create_adjustment',
    category: 'caixas',
    title: 'Lançar movimento avulso',
    description:
      'Lança um movimento avulso numa conta (ajuste de saldo, rendimento, tarifa): valor positivo entra, negativo sai; categoria e entidade opcionais.',
    kind: 'write',
    input: z.object({ accountId: id, adjustment: adjustmentInput }),
  }),

  /* ---------------- Títulos e baixas ---------------- */
  define({
    name: 'cancel_title',
    category: 'titles',
    title: 'Cancelar título',
    description: 'Cancela um título (e o espelho): sai dos valores em aberto, sem apagar. Baixas existentes continuam.',
    kind: 'write',
    input: z.object({ titleId: id }),
  }),
  define({
    name: 'archive_title',
    category: 'titles',
    title: 'Arquivar título',
    description: 'Arquiva um título (e o espelho): some das listas e relatórios, sem apagar nem cancelar. Título de fatura de cartão não.',
    kind: 'write',
    input: z.object({ titleId: id }),
  }),
  define({
    name: 'delete_title',
    category: 'titles',
    title: 'Excluir título',
    description:
      'Exclui um título e o espelho (com baixas, mesmo estornadas, ele é arquivado). Em série: scope this arquiva só esta ocorrência; following encerra a série a partir dela.',
    kind: 'write',
    destructive: true,
    input: z.object({ titleId: id, scope: z.enum(SCOPES).default('this') }),
  }),
  define({
    name: 'accept_mirror',
    category: 'titles',
    title: 'Aceitar espelho',
    description: 'Aceita o título espelho pendente (ou contestado) na caixa do usuário, com a categoria opcional deste lado.',
    kind: 'write',
    input: z.object({ titleId: id, categoryId: id.optional() }),
  }),
  define({
    name: 'dispute_mirror',
    category: 'titles',
    title: 'Contestar espelho',
    description: 'Contesta o título espelho (o motivo fica nas observações).',
    kind: 'write',
    input: z.object({ titleId: id, reason: optionalText(500) }),
  }),
  define({
    name: 'delete_transfer',
    category: 'caixas',
    title: 'Excluir transferência',
    description:
      'Exclui uma transferência entre contas (os dois movimentos vão junto). A transferência gerada por uma baixa sai pelo estorno da baixa (reverse_settlement); movimento conciliado precisa da conciliação desfeita antes.',
    kind: 'write',
    destructive: true,
    input: z.object({ transferId: id }),
  }),

  /* ---------------- Categorias e regras ---------------- */
  define({
    name: 'create_category',
    category: 'categories',
    title: 'Criar categoria',
    description: 'Cria uma categoria do plano global (receita ou despesa; grupo ou subcategoria com parentId). Só administrador.',
    kind: 'write',
    adminOnly: true,
    input: categoryCreateInput,
  }),
  define({
    name: 'update_category',
    category: 'categories',
    title: 'Editar categoria',
    description: 'Altera nome, grupo (parentId), cor (colorSlot 1–12) ou ícone de uma categoria. Só administrador.',
    kind: 'write',
    adminOnly: true,
    input: z.object({ categoryId: id, changes: categoryUpdateInput }),
  }),
  define({
    name: 'archive_category',
    category: 'categories',
    title: 'Arquivar categoria',
    description: 'Arquiva uma categoria em uso (arquivar o grupo arquiva as subcategorias); sem uso, ela é excluída. Só administrador.',
    kind: 'write',
    destructive: true,
    adminOnly: true,
    input: z.object({ categoryId: id }),
  }),
  define({
    name: 'list_classification_rules',
    category: 'categories',
    title: 'Listar regras de classificação',
    description:
      'Regras que classificam as linhas do extrato (padrão da descrição → entidade/categoria), globais e das caixas que o usuário vê, por prioridade.',
    kind: 'read',
    input: z.object({ caixaId: id.optional(), archived: z.boolean().default(false).describe('true = só as arquivadas.') }),
  }),
  define({
    name: 'create_classification_rule',
    category: 'categories',
    title: 'Criar regra de classificação',
    description:
      'Cria uma regra: padrão (contains, starts_with, exact ou regex) da descrição → entidade e/ou categoria (categoria exige a direção in/out). caixaId omitido = regra global (só administrador).',
    kind: 'write',
    input: classificationRuleInput,
  }),
  define({
    name: 'update_classification_rule',
    category: 'categories',
    title: 'Editar regra de classificação',
    description: 'Altera padrão, tipo, direção, entidade, categoria ou prioridade de uma regra.',
    kind: 'write',
    input: z.object({ ruleId: id, changes: classificationRuleUpdateInput }),
  }),
  define({
    name: 'archive_classification_rule',
    category: 'categories',
    title: 'Arquivar regra de classificação',
    description: 'Arquiva uma regra: deixa de classificar as linhas novas (as já classificadas guardam o histórico).',
    kind: 'write',
    input: z.object({ ruleId: id }),
  }),
] as const;
