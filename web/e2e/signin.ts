import { expect, type Page } from '@playwright/test'

// The initial Administrator of the local stack (deploy/local/docker-compose.yml).
export const ADMINISTRATOR_USERNAME = 'admin'
export const ADMINISTRATOR_PASSWORD = 'admin-local-only'

export async function signIn(page: Page, username: string, password: string) {
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录' }).click()
}
