import { expect, test } from '@playwright/test'
import { openManagementPage } from './explorer'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('switching workspaces preserves the file location, expanded branches, and directory scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 460 })
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await expect(page.getByTestId('current-user')).toBeVisible()

  async function folder(name: string, parentId?: number): Promise<{ id: number }> {
    const response = await page.request.post('/api/tree', { data: { name, parentId } })
    expect(response.ok()).toBeTruthy()
    return response.json()
  }

  const rootName = `Workspace-${Date.now()}`
  const root = await folder(rootName)
  const branch = await folder('展开测试', root.id)
  await folder('子目录', branch.id)
  await Promise.all(Array.from({ length: 15 }, (_, index) => folder(`目录-${String(index).padStart(2, '0')}`, root.id)))

  await page.goto(`/#item=${root.id}`)
  const tree = page.getByRole('navigation', { name: '目录树' })
  await tree.getByRole('button', { name: '展开 展开测试', exact: true }).click()
  await expect(tree.getByRole('link', { name: '子目录', exact: true })).toBeVisible()
  await tree.evaluate(element => { element.scrollTop = 120 })
  await expect.poll(() => tree.evaluate(element => element.scrollTop)).toBe(120)
  const resize = page.getByRole('separator', { name: '调整目录栏宽度' })
  await resize.press('ArrowRight')
  await expect(resize).toHaveAttribute('aria-valuenow', '296')

  await openManagementPage(page, '审计日志')
  await expect(page.getByRole('navigation', { name: '管理导航' })).toBeVisible()
  await expect(tree).toHaveCount(0)
  await expect(page.getByRole('link', { name: '回收站', exact: true })).toHaveCount(0)

  await page.getByRole('navigation', { name: '工作区' }).getByRole('link', { name: '文件', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '目录路径' })).toContainText(rootName)
  await expect(tree.getByRole('button', { name: '折叠 展开测试', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => tree.evaluate(element => element.scrollTop)).toBe(120)
  await expect(resize).toHaveAttribute('aria-valuenow', '296')
})

test('the narrow directory drawer opens from the file page and closes after selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await expect(page.getByTestId('current-user')).toBeVisible()
  const name = `Drawer-${Date.now()}`
  const response = await page.request.post('/api/tree', { data: { name } })
  expect(response.ok()).toBeTruthy()
  await page.reload()

  const trigger = page.getByRole('button', { name: '目录', exact: true })
  const drawer = page.getByRole('dialog', { name: '目录', exact: true })
  await trigger.click()
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await drawer.getByRole('navigation', { name: '目录树' }).getByRole('link', { name, exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '目录路径' })).toContainText(name)
})
