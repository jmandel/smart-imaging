import { test, expect } from '@playwright/test';

test.setTimeout(60000)

test('Approve and view images', async ({ page }) => {
  await page.goto('https://imaging-local.argo.run/app/');
  await page.getByRole('combobox').selectOption({label: '(Local) SMART Sandbox + Imaging Server'});
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'Fetch CR' }).first().click();

  const studyPanel = await page.locator(".study-sidebar");
  await expect(studyPanel).toContainText("Danae");
  await page.getByRole('link', { name: '↑' }).click();
  const ehrPanel = await page.getByRole('heading', { name: 'EHR Data' }).locator('..');
  await expect(ehrPanel).toContainText("Danae");
});
