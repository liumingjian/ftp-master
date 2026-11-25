import { expect, test } from '@playwright/test'
import { openManagementPage } from './explorer'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('Administrator manages User Quotas, atomic org transfers, deactivated budget reclamation, and audit events', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await openManagementPage(page, '组织与用户组管理')

  const panel = page.getByRole('region', { name: '组织与用户组管理' })
  const dialog = page.getByRole('dialog')

  const suffix = Date.now().toString()
  const srcOrg = `UserQuotaSrc-${suffix}`
  const midOrg = `UserQuotaMid-${suffix}`
  const tightOrg = `UserQuotaTight-${suffix}`
  const aliceName = `uq-alice-${suffix}`
  const bobName = `uq-bob-${suffix}`

  // Create test organizations via API (keeps setup focused on User Quota UI flows).
  const createOrg = async (body: { name: string; parentId?: number | null; quotaBytes?: number | null }) => {
    const res = await page.request.post('/api/organizations', { data: body })
    expect(res.status()).toBe(201)
    return (await res.json()) as { id: number; name: string }
  }
  const GB = 1024 ** 3
  const src = await createOrg({ name: srcOrg, quotaBytes: 10 * GB })
  const mid = await createOrg({ name: midOrg, parentId: src.id })
  const tight = await createOrg({ name: tightOrg, quotaBytes: 3 * GB })

  // Import two fresh users via existing 4-column CSV format (defaulting quotaBytes to NULL).
  const csv = [
    'username,display_name,password,organization_id',
    `${aliceName},Alice Quota,UserQuotaPass123!,${mid.id}`,
    `${bobName},Bob Quota,UserQuotaPass123!,${tight.id}`,
  ].join('\n')
  const importRes = await page.request.post('/api/users/import', { data: { csv } })
  expect(importRes.status()).toBe(201)

  // Reload to reflect newly created orgs and users, then open the Users tab.
  await page.reload()
  await panel.getByRole('button', { name: '用户', exact: true }).click()
  const search = panel.getByRole('searchbox', { name: '搜索姓名、用户名或组织' })
  await search.fill(`uq-`)

  const userRow = (username: string) => panel.getByRole('row').filter({
    has: page.getByRole('button', { name: '管理用户 ' + username, exact: true }),
  })
  const manageUser = (username: string) => panel.getByRole('button', { name: '管理用户 ' + username, exact: true })

  // Newly imported users display 0 B / 不限.
  await expect(userRow(aliceName)).toContainText('0 B / 不限')
  await expect(userRow(bobName)).toContainText('0 B / 不限')

  const budget = dialog.getByRole('note', { name: '组织配额预算' })

  // 1. Open Alice under uncapped Mid -> constrained by Src (10 GB remaining).
  await manageUser(aliceName).click()
  await expect(budget).toContainText(`约束上级「${srcOrg}」剩余可分配 10 GB`)

  // Exceeding 10 GB is rejected (409) with Chinese error message.
  await dialog.getByLabel('存储配额', { exact: true }).fill('11')
  await dialog.getByLabel('配额单位', { exact: true }).selectOption('GB')
  await dialog.getByRole('button', { name: '保存变更', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(srcOrg)
  await expect(dialog.getByRole('alert')).toContainText('10 GB')

  // Set Alice to 6 GB -> succeeds.
  await dialog.getByLabel('存储配额', { exact: true }).fill('6')
  await dialog.getByRole('button', { name: '保存变更', exact: true }).click()
  await expect(userRow(aliceName)).toContainText('0 B / 6 GB')
  await expect(userRow(aliceName).getByRole('progressbar')).toBeVisible()

  // 2. Set Bob in TightOrg (3 GB) to 1 GB -> leaves 2 GB remaining.
  await manageUser(bobName).click()
  await expect(budget).toContainText(`所属组织「${tightOrg}」剩余可分配 3 GB`)
  await dialog.getByLabel('存储配额', { exact: true }).fill('1')
  await dialog.getByLabel('配额单位', { exact: true }).selectOption('GB')
  await dialog.getByRole('button', { name: '保存变更', exact: true }).click()
  await expect(userRow(bobName)).toContainText('0 B / 1 GB')

  // 3. Reopen Alice: verify dynamic remaining budget when switching Organization + atomic transfer & quota save.
  await manageUser(aliceName).click()
  await expect(budget).toContainText(`约束上级「${srcOrg}」剩余可分配 4 GB`)
  await expect(budget).toContainText('本用户可设上限 10 GB')

  // Select TightOrg -> live budget immediately updates to TightOrg's 2 GB remaining!
  await dialog.getByLabel('用户所属组织').selectOption({ label: tightOrg })
  await expect(budget).toContainText(`所属组织「${tightOrg}」剩余可分配 2 GB`)

  // Saving move while keeping 6 GB fails (409) and surfaces backend Chinese error.
  await dialog.getByRole('button', { name: '保存变更', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(tightOrg)
  await expect(dialog.getByRole('alert')).toContainText('2 GB')

  // Lowering Alice's quota to 2 GB and saving executes ONE atomic PUT /users/{id}/organization request.
  await dialog.getByLabel('存储配额', { exact: true }).fill('2')
  const atomicMove = page.waitForResponse(r => r.url().includes('/users/') && r.url().endsWith('/organization') && r.request().method() === 'PUT')
  await dialog.getByRole('button', { name: '保存变更', exact: true }).click()
  expect((await atomicMove).status()).toBe(204)

  await expect(userRow(aliceName)).toContainText(tightOrg)
  await expect(userRow(aliceName)).toContainText('0 B / 2 GB')

  // 4. Lowering TightOrg below allocated User Quotas (3 GB) is rejected (409).
  await panel.getByRole('button', { name: '组织', exact: true }).click()
  await panel.getByRole('button', { name: '编辑组织 ' + tightOrg, exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('下级已分配 3 GB')
  await dialog.getByLabel('存储配额', { exact: true }).fill('2')
  await dialog.getByRole('button', { name: '保存组织', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('3 GB')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  // 5. Deactivate Alice -> preserves User Quota (2 GB), then zero deactivated Alice's quota to reclaim budget for Bob.
  await panel.getByRole('button', { name: '用户', exact: true }).click()
  await search.fill(`uq-`)
  await manageUser(aliceName).click()
  await dialog.getByRole('button', { name: '停用用户', exact: true }).click()
  await dialog.getByRole('button', { name: '确认停用', exact: true }).click()
  await expect(userRow(aliceName)).toContainText('已停用')
  await expect(userRow(aliceName)).toContainText('0 B / 2 GB')

  // Zero deactivated Alice's quota -> displays 已禁写 and frees 2 GB in TightOrg.
  await manageUser(aliceName).click()
  await dialog.getByLabel('存储配额', { exact: true }).fill('0')
  await dialog.getByRole('button', { name: '保存变更', exact: true }).click()
  await expect(userRow(aliceName)).toContainText('0 B / 0 B')
  await expect(userRow(aliceName)).toContainText('已禁写')

  // Bob can now claim all 3 GB in TightOrg, then clear back to unlimited.
  await manageUser(bobName).click()
  await expect(budget).toContainText(`所属组织「${tightOrg}」剩余可分配 2 GB`)
  await expect(budget).toContainText('本用户可设上限 3 GB')
  await dialog.getByLabel('存储配额', { exact: true }).fill('3')
  await dialog.getByRole('button', { name: '保存变更', exact: true }).click()
  await expect(userRow(bobName)).toContainText('0 B / 3 GB')

  await manageUser(bobName).click()
  await dialog.getByRole('button', { name: '清除配额', exact: true }).click()
  await dialog.getByRole('button', { name: '保存变更', exact: true }).click()
  await expect(userRow(bobName)).toContainText('0 B / 不限')

  // 6. Verify User quota_change Audit Events appear in Audit Log under account category.
  await openManagementPage(page, '审计日志')
  const auditPanel = page.getByRole('region', { name: '审计记录' })
  const toolbar = auditPanel.getByRole('group', { name: '审计筛选' })
  await expect(auditPanel.getByRole('status')).toContainText('条记录')

  await toolbar.getByRole('combobox', { name: '操作类别' }).selectOption('account')
  await toolbar.getByRole('button', { name: '更多筛选', exact: true }).click()
  const filterDialog = page.getByRole('dialog', { name: '筛选审计日志' })
  await filterDialog.getByRole('combobox', { name: '精确操作', exact: true }).selectOption('quota_change')
  await filterDialog.getByRole('button', { name: '应用筛选', exact: true }).click()

  const bobAuditRow = auditPanel.getByRole('row').filter({ hasText: bobName }).first()
  await expect(bobAuditRow).toContainText('变更存储配额')
  await expect(bobAuditRow).toContainText(`用户 · ${bobName}`)
  await bobAuditRow.getByRole('button', { name: '查看详情' }).click()
  const details = auditPanel.getByRole('complementary', { name: '审计详情' })
  await expect(details).toContainText('配额对象类型')
  await expect(details).toContainText('用户')
  await expect(details).toContainText(bobName)
  await expect(details).toContainText('原存储配额')
  await expect(details).toContainText('3 GB')
  await expect(details).toContainText('新存储配额')
  await expect(details).toContainText('不限')
})
