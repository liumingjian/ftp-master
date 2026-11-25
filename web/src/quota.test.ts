// Pure-unit tests for binary quota input parsing, formatting, platform summary,
// and constraining-ancestor budget computation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bytesToQuotaDraft,
  computeOrgAncestorBudget,
  computePlatformStorageSummary,
  computeUserOrgBudget,
  editQuotaWarning,
  formatBinaryBytes,
  formatQuotaExceededError,
  isQuotaExceededError,
  parseQuotaInput,
  quotaUsageState,
  utf8ByteLength,
  type QuotaOrganization,
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

test('bytesToQuotaDraft chooses clean binary unit and preserves zero vs unlimited', () => {
  assert.deepEqual(bytesToQuotaDraft(null), { value: '', unit: 'GB' })
  assert.deepEqual(bytesToQuotaDraft(0), { value: '0', unit: 'GB' })
  assert.deepEqual(bytesToQuotaDraft(2 * TB), { value: '2', unit: 'TB' })
  assert.deepEqual(bytesToQuotaDraft(10 * GB), { value: '10', unit: 'GB' })
  assert.deepEqual(bytesToQuotaDraft(256 * MB), { value: '256', unit: 'MB' })
  assert.deepEqual(bytesToQuotaDraft(1536 * MB), { value: '1.5', unit: 'GB' })
})

test('formatBinaryBytes formats 1024-based units matching desktop file sizes', () => {
  assert.equal(formatBinaryBytes(0), '0 B')
  assert.equal(formatBinaryBytes(512), '512 B')
  assert.equal(formatBinaryBytes(1024), '1 KB')
  assert.equal(formatBinaryBytes(MB), '1 MB')
  assert.equal(formatBinaryBytes(1.5 * GB), '1.5 GB')
  assert.equal(formatBinaryBytes(2 * TB), '2 TB')
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

test('utf8ByteLength counts exact UTF-8 bytes including multi-byte Chinese characters', () => {
  assert.equal(utf8ByteLength(''), 0)
  assert.equal(utf8ByteLength('abc'), 3)
  assert.equal(utf8ByteLength('中文'), 6)
  assert.equal(utf8ByteLength('a中b'), 5)
})

test('editQuotaWarning warns only when effective headroom is tighter than file size', () => {
  assert.equal(editQuotaWarning(null, 1024), undefined)
  assert.equal(editQuotaWarning(undefined, 1024), undefined)
  assert.equal(editQuotaWarning(1024, 0), undefined)
  assert.equal(editQuotaWarning(1024, 1024), undefined)
  assert.equal(editQuotaWarning(2048, 1024), undefined)

  const tight = editQuotaWarning(512, 2048)
  assert.ok(tight?.includes('512 B'))
  assert.ok(tight?.includes('2 KB'))

  const empty = editQuotaWarning(0, 100)
  assert.ok(empty?.includes('0 B'))
})
