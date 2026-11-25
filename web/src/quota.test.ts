// Pure-unit tests for binary quota input parsing, formatting, platform summary,
// and constraining-ancestor budget computation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSize } from './formatSize.ts'
import {
  bytesToQuotaDraft,
  computeOrgAncestorBudget,
  computePlatformStorageSummary,
  computeUserOrgBudget,
  editQuotaWarning,
  formatQuotaExceededError,
  isQuotaExceededError,
  parseQuotaInput,
  quotaUsageState,
  sidebarStorageView,
  utf8ByteLength,
  type QuotaOrganization,
  type SelfStorageSummaryLike,
} from './quota.ts'

const MB = 1024 ** 2
const GB = 1024 ** 3
const TB = 1024 ** 4

test('parseQuotaInput handles blank unlimited, zero, binary units, and rejects invalid values', () => {
  assert.deepEqual(parseQuotaInput('', 'GB'), { ok: true, bytes: null })
  assert.deepEqual(parseQuotaInput('   ', 'MB'), { ok: true, bytes: null })
  assert.deepEqual(parseQuotaInput('0', 'GB'), { ok: true, bytes: 0 })
  assert.deepEqual(parseQuotaInput('512', 'MB'), { ok: true, bytes: 512 * MB })
  assert.deepEqual(parseQuotaInput('1.5', 'GB'), { ok: true, bytes: Math.round(1.5 * GB) })
  assert.deepEqual(parseQuotaInput('2', 'TB'), { ok: true, bytes: 2 * TB })
  assert.equal(parseQuotaInput('-1', 'GB').ok, false)
  assert.equal(parseQuotaInput('abc', 'MB').ok, false)
  assert.equal(parseQuotaInput('1000000', 'TB').ok, false)
})

test('bytesToQuotaDraft chooses clean binary unit and preserves exact MB multiples and small positive byte quotas', () => {
  assert.deepEqual(bytesToQuotaDraft(null), { value: '', unit: 'GB' })
  assert.deepEqual(bytesToQuotaDraft(0), { value: '0', unit: 'GB' })
  assert.deepEqual(bytesToQuotaDraft(1 * TB), { value: '1', unit: 'TB' })
  assert.deepEqual(bytesToQuotaDraft(2 * TB), { value: '2', unit: 'TB' })
  assert.deepEqual(bytesToQuotaDraft(2 * GB), { value: '2', unit: 'GB' })
  assert.deepEqual(bytesToQuotaDraft(10 * GB), { value: '10', unit: 'GB' })
  assert.deepEqual(bytesToQuotaDraft(256 * MB), { value: '256', unit: 'MB' })
  assert.deepEqual(bytesToQuotaDraft(1500 * MB), { value: '1500', unit: 'MB' })
  assert.deepEqual(bytesToQuotaDraft(1536 * MB), { value: '1536', unit: 'MB' })

  // Non-MB-aligned positive byte quotas must stay visibly non-zero and round-trip accurately.
  for (const bytes of [1, 100, 4096]) {
    const draft = bytesToQuotaDraft(bytes)
    assert.equal(draft.unit, 'MB')
    assert.notEqual(draft.value, '0')
    assert.ok(Number(draft.value) > 0, `expected positive value for ${bytes} bytes, got ${draft.value}`)
    assert.deepEqual(parseQuotaInput(draft.value, draft.unit), { ok: true, bytes })
  }
})

test('formatSize formats 1024-based units matching desktop file sizes', () => {
  assert.equal(formatSize(-10), '0 B')
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(1024), '1 KB')
  assert.equal(formatSize(MB), '1 MB')
  assert.equal(formatSize(1.5 * GB), '1.5 GB')
  assert.equal(formatSize(2 * TB), '2 TB')
})

