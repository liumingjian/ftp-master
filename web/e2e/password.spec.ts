import { expect, test } from '@playwright/test'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('password change validates the current password and Administrator reset restores the credential', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await expect(page.getByTestId('current-user')).toBeVisible()
  const session = await page.request.get('/api/session')
  const user = await session.json()
  try {
    await page.getByLabel('当前密码').fill('wrong')
    await page.getByLabel('新密码', { exact: true }).fill(ADMINISTRATOR_PASSWORD)
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('修改失败，请检查当前密码')
    await page.getByLabel('当前密码').fill(ADMINISTRATOR_PASSWORD)
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('密码已修改')
    await page.getByLabel('用户编号').fill(String(user.id))
    await page.getByLabel('重置密码', { exact: true }).fill(ADMINISTRATOR_PASSWORD)
    await page.getByRole('button', { name: '重置密码', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('密码已重置')
  } finally {
    const reset = await page.request.put(`/api/users/${user.id}/password`, { data: { newPassword: ADMINISTRATOR_PASSWORD } })
    expect(reset.status()).toBe(204)
  }
})
