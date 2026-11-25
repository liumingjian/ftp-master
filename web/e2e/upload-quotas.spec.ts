import { expect, test } from '@playwright/test'
import { openManagementPage } from './explorer'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('Desktop upload UI surfaces 507 quota refusals, releases reserved quota on cancel, and shows failed quota audits', async ({ page }) => {
  const suffix = Date.now().toString()
  const orgName = `UploadQuotaOrg-${suffix}`
  const dirName = `UploadQuotaDir-${suffix}`
  const cappedUser = `upq-capped-${suffix}`
  const poolUser = `upq-pool-${suffix}`
  const userPass = 'QuotaUploadPass123!'
  const MB = 1024 * 1024

  // 1. Admin creates isolated Organization (12 MB), two Users (capped 10 MB + uncapped sharing 2 MB pool), and a shared folder.
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await expect(page.getByRole('region', { name: '共享目录' })).toBeVisible()

  const orgRes = await page.request.post('/api/organizations', {
    data: { name: orgName, quotaBytes: 12 * MB },
  })
  expect(orgRes.status()).toBe(201)
  const org = (await orgRes.json()) as { id: number }

  const csv = [
    'username,display_name,password,organization_id',
    `${cappedUser},Capped Uploader,${userPass},${org.id}`,
    `${poolUser},Pool Uploader,${userPass},${org.id}`,
  ].join('\n')
  expect((await page.request.post('/api/users/import', { data: { csv } })).status()).toBe(201)

  const usersRes = await page.request.get('/api/managed-users')
  expect(usersRes.status()).toBe(200)
  const managedUsers = (await usersRes.json()) as { id: number; username: string }[]
  const cappedId = managedUsers.find(u => u.username === cappedUser)?.id
  expect(cappedId).toBeTruthy()

  expect((await page.request.put(`/api/users/${cappedId}/quota`, { data: { quotaBytes: 10 * MB } })).status()).toBe(200)

  const dirRes = await page.request.post('/api/tree', { data: { name: dirName } })
  expect(dirRes.status()).toBe(201)
  const dir = (await dirRes.json()) as { id: number }

  expect((await page.request.post(`/api/tree/${dir.id}/grants`, {
    data: { principalKind: 'organization', principalId: org.id, rights: 63, scope: 'subtree' },
  })).status()).toBe(201)

  // Sign out admin and sign in as cappedUser.
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await page.goto('/sign-in')
  await signIn(page, cappedUser, userPass)

  const panel = page.getByRole('region', { name: '共享目录' })
  await panel.getByRole('button', { name: dirName, exact: true }).click()
  await expect(panel.getByRole('table', { name: '文件列表' })).toBeVisible()

  const fileStatus = panel.getByRole('status', { name: '上传进度', exact: true })
  const folderStatus = panel.getByRole('status', { name: '文件夹上传进度', exact: true })

  // 2. Single-file upload exceeding User Quota fails with 507 before any part transfer and leaves zero stale localStorage.
  const partRequests: string[] = []
  page.on('request', req => {
    if (req.method() === 'PUT' && /\/api\/uploads\/[^/]+\/parts\/\d+$/.test(new URL(req.url()).pathname)) {
      partRequests.push(req.url())
    }
  })

  await panel.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: 'too-big.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(11 * MB, 65),
  })
  await expect(fileStatus).toBeVisible()
  await expect(fileStatus).toHaveClass(/is-error/)
  await expect(fileStatus).toContainText('too-big.bin')
  await expect(fileStatus).toContainText('个人存储配额')
  await expect(fileStatus).toContainText('10 MB')
  await expect(fileStatus).toContainText('11 MB')
  expect(partRequests).toEqual([])
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ftp-upload:')))).toEqual([])

  await fileStatus.getByRole('button', { name: '取消上传', exact: true }).click()
  await expect(fileStatus).toHaveCount(0)

  // 3. Folder upload batch exceeding User Quota fails atomically with 507 without progress bar or stale localStorage.
  await panel.getByRole('table', { name: '文件列表' }).evaluate((table, mb) => {
    const directory = (name: string, children: unknown[]) => ({
      name,
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let read = false
        return { readEntries: (done: (entries: unknown[]) => void) => { done(read ? [] : children); read = true } }
      },
    })
    const f1 = { name: 'part1.bin', isFile: true, isDirectory: false, file: (done: (file: File) => void) => done(new File([new Uint8Array(6 * mb)], 'part1.bin')) }
    const f2 = { name: 'part2.bin', isFile: true, isDirectory: false, file: (done: (file: File) => void) => done(new File([new Uint8Array(5 * mb)], 'part2.bin')) }
    const root = directory('OversizedBatch', [f1, directory('sub', [f2])])
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { items: [{ webkitGetAsEntry: () => root }] } })
    table.dispatchEvent(event)
  }, MB)

  await expect(folderStatus).toBeVisible()
  await expect(folderStatus).toHaveClass(/is-error/)
  await expect(folderStatus).toContainText('OversizedBatch')
  await expect(folderStatus).toContainText('个人存储配额')
  await expect(folderStatus).toContainText('10 MB')
  await expect(folderStatus).toContainText('11 MB')
  await expect(folderStatus.getByRole('progressbar')).toHaveCount(0)
  expect(partRequests).toEqual([])
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ftp-folder:')))).toEqual([])
  await expect(panel.getByRole('button', { name: 'OversizedBatch', exact: true })).toHaveCount(0)

  await folderStatus.getByRole('button', { name: '取消上传', exact: true }).click()
  await expect(folderStatus).toHaveCount(0)

  // 4. Active 9 MB upload reserves quota; cancelling immediately frees quota so a 2 MB upload succeeds.
  let releasePart!: () => void
  const gate = new Promise<void>(resolve => { releasePart = resolve })
  const secondPartStarted = page.waitForRequest(req =>
    req.method() === 'PUT' && /\/api\/uploads\/[^/]+\/parts\/2$/.test(new URL(req.url()).pathname),
  )
  await page.route('**/api/uploads/*/parts/2', async route => {
    await gate
    await route.continue().catch(() => {})
  })
  try {
    await panel.getByLabel('上传文件', { exact: true }).setInputFiles({
      name: 'hold-quota.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(9 * MB, 66),
    })
    await secondPartStarted

    // While 9 MB is reserved, a 2 MB initiation is rejected with 507 (only 1 MB left).
    const blockedRes = await page.request.post('/api/uploads', {
      data: { parentId: dir.id, name: 'blocked-while-active.bin', size: 2 * MB },
    })
    expect(blockedRes.status()).toBe(507)
    const blockedBody = (await blockedRes.json()) as { code: string; scope: string; availableBytes: number }
    expect(blockedBody.code).toBe('quota_exceeded')
    expect(blockedBody.scope).toBe('user')
    expect(blockedBody.availableBytes).toBe(1 * MB)

    const cancelResp = page.waitForResponse(res =>
      res.request().method() === 'DELETE' && /\/api\/uploads\/[^/]+$/.test(new URL(res.url()).pathname),
    )
    await fileStatus.getByRole('button', { name: '取消上传', exact: true }).click()
    expect((await cancelResp).status()).toBe(204)
    await expect(fileStatus).toHaveCount(0)
  } finally {
    releasePart()
    await page.unroute('**/api/uploads/*/parts/2')
  }

  // Immediately after cancelling, uploading 2 MB succeeds!
  await panel.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: 'after-cancel.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(2 * MB, 67),
  })
  await expect(fileStatus).toContainText('上传完成', { timeout: 60000 })
  await expect(panel.getByRole('button', { name: 'after-cancel.bin', exact: true })).toBeVisible()

  // 5. Uncapped peer in the same Organization is bounded by the isolated 2 MB unallocated pool.
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await page.goto('/sign-in')
  await signIn(page, poolUser, userPass)
  await panel.getByRole('button', { name: dirName, exact: true }).click()

  await panel.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: 'pool-exceed.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(3 * MB, 68),
  })
  await expect(fileStatus).toBeVisible()
  await expect(fileStatus).toHaveClass(/is-error/)
  await expect(fileStatus).toContainText(orgName)
  await expect(fileStatus).toContainText('未分配配额池')
  await expect(fileStatus).toContainText('2 MB')
  await expect(fileStatus).toContainText('3 MB')
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ftp-upload:')))).toEqual([])

  // 6. Administrator verifies failed upload quota_exceeded events render cleanly in the desktop Audit Log.
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await openManagementPage(page, '审计日志')

  const auditPanel = page.getByRole('region', { name: '审计记录' })
  const toolbar = auditPanel.getByRole('group', { name: '审计筛选' })
  await expect(auditPanel.getByRole('status')).toContainText('条记录')

  await toolbar.getByRole('button', { name: '更多筛选', exact: true }).click()
  const filterDialog = page.getByRole('dialog', { name: '筛选审计日志' })
  await filterDialog.getByRole('combobox', { name: '精确操作', exact: true }).selectOption('upload')
  await filterDialog.getByLabel('只看失败').check()
  await filterDialog.getByRole('button', { name: '应用筛选', exact: true }).click()

  const poolRow = auditPanel.getByRole('row').filter({ hasText: 'pool-exceed.bin' }).first()
  await expect(poolRow).toContainText('失败')
  await expect(poolRow).toContainText(poolUser)
  await poolRow.getByRole('button', { name: '查看详情' }).click()

  const details = auditPanel.getByRole('complementary', { name: '审计详情' })
  await expect(details).toContainText('原因')
  await expect(details).toContainText('超出存储配额')
  await expect(details).toContainText('作用范围')
  await expect(details).toContainText('组织未分配配额池')
  await expect(details).toContainText('受限组织')
  await expect(details).toContainText(orgName)
  await expect(details).toContainText('本次需要空间')
  await expect(details).toContainText('3 MB')
  await expect(details).toContainText('当前可用空间')
  await expect(details).toContainText('2 MB')

  const singleRow = auditPanel.getByRole('row').filter({ hasText: 'too-big.bin' }).first()
  await expect(singleRow).toContainText('失败')
  await singleRow.getByRole('button', { name: '查看详情' }).click()
  await expect(details).toContainText('用户配额')
  await expect(details).toContainText('11 MB')
  await expect(details).toContainText('10 MB')

  const batchRow = auditPanel.getByRole('row').filter({ hasText: 'OversizedBatch' }).first()
  await expect(batchRow).toContainText('失败')
  await batchRow.getByRole('button', { name: '查看详情' }).click()
  await expect(details).toContainText('超出存储配额')
  await expect(details).toContainText('用户配额')
  await expect(details).toContainText('11 MB')
  await expect(details).toContainText('10 MB')
})
