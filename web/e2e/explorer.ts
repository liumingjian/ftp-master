import { type Page } from '@playwright/test'

export async function createAndOpenFolder(page: Page, name: string) {
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建文件夹', exact: true })
  await dialog.getByLabel('目录名称').fill(name)
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('table', { name: '文件列表' }).getByRole('button', { name, exact: true }).click()
}

export async function openManagementPage(page: Page, name: string) {
  await page.getByRole('navigation', { name: '工作区' }).getByRole('link', { name: '管理', exact: true }).click()
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name, exact: true }).click()
}

export async function openAccountPage(page: Page, name: string) {
  await page.locator('.user-menu summary').click()
  await page.getByRole('link', { name, exact: true }).click()
}
