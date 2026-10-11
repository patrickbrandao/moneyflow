import { type Executor, entities, entityAddresses, entityPixKeys, nfeDocuments, nfeItems, type Tx } from '@moneyflow/db';
import {
  type DocumentReadingDto,
  isValidCnpj,
  isValidCpf,
  type NfeData,
  type NfeDetail,
  type NfeEntryResult,
  normalizeDocument,
  normalizePixKey,
  type PixEntryResult,
  type PixKeyType,
  parseBrCode,
  parseNfeXml,
  t,
} from '@moneyflow/shared';
import { eq, sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { readDocumentWithAi } from './ai-flows';
import { storeAttachment } from './attachments';
import { withTx } from './tx';
import { camel } from './util';

/*
 * Entrada de títulos (spec 010). Boleto: a linha digitável é convertida no
 * próprio título (normalizeBoleto). PIX copia-e-cola: lê o BR Code e acha (ou
 * cria) o recebedor pela chave. NF-e: o emitente vira entidade, a nota e os
 * itens são gravados com o XML como anexo, e o formulário do título é
 * pré-preenchido (valor, vencimentos das duplicatas).
 */

async function entityByDocument(db: Executor, document: string) {
  const [row] = await db
    .select({ id: entities.id, name: entities.name, document: entities.document })
    .from(entities)
    .where(eq(entities.document, document));
  return row ?? null;
}

/* ---------------- PIX copia-e-cola ---------------- */

export async function pixEntry(ctx: ServiceContext, input: { payload: string; createEntity: boolean }): Promise<PixEntryResult> {
  const parsed = parseBrCode(input.payload);
  if (!parsed.ok) throw unprocessable(`${t.errors.pixInvalid} ${parsed.error}`.trim(), 'pix_invalid');
  const keyType = parsed.pixKeyType as PixKeyType | null;
  const key = parsed.pixKey && keyType ? normalizePixKey(keyType, parsed.pixKey) : parsed.pixKey;

  let entity: PixEntryResult['entity'] = null;
  if (key) {
    const found = await ctx.db.execute<{ id: string; name: string; document: string | null }>(sql`
      SELECT e.id, e.name, e.document FROM entity_pix_keys k JOIN entities e ON e.id = k.entity_id
       WHERE k.key_value = ${key} LIMIT 1`);
    entity = found.rows[0] ?? null;
    if (!entity && (keyType === 'cpf' || keyType === 'cnpj')) entity = await entityByDocument(ctx.db, key);
  }

  let createdEntity = false;
  if (!entity && input.createEntity) {
    ctx.access.assertRegistryWrite();
    entity = await withTx(ctx, async (tx) => {
      const kind = keyType === 'cpf' ? 'person' : 'company';
      const document = keyType === 'cpf' || keyType === 'cnpj' ? key : null;
      const [row] = await tx
        .insert(entities)
        .values({ kind, name: parsed.merchantName ?? key ?? 'Recebedor PIX', document })
        .returning({ id: entities.id, name: entities.name, document: entities.document });
      if (key && keyType) await tx.insert(entityPixKeys).values({ entityId: row!.id, keyType, keyValue: key, isPrimary: true });
      return row!;
    });
    createdEntity = true;
  }

  return {
    payload: parsed.payload,
    pixKey: key,
    pixKeyType: keyType,
    merchantName: parsed.merchantName,
    merchantCity: parsed.merchantCity,
    amountCents: parsed.amountCents,
    txid: parsed.txid,
    description: parsed.description,
    entity,
    createdEntity,
  };
}

/* ---------------- NF-e ---------------- */

const fits = (value: string | null, pattern: RegExp) => (value && pattern.test(value) ? value : null);

async function upsertIssuer(tx: Tx, nfe: NfeData) {
  const document = normalizeDocument(nfe.issuer.document);
  const existing = await entityByDocument(tx, document);
  if (existing) return { entityId: existing.id, name: existing.name, document, created: false };
  const isCompany = document.length === 14;
  const valid = isCompany ? isValidCnpj(document) : isValidCpf(document);
  const [row] = await tx
    .insert(entities)
    .values({
      kind: isCompany ? 'company' : 'person',
      name: nfe.issuer.name,
      tradeName: isCompany ? nfe.issuer.tradeName : null,
      document: valid ? document : null,
      notes: nfe.issuer.stateRegistration ? `IE ${nfe.issuer.stateRegistration}` : null,
    })
    .returning({ id: entities.id, name: entities.name });
  const address = nfe.issuer.address;
  if (address?.city && address.state && /^[A-Z]{2}$/.test(address.state)) {
    await tx.insert(entityAddresses).values({
      entityId: row!.id,
      postalCode: fits(address.postalCode?.replace(/\D/g, '') ?? null, /^[0-9]{8}$/),
      street: address.street,
      number: address.number,
      complement: address.complement,
      district: address.district,
      city: address.city,
      state: address.state,
    });
  }
  return { entityId: row!.id, name: row!.name, document, created: true };
}

export async function nfeEntry(ctx: ServiceContext, file: { name: string; mime: string; content: Buffer }): Promise<NfeEntryResult> {
  ctx.access.assertRegistryWrite();
  let nfe: NfeData;
  try {
    nfe = parseNfeXml(file.content.toString('utf8'));
  } catch (error) {
    throw unprocessable(`${t.errors.nfeInvalid} ${error instanceof Error ? error.message : ''}`.trim(), 'nfe_invalid');
  }
  return withTx(ctx, async (tx) => {
    const issuer = await upsertIssuer(tx, nfe);
    const recipientDoc = nfe.recipient?.document ? normalizeDocument(nfe.recipient.document) : null;
    const recipient = recipientDoc ? await entityByDocument(tx, recipientDoc) : null;
    const [existing] = await tx.select().from(nfeDocuments).where(eq(nfeDocuments.accessKey, nfe.accessKey));
    let documentId = existing?.id;
    let attachmentId = existing?.xmlAttachmentId ?? null;
    if (!existing) {
      attachmentId = await storeAttachment(tx, ctx, {
        name: file.name || `NFe${nfe.accessKey}.xml`,
        mime: file.mime && file.mime !== 'application/octet-stream' ? file.mime : 'application/xml',
        content: file.content,
      });
      const [row] = await tx
        .insert(nfeDocuments)
        .values({
          accessKey: nfe.accessKey,
          issuerEntityId: issuer.entityId,
          recipientEntityId: recipient && recipient.id !== issuer.entityId ? recipient.id : null,
          number: nfe.number,
          series: nfe.series,
          issuedAt: nfe.issuedAt,
          totalCents: nfe.totalCents,
          xmlAttachmentId: attachmentId,
        })
        .returning({ id: nfeDocuments.id });
      documentId = row!.id;
      const items = nfe.items
        .filter((item) => item.quantity > 0 && item.description.trim() && item.itemNumber >= 1 && item.itemNumber <= 990)
        .map((item) => ({
          nfeDocumentId: documentId!,
          itemNumber: item.itemNumber,
          productCode: item.productCode,
          description: item.description.trim(),
          ncm: fits(item.ncm, /^[0-9]{2}([0-9]{6})?$/),
          cfop: fits(item.cfop, /^[1-7][0-9]{3}$/),
          unit: item.unit,
          quantity: String(item.quantity),
          unitPriceCents: String(item.unitPriceCents),
          totalCents: item.totalCents,
        }));
      if (items.length > 0) await tx.insert(nfeItems).values(items);
    }
    return {
      nfeDocumentId: documentId!,
      accessKey: nfe.accessKey,
      number: nfe.number,
      series: nfe.series,
      issuedAt: nfe.issuedAt,
      totalCents: nfe.totalCents,
      issuer,
      recipient: nfe.recipient
        ? { entityId: recipient?.id ?? null, name: recipient?.name ?? nfe.recipient.name, document: recipientDoc }
        : null,
      duplicates: nfe.duplicates,
      itemCount: nfe.items.length,
      attachmentId,
      alreadyImported: Boolean(existing),
    };
  });
}

export async function getNfe(ctx: ServiceContext, id: string): Promise<NfeDetail> {
  void ctx;
  const result = await ctx.db.execute(sql`
    SELECT d.id, d.access_key, d.number, d.series, d.issued_at, d.total_cents, d.issuer_entity_id, ie.name AS issuer_name,
           d.recipient_entity_id, re.name AS recipient_name, d.xml_attachment_id
      FROM nfe_documents d JOIN entities ie ON ie.id = d.issuer_entity_id LEFT JOIN entities re ON re.id = d.recipient_entity_id
     WHERE d.id = ${id}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  const items = await ctx.db.execute(sql`
    SELECT item_number, product_code, description, ncm, cfop, unit, quantity, unit_price_cents, total_cents
      FROM nfe_items WHERE nfe_document_id = ${id} ORDER BY item_number`);
  const detail = camel<NfeDetail & { issuedAt: Date | string }>(row);
  return {
    ...detail,
    issuedAt: new Date(detail.issuedAt).toISOString(),
    items: items.rows.map((i) => camel<NfeDetail['items'][number]>(i)),
  };
}

/**
 * Leitura de PDF/imagem por IA (spec 010/011): por padrão, uma execução do
 * agente dos fluxos (services/ai-flows.ts); `registerDocumentReader` troca o
 * leitor (testes, outro motor).
 */
export type DocumentReading = DocumentReadingDto;
export type DocumentReader = (ctx: ServiceContext, file: { name: string; mime: string; content: Buffer }) => Promise<DocumentReading>;

let documentReader: DocumentReader | null = null;

export function registerDocumentReader(reader: DocumentReader | null) {
  documentReader = reader;
}

export async function readDocument(ctx: ServiceContext, file: { name: string; mime: string; content: Buffer }) {
  if (documentReader) return documentReader(ctx, file);
  return readDocumentWithAi(ctx, file);
}
