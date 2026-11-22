import { expect, test } from '@playwright/test'
import { ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD, signIn } from './signin'
import { createAndOpenFolder } from './explorer'

test('selected items hand one ZIP download off to the browser', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const panel = page.getByRole('region', { name: '共享目录' })
  const dir = `ZIP-${Date.now()}`
  await createAndOpenFolder(page, dir)
  await panel.getByLabel('上传文件', {exact:true}).setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('ZIP bytes') })
  await expect(panel.getByRole('status', {name:'上传进度'})).toContainText('上传完成')
  const zipPanel = panel.getByRole('region', {name:'打包下载',exact:true})
  await panel.getByRole('checkbox', {name:'hello.txt'}).check()
  const pending = page.waitForEvent('download')
  await zipPanel.getByRole('button', {name:'打包下载所选项目'}).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('download.zip')
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks)
  expect(bytes.subarray(0,4)).toEqual(Buffer.from([0x50,0x4b,3,4]))
  expect(bytes.includes(Buffer.from(`${dir}/hello.txt`))).toBe(true)
  expect(bytes.includes(Buffer.from('ZIP bytes'))).toBe(true)
  await expect(zipPanel.getByRole('alert')).toHaveCount(0)
  await expect(zipPanel.getByRole('status')).toHaveText('已交给浏览器下载')
})
