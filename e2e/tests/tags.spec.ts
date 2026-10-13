import { expect, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * Tags e favoritas de entidade (F6, spec 003): o admin cria uma tag no modal
 * "Tags", atribui a uma entidade pelo formulário, marca a estrela; a aba
 * Favoritas (a inicial) mostra a entidade e o filtro por tag fica na URL.
 */

test('tags e favoritas: criar tag, atribuir, marcar favorita, aba Favoritas e filtro por tag', async ({ page }) => {
  await loginAsAdmin(page);
  const suffix = Date.now().toString(36);
  const tagName = `E2E tag ${suffix}`;
  const tagged = `E2E Marcada ${suffix}`;
  const plain = `E2E Sem tag ${suffix}`;
  for (const name of [tagged, plain]) {
    const res = await page.request.post('/api/entities', { data: { kind: 'company', name } });
    expect(res.ok()).toBe(true);
  }

  // O admin cria a tag no modal da página de Entidades.
  await page.goto('/entities?kind=all');
  await page.getByRole('button', { name: 'Tags', exact: true }).click();
  const manage = page.getByRole('dialog', { name: 'Tags de entidade' });
  await manage.getByRole('button', { name: 'Nova tag' }).click();
  const form = page.getByRole('dialog', { name: 'Nova tag' });
  await form.getByLabel('Nome').fill(tagName);
  await form.getByRole('radio', { name: 'Cor 5' }).click();
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(manage.locator(`[data-tag-row="${tagName}"]`)).toContainText('0 entidades');
  await manage.getByRole('button', { name: 'Fechar' }).click();

  // Atribui pelo formulário da entidade e marca a estrela na ficha.
  await page.getByPlaceholder('Nome, fantasia ou CPF/CNPJ').fill(tagged);
  await page.getByRole('cell', { name: tagged }).click();
  await expect(page.getByRole('heading', { name: tagged })).toBeVisible();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Editar entidade' });
  await edit.getByLabel('Adicionar tag').fill(tagName);
  await edit.getByRole('option', { name: tagName }).click();
  await expect(edit.locator(`[data-tag="${tagName}"]`)).toBeVisible();
  await edit.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator(`.page-head [data-tag="${tagName}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Marcar como favorita' }).click();
  await expect(page.getByRole('button', { name: 'Desmarcar favorita' })).toHaveAttribute('aria-pressed', 'true');

  // A aba Favoritas é a inicial e mostra a entidade.
  await page.goto('/entities');
  await expect(page.getByRole('tab', { name: 'Favoritas' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('row', { name: new RegExp(tagged) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(plain) })).toHaveCount(0);

  // Filtro por tag em Todas: só a marcada, com o filtro na URL.
  await page.getByRole('tab', { name: 'Todos' }).click();
  await page.getByPlaceholder('Nome, fantasia ou CPF/CNPJ').fill(suffix);
  await expect(page.getByRole('row', { name: new RegExp(plain) })).toBeVisible();
  await page.getByRole('button', { name: 'Filtrar por tags' }).click();
  await page.getByRole('checkbox', { name: tagName }).check();
  await expect(page).toHaveURL(/tags=/);
  await expect(page.getByRole('row', { name: new RegExp(tagged) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(plain) })).toHaveCount(0);
});
