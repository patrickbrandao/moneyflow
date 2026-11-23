import type { ContractActionResult } from '@moneyflow/shared';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';

/**
 * Pede a prévia (dryRun) sempre que o corpo muda; erros de validação viram mensagem.
 * A prévia guarda o corpo que a gerou e só aparece enquanto ele for o da tela
 * (tarefa 117): mudado um campo, `preview` volta a null até a prévia nova
 * chegar, e o botão de aplicar (que exige a prévia) fica desligado; o Enter no
 * campo também não aplica, porque a submissão implícita respeita o botão desligado.
 */
export function usePreview<P>(path: string, body: unknown, enabled: boolean) {
  const [result, setResult] = useState<{ key: string; preview: P | null; error: string | null } | null>(null);
  const json = JSON.stringify(body);
  const key = `${path}\n${json}`;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .post<ContractActionResult<P>>(`${path}?dryRun=1`, JSON.parse(json))
        .then((r) => {
          if (!cancelled) setResult({ key, preview: r.preview, error: null });
        })
        .catch((err) => {
          if (!cancelled) setResult({ key, preview: null, error: err instanceof ApiError ? err.message : String(err) });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, json, key, enabled]);
  const fresh = enabled && result?.key === key ? result : null;
  return { preview: fresh?.preview ?? null, error: fresh?.error ?? null };
}