test('computePlatformStorageSummary sums root usage and top-level allocated quotas without double counting', () => {
  const orgs: QuotaOrganization[] = [
    { id: 1, name: 'Default', parentId: null, quotaBytes: null, committedBytes: 200, reservedBytes: 50, usedBytes: 250, allocatedBytes: 10 * GB, unallocatedBytes: null },
    { id: 2, name: 'Eng', parentId: 1, quotaBytes: 10 * GB, committedBytes: 150, reservedBytes: 50, usedBytes: 200, allocatedBytes: 4 * GB, unallocatedBytes: 6 * GB },
    { id: 3, name: 'Platform', parentId: 2, quotaBytes: 4 * GB, committedBytes: 100, reservedBytes: 0, usedBytes: 100, allocatedBytes: 0, unallocatedBytes: 4 * GB },
    { id: 4, name: 'Sales', parentId: null, quotaBytes: 20 * GB, committedBytes: 300, reservedBytes: 20, usedBytes: 320, allocatedBytes: 5 * GB, unallocatedBytes: 15 * GB },
  ]
  const summary = computePlatformStorageSummary(orgs)
  assert.deepEqual(summary, {
    totalCommittedBytes: 500,
    totalReservedBytes: 70,
    totalUsedBytes: 570,
    topLevelAllocatedBytes: 30 * GB,
    cappedOrgCount: 3,
  })
})

test('computePlatformStorageSummary excludes User Quotas from top-level allocated Organization Quotas', () => {
  // Uncapped root with direct User Quotas (allocatedBytes > 0) and zero capped Organizations.
  const onlyUserQuotas: QuotaOrganization[] = [
    { id: 1, name: 'Default', parentId: null, quotaBytes: null, committedBytes: 100, reservedBytes: 25, usedBytes: 125, allocatedBytes: 8 * GB, unallocatedBytes: null },
    { id: 2, name: 'UncappedSubOrg', parentId: 1, quotaBytes: null, committedBytes: 40, reservedBytes: 0, usedBytes: 40, allocatedBytes: 3 * GB, unallocatedBytes: null },
  ]
  assert.deepEqual(computePlatformStorageSummary(onlyUserQuotas), {
    totalCommittedBytes: 100,
    totalReservedBytes: 25,
    totalUsedBytes: 125,
    topLevelAllocatedBytes: 0,
    cappedOrgCount: 0,
  })

  // Uncapped root -> uncapped mid -> capped leaf org (4 GB) alongside User Quotas in both root & mid.
  const mixed: QuotaOrganization[] = [
    { id: 1, name: 'RootFree', parentId: null, quotaBytes: null, committedBytes: 50, reservedBytes: 10, usedBytes: 60, allocatedBytes: 12 * GB, unallocatedBytes: null },
    { id: 2, name: 'MidFree', parentId: 1, quotaBytes: null, committedBytes: 30, reservedBytes: 0, usedBytes: 30, allocatedBytes: 7 * GB, unallocatedBytes: null },
    { id: 3, name: 'LeafCapped', parentId: 2, quotaBytes: 4 * GB, committedBytes: 20, reservedBytes: 0, usedBytes: 20, allocatedBytes: 2 * GB, unallocatedBytes: 2 * GB },
    { id: 4, name: 'DeepCapped', parentId: 3, quotaBytes: 2 * GB, committedBytes: 10, reservedBytes: 0, usedBytes: 10, allocatedBytes: 0, unallocatedBytes: 2 * GB },
  ]
  assert.deepEqual(computePlatformStorageSummary(mixed), {
    totalCommittedBytes: 50,
    totalReservedBytes: 10,
    totalUsedBytes: 60,
    topLevelAllocatedBytes: 4 * GB,
    cappedOrgCount: 2,
  })
})

