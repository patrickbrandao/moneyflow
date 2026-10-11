import type { Me } from '@moneyflow/shared';

/** Espelho no front da regra do servidor (o servidor decide; aqui só para a interface). */
export const canWriteCaixa = (user: Me, caixaId: string) =>
  user.role === 'admin' || user.memberships.some((m) => m.caixaId === caixaId && m.role === 'editor');
