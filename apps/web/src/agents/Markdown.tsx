import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { type MouseEvent, memo, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

/*
 * Markdown seguro do assistente: marked → DOMPurify.sanitize. Links abrem em
 * nova aba com rel=noopener; referências internas "title:<id>" etc. viram
 * links para a tela do registro.
 */

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (href.startsWith('/')) return;
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Referências que o console entende: "(title:<id>)" → rota interna. */
const INTERNAL: Record<string, (id: string) => string> = {
  entity: (id) => `/entities/${id}`,
  caixa: (id) => `/caixas/${id}`,
  invoice: (id) => `/card-invoices/${id}`,
};

function rewriteInternalLinks(markdown: string): string {
  return markdown.replace(/\]\((entity|caixa|invoice):([0-9a-f-]{36})\)/gi, (_all, kind: string, id: string) => {
    const to = INTERNAL[kind.toLowerCase()];
    return to ? `](${to(id)})` : `](${kind}:${id})`;
  });
}

/** Link interno (/entities/…): navega pelo router, sem recarregar a página. */
function internalClick(event: MouseEvent<HTMLDivElement>, navigate: (to: string) => void) {
  const anchor = (event.target as HTMLElement).closest('a');
  const href = anchor?.getAttribute('href');
  if (!href?.startsWith('/') || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  navigate(href);
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const navigate = useNavigate();
  const html = useMemo(() => {
    ensureHooks();
    const raw = marked.parse(rewriteInternalLinks(text), { async: false, gfm: true, breaks: true }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [text]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML saneado pelo DOMPurify logo acima.
  return <div className="agent-md" onClick={(event) => internalClick(event, navigate)} dangerouslySetInnerHTML={{ __html: html }} />;
});
