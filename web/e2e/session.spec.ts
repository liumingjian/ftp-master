import { expect, test } from '@playwright/test'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('a signed-out visitor is sent to sign-in, and back where they were after signing in', async ({ page }) => {
  await page.goto('/files/some/where?view=list')

  await expect(page).toHaveURL(/\/sign-in\?next=/)
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)

  await expect(page).toHaveURL('/files/some/where?view=list')
  await expect(page.getByTestId('current-user')).toHaveText(ADMINISTRATOR_USERNAME)
})

test('wrong credentials are refused with a message and no session', async ({ page }) => {
  await page.goto('/sign-in')

  await signIn(page, ADMINISTRATOR_USERNAME, 'not-the-password')

  await expect(page.getByRole('alert')).toHaveText('用户名或密码错误')
  await expect(page).toHaveURL(/\/sign-in/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/sign-in/)
})

test('signing out ends the session', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await expect(page.getByTestId('current-user')).toBeVisible()

  await page.locator('.user-menu summary').click()
  await page.getByRole('button', { name: '退出登录' }).click()

  await expect(page).toHaveURL(/\/sign-in/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/sign-in/)
})
