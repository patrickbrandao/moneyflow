/*
 * Diff de texto por linhas (algoritmo de Myers), para comparar duas versões de
 * um documento markdown (spec 020) ou do prompt de um agente. Puro e sem
 * dependências.
 *
 * Custo (tarefa 112): o prefixo e o sufixo comuns ficam fora do Myers (o caso
 * típico de uma edição); as linhas viram números para a comparação; e o caminho
 * guarda, a cada passo d, só a faixa de diagonais usada (2d+1), o que dá memória
 * O(D²) em vez de O(D·(N+M)). Acima de `maxEdits` linhas diferentes, o miolo
 * sai resumido: todas as antigas removidas e todas as novas incluídas
 * (`truncated`). O diff resumido continua válido (reconstrói os dois lados); só
 * deixa de ser o menor, e as contagens viram limites superiores.
 */

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; oldLine: number | null; newLine: number | null };

/** Diff com a marca de resumido. */
export type DiffResult = { lines: DiffLine[]; truncated: boolean };

/** Teto de linhas diferentes do diff exato: ~36 MB no pior caso, em milissegundos. */
export const DIFF_MAX_EDITS = 3000;

export function diffLines(before: string, after: string): DiffLine[] {
  return diffText(before, after).lines;
}

export function diffText(before: string, after: string, maxEdits = DIFF_MAX_EDITS): DiffResult {
  const a = before === '' ? [] : before.split(/\r?\n/);
  const b = after === '' ? [] : after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) lines.push({ kind: 'same', text: a[i]!, oldLine: i + 1, newLine: i + 1 });
  const middle = myers(a, b, start, endA, endB, maxEdits);
  if (middle) {
    for (const line of middle) lines.push(line);
  } else {
    for (let i = start; i < endA; i += 1) lines.push({ kind: 'del', text: a[i]!, oldLine: i + 1, newLine: null });
    for (let j = start; j < endB; j += 1) lines.push({ kind: 'add', text: b[j]!, oldLine: null, newLine: j + 1 });
  }
  for (let i = endA, j = endB; i < a.length; i += 1, j += 1) {
    lines.push({ kind: 'same', text: a[i]!, oldLine: i + 1, newLine: j + 1 });
  }
  return { lines, truncated: middle === null };
}

/** Myers no miolo a[start..endA) × b[start..endB); null se passar de `maxEdits`. */
function myers(a: string[], b: string[], start: number, endA: number, endB: number, maxEdits: number): DiffLine[] | null {
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) {
    const ops: DiffLine[] = [];
    for (let i = start; i < endA; i += 1) ops.push({ kind: 'del', text: a[i]!, oldLine: i + 1, newLine: null });
    for (let j = start; j < endB; j += 1) ops.push({ kind: 'add', text: b[j]!, oldLine: null, newLine: j + 1 });
    return ops;
  }
  // O diff tem pelo menos |N − M| linhas diferentes.
  if (Math.abs(n - m) > maxEdits) return null;

  // Cada linha distinta vira um número: comparar inteiros, não textos.
  const ids = new Map<string, number>();
  const intern = (text: string) => {
    let id = ids.get(text);
    if (id === undefined) {
      id = ids.size;
      ids.set(text, id);
    }
    return id;
  };
  const xa = new Int32Array(n);
  for (let i = 0; i < n; i += 1) xa[i] = intern(a[start + i]!);
  const yb = new Int32Array(m);
  for (let j = 0; j < m; j += 1) yb[j] = intern(b[start + j]!);

  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d]: as diagonais −d..d de v no início do passo d (índice k + d).
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && xa[x] === yb[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return null;

  // Volta pelo caminho para montar as operações.
  const ops: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d -= 1) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[k - 1 + d]! < vd[k + 1 + d]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vd[prevK + d]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: 'same', text: a[start + x]!, oldLine: start + x + 1, newLine: start + y + 1 });
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ kind: 'add', text: b[start + y]!, oldLine: null, newLine: start + y + 1 });
      } else {
        x -= 1;
        ops.push({ kind: 'del', text: a[start + x]!, oldLine: start + x + 1, newLine: null });
      }
    }
  }
  return ops.reverse();
}

/** Resumo do diff: linhas incluídas e removidas. */
export function diffStats(lines: DiffLine[]) {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'del') removed += 1;
  }
  return { added, removed };
}
