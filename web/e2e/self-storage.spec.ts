import { expect, test } from '@playwright/test'
import { openAccountPage } from './explorer'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('Self-service storage sidebar bar, Account Settings breakdown, pending upload cleanup, and live refresh', async ({ page }) => {
  const suffix = Date.now().toString()
  const unlimitedOrgName = `SelfUnlimitedOrg-${suffix}`
  const cappedOrgName = `SelfCappedOrg-${suffix}`
  const dirName = `SelfStorageDir-${suffix}`
  const unlimitedUser = `ss-free-${suffix}`
  const cappedUser = `ss-capped-${suffix}`
  const poolUser = `ss-pool-${suffix}`
  const userPass = 'SelfStoragePass123!'
  const KB = 1024
  const MB = 1024 * 1024

  // 1. Administrator provisions isolated Organizations, Users, quotas, and shared directory.
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await expect(page.getByRole('region', { name: '共享目录' })).toBeVisible()

  const freeOrgRes = await page.request.post('/api/organizations', {
    data: { name: unlimitedOrgName },
  })
  expect(freeOrgRes.status()).toBe(201)
  const freeOrg = (await freeOrgRes.json()) as { id: number }

  const cappedOrgRes = await page.request.post('/api/organizations', {
    data: { name: cappedOrgName, quotaBytes: 12 * MB },
  })
  expect(cappedOrgRes.status()).toBe(201)
  const cappedOrg = (await cappedOrgRes.json()) as { id: number }

  const csv = [
    'username,display_name,password,organization_id',
    `${unlimitedUser},Unlimited User,${userPass},${freeOrg.id}`,
    `${cappedUser},Capped User,${userPass},${cappedOrg.id}`,
    `${poolUser},Pool User,${userPass},${cappedOrg.id}`,
  ].join('\n')
  expect((await page.request.post('/api/users/import', { data: { csv } })).status()).toBe(201)

  const usersRes = await page.request.get('/api/managed-users')
  expect(usersRes.status()).toBe(200)
  const managedUsers = (await usersRes.json()) as { id: number; username: string }[]
  const cappedId = managedUsers.find(u => u.username === cappedUser)?.id
  const poolId = managedUsers.find(u => u.username === poolUser)?.id
  expect(cappedId).toBeTruthy()
  expect(poolId).toBeTruthy()

  // Allocate 10 MB to cappedUser -> leaves 2 MB isolated unallocated pool for poolUser.
  expect((await page.request.put(`/api/users/${cappedId}/quota`, { data: { quotaBytes: 10 * MB } })).status()).toBe(200)

  const dirRes = await page.request.post('/api/tree', { data: { name: dirName } })
  expect(dirRes.status()).toBe(201)
  const dir = (await dirRes.json()) as { id: number }

  for (const orgId of [freeOrg.id, cappedOrg.id]) {
    expect((await page.request.post(`/api/tree/${dir.id}/grants`, {
      data: { principalKind: 'organization', principalId: orgId, rights: 63, scope: 'subtree' },
    })).status()).toBe(201)
  }

  // 2. Unlimited User: sidebar storage bar stays hidden; Account Settings shows subtle used bytes + unlimited status.
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await page.goto('/sign-in')
  await signIn(page, unlimitedUser, userPass)

  const panel = page.getByRole('region', { name: '共享目录' })
  await panel.getByRole('button', { name: dirName, exact: true }).click()
  await expect(panel.getByRole('table', { name: '文件列表' })).toBeVisible()

  await expect(page.locator('.sidebar-storage')).toHaveCount(0)

  const fileStatus = panel.getByRole('status', { name: '上传进度', exact: true })
  await panel.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: 'free-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(512, 'a'),
  })
  await expect(fileStatus).toContainText('上传完成', { timeout: 30000 })
  await expect(page.locator('.sidebar-storage')).toHaveCount(0)

  await openAccountPage(page, '账户设置')
  const storageCard = page.getByRole('region', { name: '存储配额与待完成上传' })
  await expect(storageCard).toBeVisible()
  await expect(storageCard).toContainText('不限')
  await expect(storageCard).toContainText('512 B')
  await expect(storageCard.getByLabel('约束组织存储状态')).toHaveCount(0)
  await expect(storageCard).toContainText('暂无未完成的上传任务')

  // 3. Capped User: sidebar normal -> text edit live refresh -> >=85% warning -> >=100% over-quota -> direct link to Account Settings -> cancel pending single & folder batch.
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await page.goto('/sign-in')
  await signIn(page, cappedUser, userPass)

  await panel.getByRole('button', { name: dirName, exact: true }).click()
  await expect(panel.getByRole('table', { name: '文件列表' })).toBeVisible()

  const sidebarBar = page.locator('.sidebar-storage')
  await expect(sidebarBar).toBeVisible()
  await expect(sidebarBar).toHaveAttribute('data-storage-tone', 'normal')
  await expect(sidebarBar).toContainText('0 B / 10 MB')

  // Sidebar collapse hides the storage bar cleanly and expanding restores it.
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  await expect(sidebarBar).toHaveCount(0)
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
  await expect(sidebarBar).toBeVisible()

  // Upload a small text file -> sidebar refreshes live without page reload.
  await panel.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: 'memo.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(512, 'm'),
  })
  await expect(fileStatus).toContainText('上传完成', { timeout: 30000 })
  await expect(sidebarBar).toContainText('512 B / 10 MB')

  // Edit text file via built-in TextEditor -> sidebar refreshes live after save (512 B + 2048 B = 2.5 KB).
  const memoRow = panel.getByRole('row').filter({ hasText: 'memo.txt' }).first()
  await memoRow.getByRole('button', { name: '编辑文本 memo.txt', exact: true }).click()
  const editorDialog = page.getByRole('dialog')
  await expect(editorDialog).toBeVisible()
  await editorDialog.getByLabel('文本内容').fill('x'.repeat(2 * KB))
  await editorDialog.getByRole('button', { name: '保存文本', exact: true }).click()
  await expect(editorDialog.getByRole('status')).toContainText('已保存为新版本')
  await editorDialog.getByRole('button', { name: '关闭编辑', exact: true }).click()
  await expect(sidebarBar).toContainText('2.5 KB / 10 MB')

  // Upload 8.5 MB file -> hits >=85% threshold -> sidebar switches LIVE to warning styling!
  await panel.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: 'bulk.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(Math.round(8.5 * MB), 77),
  })
  await expect(fileStatus).toContainText('上传完成', { timeout: 60000 })
  await expect(sidebarBar).toHaveAttribute('data-storage-tone', 'warning')
  await expect(sidebarBar).toContainText('将满')
  await expect(sidebarBar).toContainText('8.5 MB / 10 MB')

  // Create a pending single-file upload (1 MB) and an unrevealed folder batch (2 files, 512 KB total)
  // plus matching localStorage resume entries so total usage reaches 100% (>=100% over-quota)!
  const pendingUploadRes = await page.request.post('/api/uploads', {
    data: { parentId: dir.id, name: 'stuck-single.bin', size: 1 * MB },
  })
  expect(pendingUploadRes.status()).toBe(201)
  const pendingUpload = (await pendingUploadRes.json()) as { id: string; partSize: number; partCount: number }

  const pendingBatchRes = await page.request.post('/api/upload-batches', {
    data: {
      parentId: dir.id,
      name: 'StuckFolder',
      files: [
        { path: 'a.bin', size: 256 * KB },
        { path: 'sub/b.bin', size: 253 * KB + 512 },
      ],
    },
  })
  expect(pendingBatchRes.status()).toBe(201)
  const pendingBatchSessions = (await pendingBatchRes.json()) as { id: string; partSize: number; partCount: number; batchId: string }[]
  const pendingBatchId = pendingBatchSessions[0]!.batchId

  await page.evaluate(({ parentId, upload, batchId, sessions, kb, mb }) => {
    localStorage.setItem(`ftp-upload:${parentId}`, JSON.stringify({
      ...upload,
      name: 'stuck-single.bin',
      size: mb,
    }))
    localStorage.setItem(`ftp-folder:${parentId}`, JSON.stringify({
      batchId,
      name: 'StuckFolder',
      files: [
        { ...sessions[0], path: 'a.bin', size: 256 * kb },
        { ...sessions[1], path: 'sub/b.bin', size: 253 * kb + 512 },
      ],
    }))
  }, { parentId: dir.id, upload: pendingUpload, batchId: pendingBatchId, sessions: pendingBatchSessions, kb: KB, mb: MB })

  // Reload to observe the >=100% sidebar state immediately from /me/storage.
  await page.reload()
  await expect(sidebarBar).toBeVisible()
  await expect(sidebarBar).toHaveAttribute('data-storage-tone', 'exceeded')
  await expect(sidebarBar).toContainText('已满')
  await expect(sidebarBar).toContainText('预占 2 项')

  // Click sidebar storage bar directly to navigate to Account Settings (?view=account).
  await sidebarBar.click()
  await expect(page).toHaveURL(/\?view=account/)
  await expect(storageCard).toBeVisible()
  await expect(storageCard.locator('.account-storage-meter')).toHaveAttribute('data-storage-tone', 'exceeded')
  await expect(storageCard).toContainText('已提交占用')
  await expect(storageCard).toContainText('8.5 MB')
  await expect(storageCard).toContainText('上传预占')
  await expect(storageCard).toContainText('1.5 MB')
  await expect(storageCard).toContainText('个人配额')
  await expect(storageCard).toContainText('10 MB')

  const orgBox = storageCard.getByLabel('约束组织存储状态')
  await expect(orgBox).toBeVisible()
  await expect(orgBox).toContainText(cappedOrgName)
  await expect(orgBox).toContainText('组织配额上限')
  await expect(orgBox).toContainText('12 MB')

  const pendingSection = storageCard.getByLabel('待完成上传')
  const singleRow = pendingSection.locator(`[data-pending-kind="upload"][data-pending-id="${pendingUpload.id}"]`)
  const batchRow = pendingSection.locator(`[data-pending-kind="batch"][data-pending-id="${pendingBatchId}"]`)
  await expect(singleRow).toContainText('stuck-single.bin')
  await expect(singleRow).toContainText('1 MB')
  await expect(batchRow).toContainText('StuckFolder')
  await expect(batchRow).toContainText('2 个文件')

  // Cancel the pending single-file upload from Account Settings -> immediately releases 1 MB and clears localStorage.
  const cancelSingleResp = page.waitForResponse(res =>
    res.request().method() === 'DELETE' && new URL(res.url()).pathname === `/api/uploads/${pendingUpload.id}`,
  )
  await singleRow.getByRole('button', { name: '取消上传', exact: true }).click()
  expect((await cancelSingleResp).status()).toBe(204)
  await expect(singleRow).toHaveCount(0)
  await expect(storageCard.locator('.account-storage-meter')).toHaveAttribute('data-storage-tone', 'warning')
  expect(await page.evaluate(parentId => localStorage.getItem(`ftp-upload:${parentId}`), dir.id)).toBeNull()

  // Cancel the unrevealed folder batch from Account Settings -> releases remaining 509 KB and clears localStorage.
  const cancelBatchResp = page.waitForResponse(res =>
    res.request().method() === 'DELETE' && new URL(res.url()).pathname === `/api/upload-batches/${pendingBatchId}`,
  )
  await batchRow.getByRole('button', { name: '取消上传', exact: true }).click()
  expect((await cancelBatchResp).status()).toBe(204)
  await expect(batchRow).toHaveCount(0)
  await expect(pendingSection).toContainText('暂无未完成的上传任务')
  expect(await page.evaluate(parentId => localStorage.getItem(`ftp-folder:${parentId}`), dir.id)).toBeNull()

  // Navigate back to files -> sidebar storage indicator immediately reflects updated warning state (8.5 MB / 10 MB, no pending reservations).
  await page.getByRole('button', { name: '返回文件', exact: true }).click()
  await expect(sidebarBar).toBeVisible()
  await expect(sidebarBar).toHaveAttribute('data-storage-tone', 'warning')
  await expect(sidebarBar).toContainText('8.5 MB / 10 MB')
  await expect(sidebarBar).not.toContainText('预占')

  // Live refresh when starting & cancelling an active upload directly from the file browser (without page reload).
  let releasePart!: () => void
  const gate = new Promise<void>(resolve => { releasePart = resolve })
  const partPutStarted = page.waitForRequest(req =>
    req.method() === 'PUT' && /\/api\/uploads\/[^/]+\/parts\/1$/.test(new URL(req.url()).pathname),
  )
  await page.route('**/api/uploads/*/parts/1', async route => {
    await gate
    await route.continue().catch(() => {})
  })
  try {
    await panel.getByLabel('上传文件', { exact: true }).setInputFiles({
      name: 'live-cancel.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(Math.round(1.4 * MB), 88),
    })
    await partPutStarted
    await expect(sidebarBar).toContainText('9.9 MB / 10 MB')
    await expect(sidebarBar).toContainText('预占 1 项')

    await fileStatus.getByRole('button', { name: '取消上传', exact: true }).click()
    await expect(fileStatus).toHaveCount(0)
    await expect(sidebarBar).toContainText('8.5 MB / 10 MB')
    await expect(sidebarBar).not.toContainText('预占')
  } finally {
    releasePart()
    await page.unroute('**/api/uploads/*/parts/1')
  }

  // 4. Uncapped User under Capped Org sees shared unallocated pool ceiling (2 MB) and zero-byte cap over-quota styling.
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await page.goto('/sign-in')
  await signIn(page, poolUser, userPass)

  await expect(sidebarBar).toBeVisible()
  await expect(sidebarBar).toHaveAttribute('data-storage-tone', 'normal')
  await expect(sidebarBar).toContainText('组织共享池')
  await expect(sidebarBar).toContainText('0 B / 2 MB')

  await sidebarBar.click()
  await expect(storageCard).toContainText('共享未分配配额池')
  await expect(storageCard).toContainText(cappedOrgName)
  await expect(storageCard).toContainText('0 B / 2 MB')

  // Admin lowers poolUser to 0-byte personal User Quota -> sidebar immediately renders over-quota (0 B / 0 B).
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await expect(page.getByRole('region', { name: '共享目录' })).toBeVisible()
  expect((await page.request.put(`/api/users/${poolId}/quota`, { data: { quotaBytes: 0 } })).status()).toBe(200)

  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await page.goto('/sign-in')
  await signIn(page, poolUser, userPass)
  await expect(sidebarBar).toBeVisible()
  await expect(sidebarBar).toHaveAttribute('data-storage-tone', 'exceeded')
  await expect(sidebarBar).toContainText('0 B / 0 B')
  await expect(sidebarBar).toContainText('已满')
})