test('computeOrgAncestorBudget finds constraining ancestor across uncapped intermediates and handles moves', () => {
  const orgs: QuotaOrganization[] = [
    { id: 1, name: 'RootA', parentId: null, quotaBytes: 100 * GB, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 60 * GB, unallocatedBytes: 40 * GB },
    { id: 2, name: 'MidA', parentId: 1, quotaBytes: null, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 40 * GB, unallocatedBytes: null },
    { id: 3, name: 'LeafA', parentId: 2, quotaBytes: 40 * GB, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 10 * GB, unallocatedBytes: 30 * GB },
    { id: 4, name: 'SiblingA', parentId: 1, quotaBytes: 20 * GB, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 0, unallocatedBytes: 20 * GB },
    { id: 5, name: 'RootB', parentId: null, quotaBytes: 50 * GB, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 15 * GB, unallocatedBytes: 35 * GB },
    { id: 6, name: 'RootFree', parentId: null, quotaBytes: null, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 0, unallocatedBytes: null },
  ]

  // Creating new org under uncapped MidA -> constrained by RootA with 40 GB remaining.
  const newUnderMid = computeOrgAncestorBudget(orgs, undefined, 2)
  assert.equal(newUnderMid.ancestor?.id, 1)
  assert.equal(newUnderMid.ancestorUnallocatedBytes, 40 * GB)
  assert.equal(newUnderMid.maxAllowedQuotaBytes, 40 * GB)
  assert.equal(newUnderMid.minRequiredQuotaBytes, 0)

  // Editing LeafA staying under MidA -> adds back LeafA's own 40 GB => max 80 GB, min 10 GB.
  const editLeaf = computeOrgAncestorBudget(orgs, 3, 2)
  assert.equal(editLeaf.ancestor?.id, 1)
  assert.equal(editLeaf.ancestorUnallocatedBytes, 40 * GB)
  assert.equal(editLeaf.maxAllowedQuotaBytes, 80 * GB)
  assert.equal(editLeaf.minRequiredQuotaBytes, 10 * GB)

  // Moving LeafA into RootB -> RootB was NOT LeafA's previous ancestor => max 35 GB.
  const moveLeaf = computeOrgAncestorBudget(orgs, 3, 5)
  assert.equal(moveLeaf.ancestor?.id, 5)
  assert.equal(moveLeaf.ancestorUnallocatedBytes, 35 * GB)
  assert.equal(moveLeaf.maxAllowedQuotaBytes, 35 * GB)

  // Moving under unlimited root -> no constraining ancestor.
  const underFree = computeOrgAncestorBudget(orgs, 3, 6)
  assert.equal(underFree.ancestor, null)
  assert.equal(underFree.minRequiredQuotaBytes, 10 * GB)
})

test('computeUserOrgBudget tracks constraining organization across uncapped intermediates and cross-org moves', () => {
  const orgs: QuotaOrganization[] = [
    { id: 1, name: 'RootA', parentId: null, quotaBytes: 100 * GB, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 70 * GB, unallocatedBytes: 30 * GB },
    { id: 2, name: 'MidA1', parentId: 1, quotaBytes: null, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 40 * GB, unallocatedBytes: null },
    { id: 3, name: 'MidA2', parentId: 1, quotaBytes: null, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 0, unallocatedBytes: null },
    { id: 4, name: 'SubCapped', parentId: 1, quotaBytes: 30 * GB, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 10 * GB, unallocatedBytes: 20 * GB },
    { id: 5, name: 'RootB', parentId: null, quotaBytes: 50 * GB, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 35 * GB, unallocatedBytes: 15 * GB },
    { id: 6, name: 'RootUnlimited', parentId: null, quotaBytes: null, committedBytes: 0, reservedBytes: 0, usedBytes: 0, allocatedBytes: 0, unallocatedBytes: null },
  ]

  // Capped user (40 GB) in uncapped MidA1 staying in MidA1 -> bounded by RootA (remaining 30 GB, max 70 GB).
  const staySame = computeUserOrgBudget(orgs, 2, 40 * GB, 2)
  assert.equal(staySame.ancestor?.id, 1)
  assert.equal(staySame.ancestorUnallocatedBytes, 30 * GB)
  assert.equal(staySame.maxAllowedQuotaBytes, 70 * GB)

  // Moving to sibling uncapped MidA2 under same RootA -> still shares RootA, max 70 GB.
  const siblingMove = computeUserOrgBudget(orgs, 2, 40 * GB, 3)
  assert.equal(siblingMove.ancestor?.id, 1)
  assert.equal(siblingMove.ancestorUnallocatedBytes, 30 * GB)
  assert.equal(siblingMove.maxAllowedQuotaBytes, 70 * GB)

  // Moving into capped SubCapped (remaining 20 GB) -> new constraining org, max 20 GB.
  const intoSubCapped = computeUserOrgBudget(orgs, 2, 40 * GB, 4)
  assert.equal(intoSubCapped.ancestor?.id, 4)
  assert.equal(intoSubCapped.ancestorUnallocatedBytes, 20 * GB)
  assert.equal(intoSubCapped.maxAllowedQuotaBytes, 20 * GB)

  // Moving into RootB (remaining 15 GB) -> max 15 GB.
  const intoRootB = computeUserOrgBudget(orgs, 2, 40 * GB, 5)
  assert.equal(intoRootB.ancestor?.id, 5)
  assert.equal(intoRootB.ancestorUnallocatedBytes, 15 * GB)
  assert.equal(intoRootB.maxAllowedQuotaBytes, 15 * GB)

  // Moving into RootUnlimited -> no organization cap.
  const intoUnlimited = computeUserOrgBudget(orgs, 2, 40 * GB, 6)
  assert.equal(intoUnlimited.ancestor, null)
  assert.equal(intoUnlimited.maxAllowedQuotaBytes, 0)

  // Uncapped user in MidA1 -> remaining 30 GB, max 30 GB.
  const uncappedUser = computeUserOrgBudget(orgs, 2, null, 2)
  assert.equal(uncappedUser.ancestor?.id, 1)
  assert.equal(uncappedUser.maxAllowedQuotaBytes, 30 * GB)
})

