import { test, expect } from '@playwright/test';

test.setTimeout(60000)

test('Approve and view images', async ({ page }) => {
  await page.goto('https://imaging-local.argo.run/app/viewer/');
  await page.getByRole('combobox').selectOption({label: '(Local) SMART Sandbox + Imaging Server'});
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Approve' }).click();

  const clinicalPanel = page.locator('.clinical-panel');
  await expect(clinicalPanel).toContainText("Danae");

  await page.getByRole('button', { name: /Upper Extremity/ }).first().click();
  const studyPanel = await page.locator(".study-sidebar");
  await expect(studyPanel).toContainText("Danae");

  await page.keyboard.press('Escape');
  await expect(studyPanel).toContainText("Imaging");
  await expect(studyPanel).toContainText("Upper Extremity");
});
