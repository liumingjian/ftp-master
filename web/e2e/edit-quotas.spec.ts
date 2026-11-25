import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { openManagementPage } from './explorer'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('Desktop text editor and Office Plugin enforce quotas, preserve unsaved text, allow preview, and record failed audits', async ({ page }) => {
  const suffix = Date.now().toString()
  const orgName = `EditQuotaOrg-${suffix}`
  const dirName = `EditQuotaDir-${suffix}`
  const cappedUser = `edq-capped-${suffix}`
  const poolUser = `edq-pool-${suffix}`
  const userPass = 'QuotaEditPass123!'

  const docxBytes = await readFile(new URL('./fixtures/office.docx', import.meta.url))
  const editedDocxBytes = await readFile(new URL('./fixtures/office-edited.docx', import.meta.url))
  const editedMd5 = createHash('md5').update(editedDocxBytes).digest('hex')

  const signInAndWait = async (username: string, password: string) => {
    await page.goto('/sign-in')
    await signIn(page, username, password)
    await expect(page.getByRole('region', { name: '共享目录' })).toBeVisible()
  }

  // 1. Admin creates isolated Organization, cappedUser, poolUser, and shared folder.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.setAttribute('data-ftp-office-plugin', '0.1.0')
      document.documentElement.setAttribute('data-ftp-office-preview', '1')
    })
  })
  await signInAndWait(ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)

  const initialCappedQuota = 100
  const poolSize = 80
  const orgRes = await page.request.post('/api/organizations', {
    data: { name: orgName, quotaBytes: initialCappedQuota + poolSize },
  })
  expect(orgRes.status()).toBe(201)
  const org = (await orgRes.json()) as { id: number }

  const csv = [
    'username,display_name,password,organization_id',
    `${cappedUser},Capped Editor,${userPass},${org.id}`,
    `${poolUser},Pool Editor,${userPass},${org.id}`,
  ].join('\n')
  expect((await page.request.post('/api/users/import', { data: { csv } })).status()).toBe(201)

  const usersRes = await page.request.get('/api/managed-users')
  expect(usersRes.status()).toBe(200)
  const managedUsers = (await usersRes.json()) as { id: number; username: string }[]
  const cappedId = managedUsers.find(u => u.username === cappedUser)?.id
  expect(cappedId).toBeTruthy()
  expect((await page.request.put(`/api/users/${cappedId}/quota`, { data: { quotaBytes: initialCappedQuota } })).status()).toBe(200)

  const dirRes = await page.request.post('/api/tree', { data: { name: dirName } })
  expect(dirRes.status()).toBe(201)
  const dir = (await dirRes.json()) as { id: number }
  expect((await page.request.post(`/api/tree/${dir.id}/grants`, {
    data: { principalKind: 'organization', principalId: org.id, rights: 63, scope: 'subtree' },
  })).status()).toBe(201)

  // Admin uploads report.docx (owned by admin in Org 1, does not consume EditQuotaOrg quota).
  const uploadRaw = async (name: string, bytes: Buffer) => {
    const initRes = await page.request.post('/api/uploads', {
      data: { parentId: dir.id, name, size: bytes.length },
    })
    expect(initRes.status()).toBe(201)
    const sess = (await initRes.json()) as { id: string }
    const partsRes = await page.request.post(`/api/uploads/${sess.id}/parts`, {
      data: { numbers: [1] },
    })
    expect(partsRes.status()).toBe(200)
    const parts = (await partsRes.json()) as { url: string }[]
    expect((await page.request.put(parts[0].url, { data: bytes })).status()).toBe(200)
    expect((await page.request.post(`/api/uploads/${sess.id}/complete`)).status()).toBe(200)
  }
  await uploadRaw('report.docx', docxBytes)

  // Sign in as cappedUser and upload a 60-byte text file -> 40 B remaining (< 60 B file size!).
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await signInAndWait(cappedUser, userPass)
  await uploadRaw('notes.txt', Buffer.from('a'.repeat(60)))

  const panel = page.getByRole('region', { name: '共享目录' })
  await panel.getByRole('button', { name: dirName, exact: true }).click()
  await expect(panel.getByRole('button', { name: 'notes.txt', exact: true })).toBeVisible()

  // 2. Open built-in text editor with tight headroom (40 B < 60 B) -> gentle non-blocking warning shown.
  await panel.getByRole('button', { name: 'notes.txt', exact: true }).click()
  await page.getByRole('button', { name: '编辑文本', exact: true }).click()
  const editorDialog = page.getByRole('dialog', { name: 'notes.txt' })
  const textarea = editorDialog.getByLabel('文本内容')
  await expect(textarea).toHaveValue('a'.repeat(60))
  await expect(editorDialog.getByRole('status')).toContainText('剩余可用配额（40 B）小于当前文件大小（60 B）')

  // 3. Attempting to save 45 UTF-8 bytes fails with 507, shows Chinese refusal banner, and preserves unsaved buffer!
  const overContent = '中文测试内容一二三四五六七八九' // 45 UTF-8 bytes
  await textarea.fill(overContent)
  await editorDialog.getByRole('button', { name: '保存文本', exact: true }).click()
  const errorAlert = editorDialog.getByRole('alert')
  await expect(errorAlert).toBeVisible()
  await expect(errorAlert).toContainText('个人存储配额')
  await expect(errorAlert).toContainText('40 B')
  await expect(errorAlert).toContainText('45 B')
  await expect(errorAlert).toContainText('修改仍保留在编辑器中')
  await expect(textarea).toHaveValue(overContent)

  // 4. Trimming buffer to 30 UTF-8 bytes clears the tight-quota warning and saves successfully!
  const fitContent = '精简内容一二三四五六' // 30 UTF-8 bytes <= 40 B
  await textarea.fill(fitContent)
  await expect(editorDialog.getByText('剩余可用配额')).toHaveCount(0)
  await editorDialog.getByRole('button', { name: '保存文本', exact: true }).click()
  await expect(editorDialog.getByRole('status').filter({ hasText: '已保存为新版本' })).toBeVisible()

  await editorDialog.getByRole('button', { name: '关闭编辑', exact: true }).click()
  await page.getByRole('button', { name: '关闭文件查看', exact: true }).click()

  // 5. Admin lowers cappedUser's quota to 50 B (over quota: 90/50 => 0 B available).
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await signInAndWait(ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  expect((await page.request.put(`/api/users/${cappedId}/quota`, { data: { quotaBytes: 50 } })).status()).toBe(200)

  // Sign back in as cappedUser -> blocked text open shows clear Chinese explanation!
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await signInAndWait(cappedUser, userPass)
  await panel.getByRole('button', { name: dirName, exact: true }).click()
  await panel.getByRole('button', { name: '编辑文本 notes.txt', exact: true }).click()
  const blockedDialog = page.getByRole('dialog', { name: 'notes.txt' })
  await expect(blockedDialog.getByRole('alert')).toContainText('暂无法打开编辑')
  await expect(blockedDialog.getByRole('alert')).toContainText('个人存储配额不足')
  await expect(blockedDialog.getByRole('alert')).toContainText('0 B')
  await blockedDialog.getByRole('button', { name: '关闭', exact: true }).click()

  // 6. Over-quota cappedUser: WPS write-mode edit start returns 507 while read-only Office preview stays 201!
  const officeEditLink = panel.getByRole('link', { name: '在线编辑 report.docx', exact: true })
  const officePreviewLink = panel.getByRole('link', { name: 'report.docx', exact: true })
  await expect(officeEditLink).toBeVisible()
  await expect(officePreviewLink).toHaveAttribute('data-ftp-office-preview', '1')

  await page.evaluate(() => {
    const win = window as typeof window & {
      officeStartBlocked?: Promise<{ status: number; body: Record<string, unknown> }>
      officePreviewResult?: Promise<{ status: number; hasSaveUrl: boolean; docStatus: number; docBytes: number }>
    }
    document.addEventListener('click', event => {
      const editAnchor = (event.target as Element).closest<HTMLAnchorElement>('a[data-ftp-office-edit="1"]')
      if (editAnchor && editAnchor.origin === location.origin) {
        event.preventDefault()
        win.officeStartBlocked = (async () => {
          const res = await fetch(editAnchor.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ versionId: Number(editAnchor.dataset.ftpOfficeVersion) }),
          })
          return { status: res.status, body: await res.json() }
        })()
        return
      }
      const previewAnchor = (event.target as Element).closest<HTMLAnchorElement>('a[data-ftp-office-preview="1"]')
      if (previewAnchor && previewAnchor.origin === location.origin) {
        event.preventDefault()
        win.officePreviewResult = (async () => {
          const res = await fetch(previewAnchor.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ versionId: Number(previewAnchor.dataset.ftpOfficeVersion), preview: true }),
          })
          const permit = await res.json()
          const doc = await fetch(permit.documentUrl, { credentials: 'omit', redirect: 'error' })
          const buf = await doc.arrayBuffer()
          return { status: res.status, hasSaveUrl: 'saveUrl' in permit, docStatus: doc.status, docBytes: buf.byteLength }
        })()
      }
    }, true)
  })

  await officeEditLink.click()
  const blockedStart = await page.evaluate(async () => (window as typeof window & { officeStartBlocked: Promise<any> }).officeStartBlocked)
  expect(blockedStart.status).toBe(507)
  expect(blockedStart.body.code).toBe('quota_exceeded')
  expect(blockedStart.body.scope).toBe('user')
  expect(blockedStart.body.message).toContain('个人存储配额')

  await officePreviewLink.click()
  const previewRes = await page.evaluate(async () => (window as typeof window & { officePreviewResult: Promise<any> }).officePreviewResult)
  expect(previewRes.status).toBe(201)
  expect(previewRes.hasSaveUrl).toBe(false)
  expect(previewRes.docStatus).toBe(200)
  expect(previewRes.docBytes).toBe(docxBytes.length)

  // 6b. When Office editing is disabled, opening report.docx in FileViewer must NOT display a false save-quota warning.
  await page.evaluate(() => document.documentElement.removeAttribute('data-ftp-office-preview'))
  await panel.getByRole('button', { name: 'report.docx', exact: true }).click()
  await expect(page.locator('.viewer-quota-warning')).toBeVisible()
  await page.getByRole('button', { name: '关闭文件查看', exact: true }).click()

  await page.route('**/api/office-edit-policy', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false }) }),
  )
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(panel.getByRole('link', { name: '在线编辑 report.docx', exact: true })).toHaveCount(0)
    await panel.getByRole('button', { name: 'report.docx', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'report.docx' })).toBeVisible()
    await expect(page.locator('.viewer-quota-warning')).toHaveCount(0)
    await page.getByRole('button', { name: '关闭文件查看', exact: true }).click()
  } finally {
    await page.unroute('**/api/office-edit-policy')
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-ftp-office-preview', '1')
      window.dispatchEvent(new Event('focus'))
    })
  }

  // 7. Admin raises org & cappedUser quotas to leave positive headroom smaller than editedDocxBytes.length (90 used, leave editedDocxBytes.length - 10).
  // Also keep poolSize = 80 so poolUser can test org-pool blocked text open afterwards.
  const tightCappedQuota = 90 + editedDocxBytes.length - 10
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await signInAndWait(ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  expect((await page.request.patch(`/api/organizations/${org.id}`, {
    data: { name: orgName, quotaBytes: tightCappedQuota + poolSize },
  })).status()).toBe(200)
  expect((await page.request.put(`/api/users/${cappedId}/quota`, {
    data: { quotaBytes: tightCappedQuota },
  })).status()).toBe(200)

  // Sign in as cappedUser -> Office edit starts & delivers, then WPS save returns HTTP 507 with exact WPS receipt!
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await signInAndWait(cappedUser, userPass)
  await panel.getByRole('button', { name: dirName, exact: true }).click()

  const saveEditLink = panel.getByRole('link', { name: '在线编辑 report.docx', exact: true })
  await expect(saveEditLink).toBeVisible()
  await page.evaluate(({ content, md5 }) => {
    const win = window as typeof window & { officeSaveRefusal?: Promise<{ startStatus: number; saveStatus: number; receipt: Record<string, unknown> }> }
    document.addEventListener('click', event => {
      const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[data-ftp-office-edit="1"]')
      if (!anchor || anchor.origin !== location.origin) return
      event.preventDefault()
      win.officeSaveRefusal = (async () => {
        const start = await fetch(anchor.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ versionId: Number(anchor.dataset.ftpOfficeVersion) }),
        })
        const permit = await start.json()
        const gateway = await fetch(permit.documentUrl, { credentials: 'omit', redirect: 'error' })
        await gateway.arrayBuffer()
        const body = new FormData()
        body.append('filedata', new Blob([new Uint8Array(content)]), 'report.docx')
        body.append('filename', 'report.docx')
        body.append('md5sum', md5)
        const save = await fetch(permit.saveUrl, { method: 'POST', body })
        return { startStatus: start.status, saveStatus: save.status, receipt: await save.json() }
      })()
    }, true)
  }, { content: Array.from(editedDocxBytes), md5: editedMd5 })

  await saveEditLink.click()
  const saveRefusal = await page.evaluate(async () => (window as typeof window & { officeSaveRefusal: Promise<any> }).officeSaveRefusal)
  expect(saveRefusal.startStatus).toBe(201)
  expect(saveRefusal.saveStatus).toBe(507)
  expect(saveRefusal.receipt.Success).toBe(false)
  expect(saveRefusal.receipt.Data).toBeNull()
  expect(String(saveRefusal.receipt.Message)).toContain('个人存储配额')

  // Verify report.docx still has only 1 version in the desktop UI.
  await panel.getByRole('button', { name: '更多操作 report.docx', exact: true }).click()
  await page.getByRole('menu', { name: '操作 report.docx' }).getByRole('menuitem', { name: '版本历史', exact: true }).click()
  const versionsRegion = page.getByRole('region', { name: '文件版本' })
  await expect(versionsRegion.getByRole('listitem')).toHaveCount(1)

  // 8. Uncapped poolUser fills EditQuotaOrg's 80 B pool -> blocked text open attributes to Organization unallocated pool!
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await signInAndWait(poolUser, userPass)
  await uploadRaw('pool-fill.bin', Buffer.alloc(poolSize, 77))
  await panel.getByRole('button', { name: dirName, exact: true }).click()
  await panel.getByRole('button', { name: '编辑文本 notes.txt', exact: true }).click()
  const poolBlockedDialog = page.getByRole('dialog', { name: 'notes.txt' })
  await expect(poolBlockedDialog.getByRole('alert')).toContainText(orgName)
  await expect(poolBlockedDialog.getByRole('alert')).toContainText('未分配配额池')
  await poolBlockedDialog.getByRole('button', { name: '关闭', exact: true }).click()

  // 9. Administrator verifies failed text_save and office_save Audit Events in the desktop Audit Log UI.
  expect((await page.request.delete('/api/session')).status()).toBe(204)
  await signInAndWait(ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await openManagementPage(page, '审计日志')

  const auditPanel = page.getByRole('region', { name: '审计记录' })
  const toolbar = auditPanel.getByRole('group', { name: '审计筛选' })
  await expect(auditPanel.getByRole('status')).toContainText('条记录')

  // Check failed text_save audit
  await toolbar.getByRole('button', { name: '更多筛选', exact: true }).click()
  const filterDialog = page.getByRole('dialog', { name: '筛选审计日志' })
  await filterDialog.getByRole('combobox', { name: '精确操作', exact: true }).selectOption('text_save')
  await filterDialog.getByLabel('只看失败').check()
  await filterDialog.getByRole('button', { name: '应用筛选', exact: true }).click()

  const textAuditRow = auditPanel.getByRole('row').filter({ hasText: 'notes.txt' }).filter({ hasText: cappedUser }).first()
  await expect(textAuditRow).toContainText('失败')
  await textAuditRow.getByRole('button', { name: '查看详情' }).click()
  const details = auditPanel.getByRole('complementary', { name: '审计详情' })
  await expect(details).toContainText('超出存储配额')
  await expect(details).toContainText('用户配额')
  await expect(details).toContainText('45 B')
  await expect(details).toContainText('40 B')

  // Check failed office_save audit
  await toolbar.getByRole('button', { name: '更多筛选', exact: true }).click()
  await filterDialog.getByRole('combobox', { name: '精确操作', exact: true }).selectOption('office_save')
  await filterDialog.getByLabel('只看失败').check()
  await filterDialog.getByRole('button', { name: '应用筛选', exact: true }).click()

  const officeAuditRow = auditPanel.getByRole('row').filter({ hasText: 'report.docx' }).filter({ hasText: cappedUser }).first()
  await expect(officeAuditRow).toContainText('失败')
  await officeAuditRow.getByRole('button', { name: '查看详情' }).click()
  await expect(details).toContainText('超出存储配额')
  await expect(details).toContainText('用户配额')
})
