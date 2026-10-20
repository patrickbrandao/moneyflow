import { barcodeToDigitableLine, formatAccounting, formatDate, type NfeDetail, parseBrCode, type TitleRow, t } from '@moneyflow/shared';
import { Download } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import '../../styles/attachments.css';
import { useApi } from '../../lib/hooks';
import { entityLink } from '../../lib/links';
import { attachmentUrl } from '../../lib/upload';
import { LoadError } from '../domain';
import { CopyButton, Skel } from '../ui';

/** Seções da gaveta do título com o que veio da entrada (spec 010): boleto, PIX e NF-e. */
export function TitleEntryInfo({ title }: { title: Pick<TitleRow, 'boletoBarcode' | 'pixPayload' | 'nfeDocumentId'> }) {
  return (
    <>
      {title.boletoBarcode && <BoletoInfo barcode={title.boletoBarcode} />}
      {title.pixPayload && <PixInfo payload={title.pixPayload} />}
      {title.nfeDocumentId && <NfeInfo id={title.nfeDocumentId} />}
    </>
  );
}

function BoletoInfo({ barcode }: { barcode: string }) {
  const line = barcodeToDigitableLine(barcode) ?? barcode;
  return (
    <div className="sec">
      <p className="eyebrow">{t.entry.sectionBoleto}</p>
      <p className="code-line">{line}</p>
      <div className="mt-2">
        <CopyButton text={line.replace(/\D/g, '')} label={t.entry.copyLine} />
      </div>
    </div>
  );
}

function PixInfo({ payload }: { payload: string }) {
  const parsed = useMemo(() => parseBrCode(payload), [payload]);
  return (
    <div className="sec">
      <p className="eyebrow">{t.entry.sectionPix}</p>
      {parsed.ok && (
        <dl className="kv">
          {parsed.pixKey && (
            <>
              <dt>{t.entry.pixKey}</dt>
              <dd className="mono">{parsed.pixKey}</dd>
            </>
          )}
          {parsed.merchantName && (
            <>
              <dt>{t.entry.pixName}</dt>
              <dd>
                {parsed.merchantName}
                {parsed.merchantCity ? ` · ${parsed.merchantCity}` : ''}
              </dd>
            </>
          )}
          {parsed.amountCents ? (
            <>
              <dt>{t.title.amount}</dt>
              <dd className="mono">{formatAccounting(parsed.amountCents)}</dd>
            </>
          ) : null}
        </dl>
      )}
      <p className="code-line mt-2 line-clamp-2" title={payload}>
        {payload}
      </p>
      <div className="mt-2">
        <CopyButton text={payload} label={t.entry.copyPix} />
      </div>
    </div>
  );
}

function NfeInfo({ id }: { id: string }) {
  const { data: nfe, error, reload } = useApi<NfeDetail>(`/api/nfe/${id}`);
  return (
    <div className="sec">
      <p className="eyebrow">{t.entry.sectionNfe}</p>
      {error && <LoadError error={error} onRetry={() => void reload()} />}
      {!nfe && !error && <Skel h={60} />}
      {nfe && (
        <>
          <dl className="kv">
            <dt>{t.entry.nfeNumber}</dt>
            <dd className="mono">{t.entry.nfeNumberSeries(nfe.number, nfe.series)}</dd>
            <dt>{t.entry.nfeIssuer}</dt>
            <dd>
              <Link className="link" to={entityLink(nfe.issuerEntityId)}>
                {nfe.issuerName}
              </Link>
            </dd>
            <dt>{t.entry.nfeIssued}</dt>
            <dd className="mono">{formatDate(nfe.issuedAt.slice(0, 10))}</dd>
            <dt>{t.entry.nfeTotal}</dt>
            <dd className="mono">{formatAccounting(nfe.totalCents)}</dd>
            <dt>{t.entry.nfeKey}</dt>
            <dd className="flex items-center gap-1">
              <span className="code-line">{nfe.accessKey.replace(/(.{4})(?=.)/g, '$1 ')}</span>
              <CopyButton text={nfe.accessKey} />
            </dd>
          </dl>
          {nfe.items.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="nfe-items">
                <caption className="sr-only">{t.entry.nfeItems}</caption>
                <thead>
                  <tr>
                    <th>{t.common.description}</th>
                    <th className="num">{t.entry.qty}</th>
                    <th className="num">{t.entry.unitPrice}</th>
                    <th className="num">{t.common.total}</th>
                  </tr>
                </thead>
                <tbody>
                  {nfe.items.map((item) => (
                    <tr key={item.itemNumber}>
                      <td>
                        {item.description}
                        {item.ncm && <span className="block text-[11px] text-faint">NCM {item.ncm}</span>}
                      </td>
                      <td className="num">
                        {item.quantity.toLocaleString('pt-BR')} {item.unit ?? ''}
                      </td>
                      <td className="num">{formatAccounting(item.unitPriceCents)}</td>
                      <td className="num">{formatAccounting(item.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {nfe.xmlAttachmentId && (
            <a className="btn btn-ghost btn-sm mt-3" href={attachmentUrl(nfe.xmlAttachmentId)} download>
              <Download /> {t.entry.nfeXml}
            </a>
          )}
          {nfe.recipientName && (
            <p className="mt-2 text-[12px] text-faint">
              {t.entry.nfeRecipient}: {nfe.recipientName}
            </p>
          )}
        </>
      )}
    </div>
  );
}
