import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  isInternalHref,
  isSafeMarkdownUri,
  MARKDOWN_ALLOWED_ATTR,
  MARKDOWN_ALLOWED_TAGS,
  MARKDOWN_FORBID_ATTR,
  rewriteInternalLinks,
} from '../src/index';

/*
 * Política do markdown seguro (tarefa 073): sem HTML cru, só as tags e os
 * atributos que o markdown produz, e só URLs http(s), mailto, tel ou internas.
 */

describe('markdown seguro: sem HTML cru', () => {
  it('escapa o HTML para aparecer como texto', () => {
    expect(escapeHtml('<style>body{display:none}</style>')).toBe('&lt;style&gt;body{display:none}&lt;/style&gt;');
    expect(escapeHtml('<div style="position:fixed" popover>X & Y</div>')).not.toMatch(/[<>"]/);
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('as listas não deixam passar estilo, formulário, diálogo nem camada popover', () => {
    const tags: readonly string[] = MARKDOWN_ALLOWED_TAGS;
    const attrs: readonly string[] = MARKDOWN_ALLOWED_ATTR;
    for (const tag of ['style', 'form', 'button', 'textarea', 'select', 'dialog', 'div', 'span', 'iframe', 'script', 'svg']) {
      expect(tags, tag).not.toContain(tag);
    }
    for (const attr of ['style', 'class', 'id', 'popover', 'popovertarget', 'onclick', 'formaction']) {
      expect(attrs, attr).not.toContain(attr);
    }
    for (const attr of ['style', 'class', 'id', 'popover']) expect(MARKDOWN_FORBID_ATTR).toContain(attr);
    // O que o GFM produz continua: tabela, lista de tarefas, código e links.
    for (const tag of ['table', 'th', 'td', 'input', 'pre', 'code', 'a', 'strong', 'del']) expect(tags).toContain(tag);
  });

  it('aceita só http(s), mailto, tel e caminho interno', () => {
    for (const ok of [
      'https://exemplo.com.br/x',
      'http://localhost:3000',
      'mailto:a@b.com',
      'tel:+5511999999999',
      '/entities/1',
      'HTTPS://X.COM',
    ]) {
      expect(isSafeMarkdownUri(ok), ok).toBe(true);
    }
    for (const bad of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:x',
      '//exemplo.invalid',
      '/\\exemplo.invalid',
      '/\t/exemplo.invalid',
      ' //exemplo.invalid',
      'relativo.md',
      'ftp://x',
    ]) {
      expect(isSafeMarkdownUri(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('link interno só com uma barra; //host e /\\host são externos e barrados', () => {
    expect(isInternalHref('/entities/abc')).toBe(true);
    expect(isInternalHref('//exemplo.invalid')).toBe(false);
    expect(isInternalHref('/\\exemplo.invalid')).toBe(false);
    expect(isInternalHref('https://exemplo.com')).toBe(false);
  });

  it('referências internas viram rotas do console', () => {
    const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(rewriteInternalLinks(`[Loja](entity:${id}) e [Casa](CAIXA:${id})`)).toBe(`[Loja](/entities/${id}) e [Casa](/caixas/${id})`);
    expect(rewriteInternalLinks(`[Fatura](invoice:${id})`)).toBe(`[Fatura](/card-invoices/${id})`);
    expect(rewriteInternalLinks('[x](title:123)')).toBe('[x](title:123)');
  });
});
