import {
  contractAmendmentInput,
  contractCreateInput,
  contractDocumentUpdateInput,
  contractDocumentUploadQuery,
  contractLinkSeriesInput,
  contractListQuery,
  contractMarkdownCreateInput,
  contractPanelQuery,
  contractPaymentsQuery,
  contractReadingQuery,
  contractRenewalInput,
  contractTerminationInput,
  contractUpdateInput,
  contractVersionCreateInput,
  dryRunQuery,
  obligationInput,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import * as documents from '../services/contract-documents';
import * as contracts from '../services/contracts';
import { UPLOAD_BODY_LIMIT } from './attachments';

/* Contratos (specs 020 e 034): cadastro, obrigações, ciclo de vida, documentos e leitura por IA. */
export async function contractRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');
  const dryRun = (r: Req) => parse(dryRunQuery, r.query).dryRun;
  const raw = { bodyLimit: UPLOAD_BODY_LIMIT, config: { rawUpload: true } };

  app.get('/api/contracts', (r: Req) => contracts.listContracts(r.ctx, parse(contractListQuery, r.query)));
  app.post('/api/contracts', (r: Req) => contracts.createContract(r.ctx, parse(contractCreateInput, r.body)));
  app.get('/api/contracts/panel', (r: Req) => contracts.recurringPanel(r.ctx, parse(contractPanelQuery, r.query).caixas));
  // Leitura do PDF por IA: sugere os campos; nada é gravado (spec 020).
  app.post('/api/contracts/document', raw, (r: Req) =>
    documents.readContractWithAi(r.ctx, parse(contractReadingQuery, r.query), { content: r.body as Buffer }),
  );
  app.get('/api/contracts/:id', (r: Req) => contracts.getContract(r.ctx, id(r)));
  // Pagamentos das obrigações (specs 033 e 034): baixas repartidas, cobranças no cartão, dias de atraso/adiantamento e o resumo.
  app.get('/api/contracts/:id/payments', (r: Req) =>
    contracts.contractPayments(r.ctx, id(r), parse(contractPaymentsQuery, r.query).cycleId),
  );
  app.patch('/api/contracts/:id', (r: Req) => contracts.updateContract(r.ctx, id(r), parse(contractUpdateInput, r.body)));
  app.delete('/api/contracts/:id', (r: Req) => contracts.deleteContract(r.ctx, id(r)));
  app.post('/api/contracts/:id/restore', (r: Req) => contracts.restoreContract(r.ctx, id(r)));
  app.post('/api/contracts/:id/activate', (r: Req) => contracts.activateContract(r.ctx, id(r)));
  app.post('/api/contracts/:id/obligations', (r: Req) => contracts.addObligation(r.ctx, id(r), parse(obligationInput, r.body)));
  app.post('/api/contracts/:id/obligations/link', (r: Req) =>
    contracts.linkObligation(r.ctx, id(r), parse(contractLinkSeriesInput, r.body).ruleId),
  );
  app.post('/api/contracts/:id/amendments', (r: Req) =>
    contracts.amendContract(r.ctx, id(r), parse(contractAmendmentInput, r.body), dryRun(r)),
  );
  app.post('/api/contracts/:id/terminate', (r: Req) =>
    contracts.terminateContract(r.ctx, id(r), parse(contractTerminationInput, r.body), dryRun(r)),
  );
  app.post('/api/contracts/:id/renew', (r: Req) => contracts.renewContract(r.ctx, id(r), parse(contractRenewalInput, r.body), dryRun(r)));

  // Documentos.
  app.post('/api/contracts/:id/documents', raw, (r: Req) =>
    documents.uploadContractDocument(r.ctx, id(r), parse(contractDocumentUploadQuery, r.query), {
      mime: String(r.headers['content-type'] ?? ''),
      content: r.body as Buffer,
    }),
  );
  app.post('/api/contracts/:id/documents/markdown', (r: Req) =>
    documents.createMarkdownDocument(r.ctx, id(r), parse(contractMarkdownCreateInput, r.body)),
  );
  app.get('/api/contract-documents/:id', (r: Req) => documents.getContractDocument(r.ctx, id(r)));
  app.patch('/api/contract-documents/:id', (r: Req) =>
    documents.updateContractDocument(r.ctx, id(r), parse(contractDocumentUpdateInput, r.body)),
  );
  app.delete('/api/contract-documents/:id', (r: Req) => documents.archiveContractDocument(r.ctx, id(r)));
  app.post('/api/contract-documents/:id/restore', (r: Req) => documents.archiveContractDocument(r.ctx, id(r), true));
  app.post('/api/contract-documents/:id/convert', (r: Req) => documents.convertPdfToMarkdown(r.ctx, id(r)));
  app.get('/api/contract-documents/:id/versions', (r: Req) => documents.listVersions(r.ctx, id(r)));
  app.post('/api/contract-documents/:id/versions', (r: Req) =>
    documents.saveVersion(r.ctx, id(r), parse(contractVersionCreateInput, r.body)),
  );
  app.get('/api/contract-documents/:id/versions/:versionId', (r: Req) => documents.getVersion(r.ctx, id(r), param(r, 'versionId')));
  app.post('/api/contract-documents/:id/versions/:versionId/restore', (r: Req) =>
    documents.restoreVersion(r.ctx, id(r), param(r, 'versionId')),
  );
}
