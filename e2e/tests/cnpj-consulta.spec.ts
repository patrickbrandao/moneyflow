import { expect, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/** Um CNPJ numérico válido e novo a cada execução: o fixo dava duplicidade na segunda rodada contra a mesma pilha. */
function randomCnpj(): string {
  const dv = (s: string) => {
    const w = s.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = [...s].reduce((acc, c, i) => acc + Number(c) * w[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const base = `${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}0001`;
  const d1 = dv(base);
  const digits = `${base}${d1}${dv(`${base}${d1}`)}`;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

/*
 * A consulta de um CNPJ vale só para o CNPJ consultado (tarefa 177): trocado o
 * documento sem consultar de novo, o endereço e os contatos dela não entram na
 * entidade nova.
 */

test('consulta de CNPJ: trocado o documento, o endereço da consulta não entra', async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  // A consulta é falsa: o teste não depende do CNPJ Aberto nem da BrasilAPI.
  await page.route('**/api/lookup/cnpj/*', (route) =>
    route.fulfill({
      json: {
        document: '11222333000181',
        source: 'brasilapi',
        name: `Empresa Consultada ${tag}`,
        tradeName: null,
        registrationStatus: 'Ativa',
        email: 'contato@consultada.example',
        phone: '1133334444',
        address: {
          postalCode: '01310100',
          street: 'Avenida Paulista',
          number: '1000',
          complement: null,
          district: 'Bela Vista',
          city: 'São Paulo',
          state: 'SP',
        },
      },
    }),
  );
  await page.goto('/entities?new=1');
  const form = page.getByRole('dialog', { name: 'Nova entidade' });
  await form.getByRole('button', { name: 'Empresa' }).click();
  const cnpj = form.getByLabel('CNPJ', { exact: true });
  await cnpj.fill('11.222.333/0001-81');
  await form.getByRole('button', { name: 'Buscar CNPJ' }).click();
  await expect(form.getByText('Incluir endereço e contatos da consulta')).toBeVisible();

  // Outro CNPJ, sem consultar de novo: a caixa some e nada da consulta entra.
  await cnpj.fill(randomCnpj());
  await expect(form.getByText('Incluir endereço e contatos da consulta')).toBeHidden();
  const name = `E2E Outra ${tag}`;
  await form.getByLabel('Nome', { exact: true }).fill(name);
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const id = page.url().split('/entities/')[1]!.split(/[?#]/)[0]!;
  const entity = await (await page.request.get(`/api/entities/${id}`)).json();
  expect(entity.addresses).toEqual([]);
  expect(entity.contacts).toEqual([]);
});
