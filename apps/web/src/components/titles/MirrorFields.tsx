import { type EntityDetail, t } from '@moneyflow/shared';
import { useEffect, useState } from 'react';
import { canWriteCaixa } from '../../lib/access';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { CategorySelect } from '../forms';
import { Field } from '../ui';

type Direction = 'payable' | 'receivable';

/** Escolha do espelho (spec 006) de um título novo, no formulário de título e ao lançar a linha do extrato. */
export type MirrorChoice = {
  /** Caixas de que a entidade é titular (fora a do título); null enquanto carrega. */
  held: EntityDetail['caixas'] | null;
  caixaId: string | null;
  setCaixaId: (id: string | null) => void;
  categoryId: string | null;
  setCategoryId: (id: string | null) => void;
  /** Com permissão na caixa da contraparte o espelho nasce aceito; sem ela, pendente de aceite. */
  writable: boolean;
};

/** A caixa principal da entidade vem pré-selecionada; dá para trocar ou dispensar. */
export function useMirrorChoice(entityId: string | null, caixaId: string, enabled = true): MirrorChoice {
  const user = useUser();
  const [held, setHeld] = useState<EntityDetail['caixas'] | null>(null);
  const [mirrorCaixaId, setMirrorCaixaId] = useState<string | null>(null);
  const [mirrorCategoryId, setMirrorCategoryId] = useState<string | null>(null);

  useEffect(() => {
    setHeld(null);
    setMirrorCaixaId(null);
    setMirrorCategoryId(null);
    if (!enabled || !entityId) return;
    let cancelled = false;
    api
      .get<EntityDetail>(`/api/entities/${entityId}`)
      .then((detail) => {
        if (cancelled) return;
        const options = detail.caixas.filter((c) => !c.archivedAt && c.id !== caixaId);
        setHeld(options);
        setMirrorCaixaId(options.find((c) => c.isPrimary)?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setHeld([]);
      });
    return () => {
      cancelled = true;
    };
  }, [entityId, caixaId, enabled]);

  return {
    held,
    caixaId: mirrorCaixaId,
    setCaixaId: setMirrorCaixaId,
    categoryId: mirrorCategoryId,
    setCategoryId: setMirrorCategoryId,
    writable: mirrorCaixaId ? canWriteCaixa(user, mirrorCaixaId) : false,
  };
}

/**
 * Corpo do espelho para a API. Enquanto as caixas da entidade carregam, omite
 * (o servidor usa a principal da entidade); sem caixas, null (sem espelho).
 */
export function mirrorPayload(mirror: MirrorChoice): { mirrorCaixaId?: string | null; mirrorCategoryId?: string | null } {
  if (mirror.held === null) return {};
  return {
    mirrorCaixaId: mirror.held.length > 0 ? mirror.caixaId : null,
    mirrorCategoryId: mirror.caixaId && mirror.writable ? mirror.categoryId : null,
  };
}

/** Caixa da contraparte e categoria no espelho; nada quando a entidade não é titular de outra caixa. */
export function MirrorFields({ mirror, direction }: { mirror: MirrorChoice; direction: Direction }) {
  if (!mirror.held || mirror.held.length === 0) return null;
  const mirrorKind = direction === 'payable' ? 'income' : 'expense';
  return (
    <>
      <Field label={t.title.mirrorCaixa} hint={mirror.caixaId && !mirror.writable ? t.title.mirrorPendingHint : undefined}>
        <select
          className="field"
          value={mirror.caixaId ?? ''}
          onChange={(e) => mirror.setCaixaId(e.target.value || null)}
          aria-label={t.title.mirrorCaixa}
        >
          <option value="">{t.title.mirrorNone}</option>
          {mirror.held.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.isPrimary ? ` (${t.common.primary.toLowerCase()})` : ''}
            </option>
          ))}
        </select>
      </Field>
      {mirror.caixaId && mirror.writable ? (
        <Field label={t.title.mirrorCategory}>
          <CategorySelect
            kind={mirrorKind}
            caixaId={mirror.caixaId}
            value={mirror.categoryId}
            onChange={mirror.setCategoryId}
            allowEmpty={t.title.mirrorCategoryAuto}
            ariaLabel={t.title.mirrorCategory}
          />
        </Field>
      ) : null}
    </>
  );
}