test('quotaUsageState classifies unlimited, normal, >=85% warning, >=100% exceeded, and zero cap', () => {
  assert.deepEqual(quotaUsageState(100, null), { tone: 'unlimited', percent: 0 })
  assert.deepEqual(quotaUsageState(0, 0), { tone: 'exceeded', percent: 100 })
  assert.deepEqual(quotaUsageState(84, 100), { tone: 'normal', percent: 84 })
  assert.deepEqual(quotaUsageState(85, 100), { tone: 'warning', percent: 85 })
  assert.deepEqual(quotaUsageState(100, 100), { tone: 'exceeded', percent: 100 })
  assert.deepEqual(quotaUsageState(150, 100), { tone: 'exceeded', percent: 150 })
})

test('isQuotaExceededError and formatQuotaExceededError handle 507 payloads and fallbacks', () => {
  assert.equal(isQuotaExceededError(507, undefined), true)
  assert.equal(isQuotaExceededError(400, { code: 'quota_exceeded' }), true)
  assert.equal(isQuotaExceededError(409, { code: 'quota_conflict' }), false)

  assert.equal(
    formatQuotaExceededError({ code: 'quota_exceeded', message: '超出个人存储配额（当前可用 0 B，本次需要 2 MB）' }, '上传被拒绝'),
    '超出个人存储配额（当前可用 0 B，本次需要 2 MB）',
  )
  assert.equal(
    formatQuotaExceededError({ code: 'quota_exceeded', scope: 'organization_pool', organizationName: '研发部', availableBytes: 1024, requiredBytes: 2048 }, '上传被拒绝'),
    '超出组织“研发部”未分配配额池可用空间（当前可用 1 KB，本次需要 2 KB）',
  )
  assert.equal(
    formatQuotaExceededError({ code: 'quota_exceeded', scope: 'organization_total', organizationName: '总公司', availableBytes: 0, requiredBytes: 512 }, '上传被拒绝'),
    '超出组织“总公司”总存储配额（当前可用 0 B，本次需要 512 B）',
  )
  assert.equal(
    formatQuotaExceededError({ code: 'quota_exceeded', scope: 'user', availableBytes: 512, requiredBytes: 1024 }, '上传被拒绝'),
    '超出个人存储配额（当前可用 512 B，本次需要 1 KB）',
  )
  assert.equal(formatQuotaExceededError(undefined, '上传被拒绝'), '上传被拒绝')
})

