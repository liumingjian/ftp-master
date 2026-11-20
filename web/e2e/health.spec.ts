import { expect, test } from '@playwright/test'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('web shell shows the health status the service read from PostgreSQL', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)

  await expect(page.getByRole('heading', { name: '服务状态' })).toBeVisible()
  await expect(page.getByTestId('health-status')).toHaveText('正常')
  // The schema version only exists in PostgreSQL's migration history, so seeing
  // it proves the request went browser → service → database and back.
  await expect(page.getByTestId('health-database')).toHaveText(/正常，架构版本 [1-9]\d*/)
})
