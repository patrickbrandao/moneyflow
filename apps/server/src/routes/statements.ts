import {
  applyRulesInput,
  classificationRuleInput,
  classificationRuleUpdateInput,
  copyRulesInput,
  csvMappingInput,
  csvMappingUpdateInput,
  importBankBalanceInput,
  importProvisionalInput,
  importRenameInput,
  importSupersedeInput,
  lineCardChargeInput,
  lineClassifyInput,
  lineCreateInput,
  lineIdsInput,
  lineMatchInput,
  lineUnmatchInput,
  reconcileAiAutoInput,
  ruleListQuery,
  statementImportQuery,
  statementInspectQuery,
  statementLineSearchQuery,
  statementTargetQuery,
  supersededLinesQuery,
  supersedeResolveInput,
  supersedeSuggestionsDecisionInput,
  t,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import {
  autoReconcileEnabled,
  reconcileAiState,
  reconcileImportWithAi,
  setReconcileAuto,
  suggestImportClassifications,
} from '../services/ai-flows';
import { assertUpload } from '../services/attachments';
import * as rec from '../services/reconciliation';
import * as supersede from '../services/statement-supersede';
import * as statements from '../services/statements';
import { UPLOAD_BODY_LIMIT } from './attachments';

/* Extratos e conciliação (spec 009). Upload: o arquivo vai cru no corpo. */
export async function statementRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  app.post('/api/statements/inspect', { bodyLimit: UPLOAD_BODY_LIMIT, config: { rawUpload: true } }, (r: Req) =>
    statements.inspectStatement(r.ctx, assertUpload(r.body), parse(statementInspectQuery, r.query)),
  );
  app.get('/api/statement-imports', (r: Req) => statements.listImports(r.ctx, parse(statementTargetQuery, r.query)));
  app.post('/api/statement-imports', { bodyLimit: UPLOAD_BODY_LIMIT, config: { rawUpload: true } }, async (r: Req) => {
    const result = await statements.importStatement(r.ctx, parse(statementImportQuery, r.query), {
      mime: r.headers['content-type'] ?? '',
      content: assertUpload(r.body),
    });
    // "Conciliar com IA ao importar" ligado na conta/cartão (spec 029): a conciliação completa vai à fila do worker.
    // Desligado: as linhas sem regra recebem sugestão do agente dos fluxos (spec 009/011), em segundo plano.
    const auto = await autoReconcileEnabled(r.ctx, result.id).catch(() => false);
    // Provisório ativo sobreposto sem a troca (spec 031): o agente lançaria de novo o que o provisório já conciliou.
    if (auto && result.provisionalOverlap?.length) {
      const lines = result.lines.filter((l) => l.status === 'new' || l.status === 'suggested').length;
      return {
        ...result,
        aiReconcile: { queued: false, runId: null, conversationId: null, lines, skippedReason: t.statements.supersede.overlapAiSkipped },
      };
    }
    if (auto) {
      const aiReconcile = await reconcileImportWithAi(r.ctx, result.id, { auto: true }).catch((error) => {
        r.log.warn({ err: error }, 'conciliação: conciliação com IA não enfileirada');
        return null;
      });
      return { ...result, aiReconcile };
    }
    const aiSuggestion = await suggestImportClassifications(r.ctx, result.id, { auto: true }).catch((error) => {
      r.log.warn({ err: error }, 'conciliação: sugestão do agente não enfileirada');
      return null;
    });
    return { ...result, aiSuggestion };
  });
  // Conciliação completa com IA (spec 029): estado, "Conciliar com IA" e o interruptor da conta/cartão.
  app.get('/api/statement-imports/:id/reconcile-ai', (r: Req) => reconcileAiState(r.ctx, id(r)));
  app.post('/api/statement-imports/:id/reconcile-ai', (r: Req) => reconcileImportWithAi(r.ctx, id(r)));
  app.put('/api/statement-imports/:id/reconcile-ai/auto', (r: Req) =>
    setReconcileAuto(r.ctx, id(r), parse(reconcileAiAutoInput, r.body).enabled),
  );
  app.get('/api/statement-imports/:id', (r: Req) => statements.getImport(r.ctx, id(r)));
  // Lote provisório e a troca pelo consolidado (spec 031).
  app.put('/api/statement-imports/:id/provisional', (r: Req) =>
    supersede.setProvisional(r.ctx, id(r), parse(importProvisionalInput, r.body).provisional),
  );
  app.post('/api/statement-imports/:id/supersede', (r: Req) =>
    supersede.supersedeImports(r.ctx, id(r), parse(importSupersedeInput, r.body ?? {})),
  );
  app.get('/api/statement-imports/:id/superseded-lines', (r: Req) =>
    supersede.listSupersededLines(r.ctx, id(r), parse(supersededLinesQuery, r.query).outcome),
  );
  app.post('/api/statement-imports/:id/superseded-lines/resolve', (r: Req) =>
    supersede.resolveSupersededLines(r.ctx, id(r), parse(supersedeResolveInput, r.body).items),
  );
  app.post('/api/statement-imports/:id/superseded-lines/suggest', (r: Req) => supersede.suggestSupersedePairs(r.ctx, id(r)));
  app.post('/api/statement-imports/:id/superseded-lines/suggestions', (r: Req) => {
    const input = parse(supersedeSuggestionsDecisionInput, r.body);
    return supersede.decideSupersedeSuggestions(r.ctx, id(r), input.lineIds, input.decision);
  });
  app.delete('/api/statement-imports/:id', (r: Req) => statements.deleteImport(r.ctx, id(r)));
  app.post('/api/statement-imports/:id/rematch', (r: Req) => statements.rematchImport(r.ctx, id(r)));
  app.put('/api/statement-imports/:id/bank-balance', (r: Req) =>
    statements.setImportBankBalance(r.ctx, id(r), parse(importBankBalanceInput, r.body)),
  );
  app.put('/api/statement-imports/:id/file-name', (r: Req) => statements.renameImport(r.ctx, id(r), parse(importRenameInput, r.body)));
  app.post('/api/statement-imports/:id/apply-rules', (r: Req) => rec.applyRulesToImport(r.ctx, id(r)));
  app.get('/api/statement-lines', (r: Req) => statements.searchLines(r.ctx, parse(statementLineSearchQuery, r.query)));

  app.post('/api/statement-lines/confirm', (r: Req) => rec.confirmLines(r.ctx, parse(lineIdsInput, r.body).lineIds));
  app.get('/api/statement-lines/:id/candidates', (r: Req) => rec.lineCandidates(r.ctx, id(r)));
  app.post('/api/statement-lines/:id/match', (r: Req) => rec.matchLine(r.ctx, id(r), parse(lineMatchInput, r.body)));
  app.post('/api/statement-lines/:id/unmatch', (r: Req) => rec.unmatchLine(r.ctx, id(r), parse(lineUnmatchInput, r.body ?? {})));
  app.post('/api/statement-lines/:id/ignore', (r: Req) => rec.setIgnored(r.ctx, id(r), true));
  app.post('/api/statement-lines/:id/unignore', (r: Req) => rec.setIgnored(r.ctx, id(r), false));
  app.post('/api/statement-lines/:id/create', (r: Req) => rec.createFromLine(r.ctx, id(r), parse(lineCreateInput, r.body)));
  // Fatura do cartão (spec 034): "Lançar como cobrança de <obrigação> de <mês>".
  app.post('/api/statement-lines/:id/card-charge', (r: Req) => rec.createChargeFromLine(r.ctx, id(r), parse(lineCardChargeInput, r.body)));
  app.patch('/api/statement-lines/:id', (r: Req) => rec.classifyLine(r.ctx, id(r), parse(lineClassifyInput, r.body)));

  app.get('/api/csv-mappings', (r: Req) => rec.listMappings(r.ctx, parse(statementTargetQuery, r.query)));
  app.post('/api/csv-mappings', (r: Req) => rec.createMapping(r.ctx, parse(csvMappingInput, r.body)));
  app.patch('/api/csv-mappings/:id', (r: Req) => rec.updateMapping(r.ctx, id(r), parse(csvMappingUpdateInput, r.body)));
  app.delete('/api/csv-mappings/:id', (r: Req) => rec.deleteMapping(r.ctx, id(r)));

  app.get('/api/classification-rules', (r: Req) => rec.listRules(r.ctx, parse(ruleListQuery, r.query)));
  app.post('/api/classification-rules', (r: Req) => rec.createRule(r.ctx, parse(classificationRuleInput, r.body)));
  app.post('/api/classification-rules/apply', (r: Req) => rec.applyRulesToAccount(r.ctx, parse(applyRulesInput, r.body)));
  app.post('/api/classification-rules/copy', (r: Req) => rec.copyRules(r.ctx, parse(copyRulesInput, r.body)));
  app.patch('/api/classification-rules/:id', (r: Req) => rec.updateRule(r.ctx, id(r), parse(classificationRuleUpdateInput, r.body)));
  app.delete('/api/classification-rules/:id', (r: Req) => rec.archiveRule(r.ctx, id(r)));
}
