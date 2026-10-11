/*
 * Mini parser XML tolerante, suficiente para OFX 2.x e NF-e: elementos,
 * atributos, texto, CDATA e entidades. Ignora declarações <?…?>, comentários
 * e DOCTYPE, e remove o prefixo de namespace dos nomes (nfe:infNFe → infNFe).
 */

export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

const stripPrefix = (name: string) => {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
};

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodifica as entidades XML (&amp; &lt; &gt; &quot; &apos; &#nn; &#xhh;). Desconhecidas ficam como estão. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Lê o documento e devolve o elemento raiz. Lança Error em pt-BR se não houver elemento. */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1]!;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      top().text += decodeXmlEntities(text.slice(i));
      break;
    }
    if (lt > i) top().text += decodeXmlEntities(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      top().text += text.slice(lt + 9, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (text.startsWith('<!', lt)) {
      // DOCTYPE (com possível subconjunto interno entre colchetes).
      let j = lt + 2;
      let depth = 0;
      while (j < text.length) {
        const c = text[j];
        if (c === '[') depth += 1;
        else if (c === ']') depth -= 1;
        else if (c === '>' && depth <= 0) break;
        j += 1;
      }
      i = j + 1;
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      const name = stripPrefix(text.slice(lt + 2, end < 0 ? text.length : end).trim());
      // Tolerante: fecha até o elemento correspondente; fechamento sem abertura é ignorado.
      const idx = stack.map((n) => n.name).lastIndexOf(name);
      if (idx > 0) stack.length = idx;
      i = end < 0 ? text.length : end + 1;
    } else {
      // Abertura: procura o '>' fora de aspas.
      let j = lt + 1;
      let quote: string | null = null;
      while (j < text.length) {
        const c = text[j]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j += 1;
      }
      let inner = text.slice(lt + 1, j);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);
      const nameMatch = /^[^\s/>]+/.exec(inner);
      if (!nameMatch) {
        top().text += '<';
        i = lt + 1;
        continue;
      }
      const node: XmlNode = { name: stripPrefix(nameMatch[0]), attrs: {}, children: [], text: '' };
      for (const m of inner.slice(nameMatch[0].length).matchAll(ATTR)) {
        const key = m[1]!;
        if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
        node.attrs[stripPrefix(key)] = decodeXmlEntities(m[2] ?? m[3] ?? '');
      }
      top().children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }

  const element = root.children[0];
  if (!element) throw new Error('Documento XML vazio ou inválido.');
  return element;
}

/** Desce pelo caminho de nomes de filhos diretos (o primeiro de cada nível). */
export function find(node: XmlNode | null | undefined, path: string[]): XmlNode | null {
  let current: XmlNode | null | undefined = node;
  for (const name of path) {
    current = current?.children.find((c) => c.name === name);
    if (!current) return null;
  }
  return current ?? null;
}

/** Todos os descendentes (em profundidade, em ordem do documento) com o nome dado. */
export function findAll(node: XmlNode | null | undefined, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

/** Primeiro descendente com o nome dado (inclui o próprio nó). */
export function findFirst(node: XmlNode | null | undefined, name: string): XmlNode | null {
  if (!node) return null;
  if (node.name === name) return node;
  for (const c of node.children) {
    const hit = findFirst(c, name);
    if (hit) return hit;
  }
  return null;
}

/** Texto aparado do filho direto `name` (ou null se ausente ou vazio). */
export function textOf(node: XmlNode | null | undefined, name: string): string | null {
  const child = node?.children.find((c) => c.name === name);
  const value = child?.text.trim();
  return value ? value : null;
}
