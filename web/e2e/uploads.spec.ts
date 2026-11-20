import { expect, test } from '@playwright/test'
import { ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD, signIn } from './signin'

test('browser sends real multipart bytes to public storage and shows in-place progress', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const panel = page.getByRole('region', { name: '共享目录' })
  const dir = `Upload-${Date.now()}`
  await panel.getByLabel('目录名称').fill(dir)
  await panel.getByRole('button', { name: '创建目录' }).click()
  await panel.getByRole('button', { name: dir, exact: true }).click()
  const storageResponses: number[] = []
  page.on('response', response => {if (response.request().method() === 'PUT' && response.url().includes('uploadId=')) storageResponses.push(response.status())})
  await panel.getByLabel('上传文件').setInputFiles({ name: 'multipart.txt', mimeType: 'text/plain', buffer: Buffer.alloc(9 * 1024 * 1024, 65) })
  await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('上传完成', {timeout: 60000})
  await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('MB/s')
  await expect(panel.getByRole('button', { name: 'multipart.txt', exact: true })).toBeVisible()
  expect(storageResponses).toEqual([200, 200])
  await panel.getByLabel('上传文件').setInputFiles({ name: 'blocked.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('no') })
  await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('blocked extension')
  expect(storageResponses).toEqual([200, 200])
})

test('same-name uploads ask on the row and preserve both choices', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const panel = page.getByRole('region', { name: '共享目录' })
  const dir = `Clash-${Date.now()}`
  await panel.getByLabel('目录名称').fill(dir)
  await panel.getByRole('button', { name: '创建目录' }).click()
  await panel.getByRole('button', { name: dir, exact: true }).click()
  const file = { name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('first') }
  await panel.getByLabel('上传文件').setInputFiles(file)
  await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('上传完成')
  for (const choice of ['存为新版本', '保留两者']) {
    await panel.getByLabel('上传文件').setInputFiles({ ...file, buffer: Buffer.from(choice) })
    await expect(panel.getByRole('button', { name: '存为新版本', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: '保留两者', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: choice, exact: true }).click()
    await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('上传完成')
  }
  await expect(panel.getByRole('button', { name: 'same.txt', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'same (1).txt', exact: true })).toBeVisible()
})