test('sidebarStorageView hides when unlimited and classifies normal, >=85% warning, >=100% over-quota, zero cap, and org scopes', () => {
  const base: SelfStorageSummaryLike = {
    committedBytes: 0,
    reservedBytes: 0,
    usedBytes: 0,
    quotaBytes: null,
    availableBytes: null,
    effectiveLimitBytes: null,
    effectiveUsedBytes: 0,
    effectiveScope: null,
    constrainingOrganization: null,
    pendingUploads: [],
    pendingBatches: [],
  }

  // Unlimited user -> hidden
  assert.equal(sidebarStorageView({ ...base, committedBytes: 5 * MB, usedBytes: 5 * MB, effectiveUsedBytes: 5 * MB }), null)

  // Normal (< 85%) user quota
  const normal = sidebarStorageView({
    ...base,
    committedBytes: 4 * MB,
    usedBytes: 4 * MB,
    quotaBytes: 10 * MB,
    availableBytes: 6 * MB,
    effectiveLimitBytes: 10 * MB,
    effectiveUsedBytes: 4 * MB,
    effectiveScope: 'user',
  })
  assert.deepEqual(normal, {
    label: '存储空间',
    tone: 'normal',
    percent: 40,
    barPercent: 40,
    usageText: '4 MB / 10 MB',
    availableText: '6 MB',
    statusTag: undefined,
    pendingCount: 0,
  })

  // Warning (>= 85%) org pool
  const warning = sidebarStorageView({
    ...base,
    committedBytes: 1 * MB,
    usedBytes: 1 * MB,
    availableBytes: 3 * MB,
    effectiveLimitBytes: 20 * MB,
    effectiveUsedBytes: 17 * MB,
    effectiveScope: 'organization_pool',
    pendingUploads: [{ id: 'u1' }],
    pendingBatches: [{ id: 'b1' }],
  })
  assert.deepEqual(warning, {
    label: '组织共享池',
    tone: 'warning',
    percent: 85,
    barPercent: 85,
    usageText: '17 MB / 20 MB',
    availableText: '3 MB',
    statusTag: '将满',
    pendingCount: 2,
  })

  // Over-quota (> 100%) org total
  const exceeded = sidebarStorageView({
    ...base,
    availableBytes: 0,
    effectiveLimitBytes: 10 * MB,
    effectiveUsedBytes: 12 * MB,
    effectiveScope: 'organization_total',
  })
  assert.deepEqual(exceeded, {
    label: '组织配额',
    tone: 'exceeded',
    percent: 120,
    barPercent: 100,
    usageText: '12 MB / 10 MB',
    availableText: '0 B',
    statusTag: '已超额',
    pendingCount: 0,
  })

  // Zero-byte quota cap -> exceeded with 100% bar fill
  const zeroCap = sidebarStorageView({
    ...base,
    quotaBytes: 0,
    availableBytes: 0,
    effectiveLimitBytes: 0,
    effectiveUsedBytes: 0,
    effectiveScope: 'user',
  })
  assert.deepEqual(zeroCap, {
    label: '存储空间',
    tone: 'exceeded',
    percent: 100,
    barPercent: 100,
    usageText: '0 B / 0 B',
    availableText: '0 B',
    statusTag: '已满',
    pendingCount: 0,
  })
})

test('utf8ByteLength counts exact UTF-8 bytes including multi-byte Chinese characters', () => {
  assert.equal(utf8ByteLength(''), 0)
  assert.equal(utf8ByteLength('abc'), 3)
  assert.equal(utf8ByteLength('中文'), 6)
  assert.equal(utf8ByteLength('a中b'), 5)
})

test('editQuotaWarning warns when over quota even for 0-byte files and when headroom is tighter than file size', () => {
  assert.equal(editQuotaWarning(null, 1024), undefined)
  assert.equal(editQuotaWarning(undefined, 1024), undefined)
  assert.equal(editQuotaWarning(null, 0), undefined)
  assert.equal(editQuotaWarning(1024, 0), undefined)
  assert.equal(editQuotaWarning(1024, 1024), undefined)
  assert.equal(editQuotaWarning(2048, 1024), undefined)

  const tight = editQuotaWarning(512, 2048)
  assert.ok(tight?.includes('512 B'))
  assert.ok(tight?.includes('2 KB'))

  const empty = editQuotaWarning(0, 100)
  assert.ok(empty?.includes('0 B'))

  // 0-byte files must still show the over-quota warning when available <= 0 (matching GET /tree/{id}/text 507).
  const zeroByteOverQuota = editQuotaWarning(0, 0)
  assert.ok(zeroByteOverQuota?.includes('0 B'))
})
