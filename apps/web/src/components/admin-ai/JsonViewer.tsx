import { type Base64Info, base64Extension, detectBase64, t } from '@moneyflow/shared';
import { ChevronDown, ChevronRight, Download, Eye, EyeOff, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../attachments/AttachmentsPanel';
import { cx } from '../ui';

const d = t.agentsUi.admin.requests.drawer;

/*
 * Visualizador JSON do detalhe da requisição (spec 023): árvore recolhível,
 * com o base64 de imagens, PDFs e áudios recolhido num chip com o tamanho e
 * "ver/ouvir" e "baixar" (o arquivo é montado no navegador, nada vai à rede).
 * Texto que não é JSON (o stream bruto, um corpo de erro em HTML) aparece cru.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function JsonViewer({ text, name }: { text: string; name: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as Json };
    } catch {
      return { ok: false as const };
    }
  }, [text]);
  if (!parsed.ok) return <pre className="json-raw">{text}</pre>;
  return (
    <div className="json-view" data-testid="json-viewer">
      <Node value={parsed.value} depth={0} name={name} parent={null} />
    </div>
  );
}

function Node({
  value,
  depth,
  label,
  name,
  parent,
}: {
  value: Json;
  depth: number;
  label?: string;
  name: string;
  parent: Record<string, Json> | null;
}) {
  const [open, setOpen] = useState(depth < 3);
  const key = label !== undefined ? <span className="jv-key">{label}: </span> : null;
  if (value === null)
    return (
      <Line>
        {key}
        <span className="jv-null">null</span>
      </Line>
    );
  if (typeof value === 'boolean')
    return (
      <Line>
        {key}
        <span className="jv-bool">{String(value)}</span>
      </Line>
    );
  if (typeof value === 'number')
    return (
      <Line>
        {key}
        <span className="jv-num">{value}</span>
      </Line>
    );
  if (typeof value === 'string') {
    const b64 = detectBase64(value, parent);
    if (b64) {
      return (
        <Line>
          {key}
          <Base64Chip info={b64} name={`${name}-${label ?? 'arquivo'}`} />
        </Line>
      );
    }
    return (
      <Line>
        {key}
        <span className="jv-str">{JSON.stringify(value)}</span>
      </Line>
    );
  }
  const isArray = Array.isArray(value);
  const entries: [string, Json][] = isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const summary = isArray ? d.items(entries.length) : d.keys(entries.length);
  return (
    <div className="jv-node">
      <button
        type="button"
        className="jv-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? d.collapse : d.expand}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {key}
        <span className="jv-brace">{isArray ? '[' : '{'}</span>
        {!open && (
          <>
            <span className="jv-summary">{summary}</span>
            <span className="jv-brace">{isArray ? ']' : '}'}</span>
          </>
        )}
      </button>
      {open && (
        <>
          <div className="jv-children">
            {entries.map(([k, v]) => (
              <Node key={k} value={v} depth={depth + 1} label={k} name={name} parent={isArray ? null : (value as Record<string, Json>)} />
            ))}
          </div>
          <span className="jv-brace">{isArray ? ']' : '}'}</span>
        </>
      )}
    </div>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return <div className="jv-line">{children}</div>;
}

function toBlob(info: Base64Info): Blob {
  const binary = atob(info.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: info.mime ?? 'application/octet-stream' });
}

/** Base64 recolhido: tipo e tamanho; imagem e áudio com "ver/ouvir", PDF abre noutra aba; todos com "baixar". */
function Base64Chip({ info, name }: { info: Base64Info; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const objectUrl = () => {
    if (url) return url;
    const created = URL.createObjectURL(toBlob(info));
    setUrl(created);
    return created;
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = objectUrl();
    a.download = `${name.replace(/[^\w.-]+/g, '-')}.${base64Extension(info.mime)}`;
    a.click();
  };
  const canShow = info.kind === 'image' || info.kind === 'audio' || info.kind === 'pdf';
  return (
    <span className="b64-chip-wrap">
      <span className="b64-chip" data-testid="base64-chip">
        {d.base64(d.base64Kinds[info.kind] ?? info.kind, formatBytes(info.bytes))}
        {info.mime && <span className="mono"> · {info.mime}</span>}
        {canShow && (
          <button
            type="button"
            className={cx('b64-action')}
            onClick={() => {
              if (info.kind === 'pdf') {
                window.open(objectUrl(), '_blank', 'noopener');
                return;
              }
              objectUrl();
              setShowing((v) => !v);
            }}
          >
            {showing ? <EyeOff size={12} /> : info.kind === 'audio' ? <Volume2 size={12} /> : <Eye size={12} />}
            {showing ? d.hide : info.kind === 'audio' ? d.listen : d.view}
          </button>
        )}
        <button type="button" className="b64-action" onClick={download}>
          <Download size={12} /> {d.download}
        </button>
      </span>
      {showing && url && info.kind === 'image' && <img className="b64-preview" src={url} alt={name} />}
      {showing && url && info.kind === 'audio' && (
        // biome-ignore lint/a11y/useMediaCaption: áudio enviado ao provedor, sem legenda
        <audio className="b64-preview" src={url} controls />
      )}
    </span>
  );
}
