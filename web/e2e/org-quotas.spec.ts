import { expect, test } from '@playwright/test'
import { openManagementPage } from './explorer'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

test('Administrator manages hierarchical Organization Quotas and audits quota_change events', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await openManagementPage(page, '组织与用户组管理')

  const panel = page.getByRole('region', { name: '组织与用户组管理' })
  const summary = panel.getByRole('region', { name: '平台存储概览' })
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('平台总存储用量')
  await expect(summary).toContainText('顶层已分配组织配额')

  const suffix = Date.now().toString()
  const rootName = `QuotaRoot-${suffix}`
  const midName = `QuotaMid-${suffix}`
  const leafA = `QuotaLeafA-${suffix}`
  const leafB = `QuotaLeafB-${suffix}`
  const otherRoot = `QuotaOther-${suffix}`

  const dialog = page.getByRole('dialog')
  const createBtn = panel.getByRole('button', { name: '新建组织', exact: true })
  const orgRow = (name: string) => panel.getByRole('row').filter({
    has: page.getByRole('button', { name: '编辑组织 ' + name, exact: true }),
  })
  const initialOrgs = (await (await page.request.get('/api/organizations')).json()) as Array<{
    id: number; parentId: number | null; quotaBytes: number | null
  }>
  const orgChildren = new Map<number, typeof initialOrgs>()
  for (const org of initialOrgs) {
    if (org.parentId !== null) {
      const list = orgChildren.get(org.parentId) ?? []
      list.push(org)
      orgChildren.set(org.parentId, list)
    }
  }
  const topLevelCappedOrgBytes = (org: (typeof initialOrgs)[number]): number =>
    org.quotaBytes !== null
      ? org.quotaBytes
      : (orgChildren.get(org.id) ?? []).reduce((sum, child) => sum + topLevelCappedOrgBytes(child), 0)
  const baselineTopLevelGB = Math.round(
    initialOrgs
      .filter(o => o.parentId === null)
      .reduce((sum, o) => sum + topLevelCappedOrgBytes(o), 0) / (1024 ** 3),
  )

  // 1. Create capped root org (10 GB) and verify the quota input row layout is not squished.
  await createBtn.click()
  const quotaInput = dialog.getByLabel('存储配额', { exact: true })
  const quotaUnit = dialog.getByLabel('配额单位', { exact: true })
  const [dialogBox, inputBox, unitBox] = await Promise.all([
    dialog.boundingBox(),
    quotaInput.boundingBox(),
    quotaUnit.boundingBox(),
  ])
  expect(dialogBox).not.toBeNull()
  expect(inputBox).not.toBeNull()
  expect(unitBox).not.toBeNull()
  expect(inputBox!.width).toBeGreaterThanOrEqual(180)
  expect(unitBox!.width).toBeLessThanOrEqual(120)
  expect(unitBox!.x + unitBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width)

  await dialog.getByLabel('组织名称').fill(rootName)
  await quotaInput.fill('10')
  await quotaUnit.selectOption('GB')
  await dialog.getByRole('button', { name: '保存组织' }).click()

  const rootRow = orgRow(rootName)
  await expect(rootRow).toContainText('0 B / 10 GB')
  await expect(rootRow).toContainText('已分配下级 0 B')
  await expect(rootRow.getByRole('progressbar')).toBeVisible()
  await expect(summary).toContainText(`${baselineTopLevelGB + 10} GB`)

  // 2. Create uncapped intermediate org under QuotaRoot, verifying live ancestor budget display.
  await createBtn.click()
  await dialog.getByLabel('组织名称').fill(midName)
  await dialog.getByRole('combobox', { name: '上级组织', exact: true }).selectOption({ label: rootName })
  await expect(dialog.getByRole('status')).toContainText(`约束上级「${rootName}」剩余可分配 10 GB`)
  await dialog.getByRole('button', { name: '保存组织' }).click()

  const midRow = orgRow(midName)
  await expect(midRow).toContainText('0 B / 不限')

  // 3. Create LeafA (6 GB) under uncapped Mid (transparently bounded by QuotaRoot).
  await createBtn.click()
  await dialog.getByLabel('组织名称').fill(leafA)
  await dialog.getByRole('combobox', { name: '上级组织', exact: true }).selectOption({ label: `${rootName} / ${midName}` })
  await expect(dialog.getByRole('status')).toContainText(`约束上级「${rootName}」剩余可分配 10 GB`)
  await dialog.getByLabel('存储配额', { exact: true }).fill('6')
  await dialog.getByLabel('配额单位', { exact: true }).selectOption('GB')
  await dialog.getByRole('button', { name: '保存组织' }).click()

  await expect(orgRow(leafA)).toContainText('0 B / 6 GB')
  await expect(rootRow).toContainText('已分配下级 6 GB')
  await expect(midRow).toContainText('已分配下级 6 GB')

  // 4. Attempt to create LeafB (5 GB) exceeding remaining 4 GB -> 409 error -> resolve with 4 GB.
  await createBtn.click()
  await dialog.getByLabel('组织名称').fill(leafB)
  await dialog.getByRole('combobox', { name: '上级组织', exact: true }).selectOption({ label: `${rootName} / ${midName}` })
  await expect(dialog.getByRole('status')).toContainText(`约束上级「${rootName}」剩余可分配 4 GB`)
  await dialog.getByLabel('存储配额', { exact: true }).fill('5')
  await dialog.getByLabel('配额单位', { exact: true }).selectOption('GB')
  await dialog.getByRole('button', { name: '保存组织' }).click()
  await expect(dialog.getByRole('alert')).toContainText(rootName)
  await expect(dialog.getByRole('alert')).toContainText('4 GB')

  await dialog.getByLabel('存储配额', { exact: true }).fill('4')
  await dialog.getByRole('button', { name: '保存组织' }).click()
  const leafBRow = orgRow(leafB)
  await expect(leafBRow).toContainText('0 B / 4 GB')
  await expect(rootRow).toContainText('已分配下级 10 GB')

  // 5. Attempt to lower QuotaRoot below allocated 10 GB -> 409 error.
  await panel.getByRole('button', { name: '编辑组织 ' + rootName, exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('下级已分配 10 GB')
  await dialog.getByLabel('存储配额', { exact: true }).fill('9')
  await dialog.getByRole('button', { name: '保存组织' }).click()
  await expect(dialog.getByRole('alert')).toContainText('10 GB')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  // 6. Zero LeafB (0 bytes, distinct from unlimited), then clear LeafB back to unlimited.
  await panel.getByRole('button', { name: '编辑组织 ' + leafB, exact: true }).click()
  await dialog.getByLabel('存储配额', { exact: true }).fill('0')
  await dialog.getByRole('button', { name: '保存组织' }).click()
  await expect(leafBRow).toContainText('0 B / 0 B')
  await expect(leafBRow).toContainText('已禁写')
  await expect(rootRow).toContainText('已分配下级 6 GB')

  await panel.getByRole('button', { name: '编辑组织 ' + leafB, exact: true }).click()
  await dialog.getByRole('button', { name: '清除配额', exact: true }).click()
  await dialog.getByRole('button', { name: '保存组织' }).click()
  await expect(leafBRow).toContainText('0 B / 不限')

  // 7. Create another capped root (2 GB) and verify moving LeafA (6 GB) into it is rejected (409).
  await createBtn.click()
  await dialog.getByLabel('组织名称').fill(otherRoot)
  await dialog.getByLabel('存储配额', { exact: true }).fill('2')
  await dialog.getByLabel('配额单位', { exact: true }).selectOption('GB')
  await dialog.getByRole('button', { name: '保存组织' }).click()
  await expect(orgRow(otherRoot)).toContainText('0 B / 2 GB')
  await expect(summary).toContainText(`${baselineTopLevelGB + 12} GB`)

  await panel.getByRole('button', { name: '编辑组织 ' + leafA, exact: true }).click()
  await dialog.getByRole('combobox', { name: '上级组织', exact: true }).selectOption({ label: otherRoot })
  await expect(dialog.getByRole('status')).toContainText(`约束上级「${otherRoot}」剩余可分配 2 GB`)
  await dialog.getByRole('button', { name: '保存组织' }).click()
  await expect(dialog.getByRole('alert')).toContainText(otherRoot)
  await expect(dialog.getByRole('alert')).toContainText('2 GB')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  // Clean up test organizations (leaf-first) so shared test DB stays tidy.
  for (const name of [leafA, leafB, midName, rootName, otherRoot]) {
    await panel.getByRole('button', { name: '编辑组织 ' + name, exact: true }).click()
    await dialog.getByRole('button', { name: '删除组织' }).click()
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(orgRow(name)).toHaveCount(0)
  }

  // 7. Verify quota_change Audit Events in Audit Log (account category & action filter & detail drawer).
  await openManagementPage(page, '审计日志')
  const auditPanel = page.getByRole('region', { name: '审计记录' })
  const toolbar = auditPanel.getByRole('group', { name: '审计筛选' })
  await expect(auditPanel.getByRole('status')).toContainText('条记录')

  await toolbar.getByRole('combobox', { name: '操作类别' }).selectOption('account')
  await expect(auditPanel.getByRole('table')).toContainText('变更存储配额')

  await toolbar.getByRole('button', { name: '更多筛选', exact: true }).click()
  const filterDialog = page.getByRole('dialog', { name: '筛选审计日志' })
  await filterDialog.getByRole('combobox', { name: '精确操作', exact: true }).selectOption('quota_change')
  await filterDialog.getByRole('button', { name: '应用筛选', exact: true }).click()

  const newestRow = auditPanel.getByRole('row').filter({ hasText: leafB }).first()
  await expect(newestRow).toContainText('变更存储配额')
  await newestRow.getByRole('button', { name: '查看详情' }).click()
  const details = auditPanel.getByRole('complementary', { name: '审计详情' })
  await expect(details).toContainText('配额对象类型')
  await expect(details).toContainText('组织')
  await expect(details).toContainText(leafB)
  await expect(details).toContainText('原存储配额')
  await expect(details).toContainText('0 B')
  await expect(details).toContainText('新存储配额')
  await expect(details).toContainText('不限')
})
