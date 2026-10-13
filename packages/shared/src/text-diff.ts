/*
 * Diff de texto por linhas (algoritmo de Myers, O((N+M)·D)), para comparar
 * duas versões de um documento markdown (spec 020). Puro e sem dependências.
 */

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; oldLine: number | null; newLine: number | null };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split(/\r?\n/);
  const b = after === '' ? [] : after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  // Volta pelo caminho para montar as operações.
  const ops: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d -= 1) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: 'same', text: a[x]!, oldLine: x + 1, newLine: y + 1 });
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ kind: 'add', text: b[y]!, oldLine: null, newLine: y + 1 });
      } else {
        x -= 1;
        ops.push({ kind: 'del', text: a[x]!, oldLine: x + 1, newLine: null });
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
