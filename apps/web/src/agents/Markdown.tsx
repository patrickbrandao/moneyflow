import {
  escapeHtml,
  isInternalHref,
  MARKDOWN_ALLOWED_ATTR,
  MARKDOWN_ALLOWED_TAGS,
  MARKDOWN_FORBID_ATTR,
  MARKDOWN_SAFE_URI,
  rewriteInternalLinks,
  t,
} from '@moneyflow/shared';
import DOMPurify from 'dompurify';
import { Code, Eye } from 'lucide-react';
import { Marked } from 'marked';
import { type MouseEvent, memo, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs } from '../components/ui';

/*
 * Markdown seguro do console (chat, anotações, documentos de contrato e
 * anexos .md), sem HTML cru: uma instância própria do marked escapa todo
 * HTML do texto, e uma instância própria do DOMPurify saneia a saída só com
 * as tags e atributos do markdown (a política fica em @moneyflow/shared,
 * `markdown.ts`). Links externos abrem em nova aba com rel=noopener;
 * referências internas "entity:<id>" etc. viram links para a tela do registro.
 */

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // HTML cru (bloco ou tag no meio do texto) aparece como texto.
    html: ({ text, block }) => (block ? `<p>${escapeHtml(text.trim()).replace(/\n/g, '<br>')}</p>` : escapeHtml(text)),
  },
});

// Instância só do markdown: o hook não vaza para outro uso do DOMPurify.
const purify = DOMPurify(window);
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    if (isInternalHref(node.getAttribute('href') ?? '')) return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  // O único input do markdown é a caixa da lista de tarefas, sempre desabilitada.
  if (node.tagName === 'INPUT') {
    node.setAttribute('type', 'checkbox');
    node.setAttribute('disabled', '');
  }
});

const SANITIZE = {
  ALLOWED_TAGS: [...MARKDOWN_ALLOWED_TAGS],
  ALLOWED_ATTR: [...MARKDOWN_ALLOWED_ATTR],
  FORBID_ATTR: [...MARKDOWN_FORBID_ATTR],
  ALLOWED_URI_REGEXP: MARKDOWN_SAFE_URI,
  // Só href e src passam pela regra das URLs; os demais (align, start…) são valores comuns.
  ADD_URI_SAFE_ATTR: MARKDOWN_ALLOWED_ATTR.filter((name) => name !== 'href' && name !== 'src'),
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/** O HTML saneado de um texto markdown. */
function renderMarkdown(text: string): string {
  const raw = md.parse(rewriteInternalLinks(text), { async: false });
  return purify.sanitize(raw, SANITIZE);
}

/** Link interno (/entities/…): navega pelo router, sem recarregar a página. */
function internalClick(event: MouseEvent<HTMLDivElement>, navigate: (to: string) => void) {
  const anchor = (event.target as HTMLElement).closest('a');
  const href = anchor?.getAttribute('href');
  if (!href || !isInternalHref(href) || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  navigate(href);
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const navigate = useNavigate();
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML escapado no marked e saneado pelo DOMPurify (renderMarkdown).
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: delega o clique dos links internos; o Enter no link também chega aqui como clique.
    <div className="agent-md" onClick={(event) => internalClick(event, navigate)} dangerouslySetInnerHTML={{ __html: html }} />
  );
});

/**
 * Documento markdown (anexo .md do chat, spec 025): o conteúdo renderizado
 * pelo mesmo markdown seguro, com a alternância renderizado / bruto.
 */
export function MarkdownDocument({ text }: { text: string }) {
  const [view, setView] = useState<'rendered' | 'raw'>('rendered');
  const m = t.agentsUi.media;
  return (
    <div className="md-doc" data-testid="markdown-document" data-mode={view}>
      <Tabs
        value={view}
        onChange={(key) => setView(key as 'rendered' | 'raw')}
        items={[
          { key: 'rendered', label: m.rendered, icon: <Eye /> },
          { key: 'raw', label: m.raw, icon: <Code /> },
        ]}
      />
      {view === 'raw' ? (
        <pre className="md-doc-raw">{text}</pre>
      ) : (
        <div className="md-doc-rendered">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}
