import {
  classificationRuleInput,
  classificationRuleUpdateInput,
  csvMappingInput,
  csvMappingUpdateInput,
  lineClassifyInput,
  lineCreateInput,
  lineIdsInput,
  lineMatchInput,
  ruleListQuery,
  statementImportQuery,
  statementTargetQuery,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import { suggestImportClassifications } from '../services/ai-flows';
import { assertUpload } from '../services/attachments';
import * as rec from '../services/reconciliation';
import * as statements from '../services/statements';
import { UPLOAD_BODY_LIMIT } from './attachments';

/* Extratos e conciliação (spec 009). Upload: o arquivo vai cru no corpo. */
export async function statementRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  app.post('/api/statements/inspect', { bodyLimit: UPLOAD_BODY_LIMIT, config: { rawUpload: true } }, (r: Req) =>
    statements.inspectStatement(r.ctx, assertUpload(r.body)),
  );
  app.get('/api/statement-imports', (r: Req) => statements.listImports(r.ctx, parse(statementTargetQuery, r.query)));
  app.post('/api/statement-imports', { bodyLimit: UPLOAD_BODY_LIMIT, config: { rawUpload: true } }, async (r: Req) => {
    const result = await statements.importStatement(r.ctx, parse(statementImportQuery, r.query), {
      mime: r.headers['content-type'] ?? '',
      content: assertUpload(r.body),
    });
    // Linhas sem regra recebem sugestão do agente dos fluxos (spec 009/011), em segundo plano no worker.
    const aiSuggestion = await suggestImportClassifications(r.ctx, result.id, { auto: true }).catch((error) => {
      r.log.warn({ err: error }, 'conciliação: sugestão do agente não enfileirada');
      return null;
    });
    return { ...result, aiSuggestion };
  });
  app.get('/api/statement-imports/:id', (r: Req) => statements.getImport(r.ctx, id(r)));
  app.delete('/api/statement-imports/:id', (r: Req) => statements.deleteImport(r.ctx, id(r)));
  app.post('/api/statement-imports/:id/rematch', (r: Req) => statements.rematchImport(r.ctx, id(r)));

  app.post('/api/statement-lines/confirm', (r: Req) => rec.confirmLines(r.ctx, parse(lineIdsInput, r.body).lineIds));
  app.get('/api/statement-lines/:id/candidates', (r: Req) => rec.lineCandidates(r.ctx, id(r)));
  app.post('/api/statement-lines/:id/match', (r: Req) => rec.matchLine(r.ctx, id(r), parse(lineMatchInput, r.body)));
  app.post('/api/statement-lines/:id/unmatch', (r: Req) => rec.unmatchLine(r.ctx, id(r)));
  app.post('/api/statement-lines/:id/ignore', (r: Req) => rec.setIgnored(r.ctx, id(r), true));
  app.post('/api/statement-lines/:id/unignore', (r: Req) => rec.setIgnored(r.ctx, id(r), false));
  app.post('/api/statement-lines/:id/create', (r: Req) => rec.createFromLine(r.ctx, id(r), parse(lineCreateInput, r.body)));
  app.patch('/api/statement-lines/:id', (r: Req) => rec.classifyLine(r.ctx, id(r), parse(lineClassifyInput, r.body)));

  app.get('/api/csv-mappings', (r: Req) => rec.listMappings(r.ctx, parse(statementTargetQuery, r.query)));
  app.post('/api/csv-mappings', (r: Req) => rec.createMapping(r.ctx, parse(csvMappingInput, r.body)));
  app.patch('/api/csv-mappings/:id', (r: Req) => rec.updateMapping(r.ctx, id(r), parse(csvMappingUpdateInput, r.body)));
  app.delete('/api/csv-mappings/:id', (r: Req) => rec.deleteMapping(r.ctx, id(r)));

  app.get('/api/classification-rules', (r: Req) => rec.listRules(r.ctx, parse(ruleListQuery, r.query)));
  app.post('/api/classification-rules', (r: Req) => rec.createRule(r.ctx, parse(classificationRuleInput, r.body)));
  app.patch('/api/classification-rules/:id', (r: Req) => rec.updateRule(r.ctx, id(r), parse(classificationRuleUpdateInput, r.body)));
  app.delete('/api/classification-rules/:id', (r: Req) => rec.archiveRule(r.ctx, id(r)));
}
