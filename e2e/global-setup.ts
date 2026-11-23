import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type APIRequestContext, request } from '@playwright/test';
import { ADMIN_STATE, adminPassword, adminUsername, baseURL } from './support/session';

type Named = { id: string; name: string; isActive: boolean };

/*
 * Sobras de uma execução interrompida (tarefa 125): o agente e o provedor "E2E…" que o afterAll não desligou continuam
 * ativos, e o agente dos fluxos é o primeiro ativo; todo import dos specs seguintes enfileiraria uma execução dele.
 * Desliga-os antes da suíte. Outro agente ativo na pilha (criado à mão) não é tocado, só avisado.
 */
async function deactivateLeftovers(ctx: APIRequestContext) {
  for (const kind of ['agents', 'providers'] as const) {
    const res = await ctx.get(`/api/admin/ai/${kind}`);
    if (!res.ok()) throw new Error(`global-setup: GET /api/admin/ai/${kind} falhou: ${res.status()} ${await res.text()}`);
    const active = ((await res.json()) as Named[]).filter((item) => item.isActive);
    for (const item of active.filter((i) => i.name.startsWith('E2E'))) {
      const off = await ctx.patch(`/api/admin/ai/${kind}/${item.id}`, { data: { isActive: false } });
      if (!off.ok()) throw new Error(`global-setup: desligar ${item.name} falhou: ${off.status()} ${await off.text()}`);
    }
    const others = active.filter((i) => !i.name.startsWith('E2E'));
    if (kind === 'agents' && others.length) {
      console.warn(
        `global-setup: agente(s) ativo(s) fora dos testes na pilha (${others.map((a) => a.name).join(', ')}): ` +
          'os imports dos specs recebem as sugestões dele; desative-o para uma execução limpa.',
      );
    }
  }
}

/** Abre a sessão do admin uma vez e a grava para os testes (ver support/session.ts). */
export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL });
  try {
    const res = await ctx.post('/api/auth/login', { data: { login: adminUsername, password: adminPassword } });
    if (!res.ok()) throw new Error(`login do admin no global-setup falhou: ${res.status()} ${await res.text()}`);
    mkdirSync(dirname(ADMIN_STATE), { recursive: true });
    await ctx.storageState({ path: ADMIN_STATE });
    await deactivateLeftovers(ctx);
  } finally {
    await ctx.dispose();
  }
}
