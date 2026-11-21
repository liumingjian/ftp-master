import { expect, test } from '@playwright/test'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('Administrator uploads CSV, corrects row errors and imports active Users', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const panel = page.getByRole('region', { name: '批量导入用户', exact: true })
  await expect(panel).toBeVisible()
  const organizations = await page.request.get('/api/organizations')
  expect(organizations.ok()).toBe(true)
  const organization = (await organizations.json())[0]
  const username = `import-${Date.now()}`
  const header = 'username,display_name,password,organization_id\n'
  const file = panel.getByLabel('用户 CSV 文件')
  await file.setInputFiles({ name: 'users.csv', mimeType: 'text/csv', buffer: Buffer.from(header + `${username},Imported,password,999999\n`) })
  await panel.getByRole('button', { name: '导入用户', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('未创建任何用户')
  await expect(panel.getByRole('alert')).toContainText('第 2 行')
  await file.setInputFiles({ name: 'users.csv', mimeType: 'text/csv', buffer: Buffer.from(header + `${username},Imported,password,${organization.id}\n`) })
  await panel.getByRole('button', { name: '导入用户', exact: true }).click()
  await expect(panel.getByRole('status')).toHaveText('成功导入 1 位用户')
  await expect(page.getByLabel('选择用户', { exact: true }).getByRole('option', { name: `Imported（${username}，已激活）` })).toBeAttached()
})
