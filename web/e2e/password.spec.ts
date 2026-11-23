import { openAccountPage, openManagementPage } from './explorer'
import { expect, test } from '@playwright/test'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('password change validates the current password and Administrator reset restores the credential', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await openAccountPage(page, '账户设置')
  await expect(page.getByTestId('current-user')).toBeVisible()
  const session = await page.request.get('/api/session')
  const user = await session.json()
  try {
    await page.getByLabel('当前密码').fill('wrong')
    await page.getByLabel('新密码', { exact: true }).fill(ADMINISTRATOR_PASSWORD)
    await page.getByLabel('确认新密码', { exact: true }).fill('mismatch-secret')
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('两次输入的新密码不一致')
    await page.getByLabel('确认新密码', { exact: true }).fill(ADMINISTRATOR_PASSWORD)
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('修改失败，请检查当前密码')
    await page.getByLabel('当前密码').fill(ADMINISTRATOR_PASSWORD)
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('密码已修改')

    await openManagementPage(page, '组织与用户组管理')
    await page.getByRole('button', { name: '用户', exact: true }).click()
    const userRow = page.locator('tbody tr', { hasText: ADMINISTRATOR_USERNAME }).first()
    await userRow.getByRole('button', { name: `管理用户 ${ADMINISTRATOR_USERNAME}`, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText('重置登录密码').click()
    await dialog.getByLabel('新登录密码', { exact: true }).fill(ADMINISTRATOR_PASSWORD)
    await dialog.getByRole('button', { name: '重置密码', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('密码已重置')
  } finally {
    const reset = await page.request.put(`/api/users/${user.id}/password`, { data: { newPassword: ADMINISTRATOR_PASSWORD } })
    expect(reset.status()).toBe(204)
  }
})
