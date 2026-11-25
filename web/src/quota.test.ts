// Pure-unit tests for binary quota input parsing, formatting, platform summary,
// and constraining-ancestor budget computation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bytesToQuotaDraft,
  computeOrgAncestorBudget,
  computePlatformStorageSummary,
  formatBinaryBytes,
  parseQuotaInput,
  quotaUsageState,
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

test('quotaUsageState classifies unlimited, normal, >=85% warning, >=100% exceeded, and zero cap', () => {
  assert.deepEqual(quotaUsageState(100, null), { tone: 'unlimited', percent: 0 })
  assert.deepEqual(quotaUsageState(0, 0), { tone: 'exceeded', percent: 100 })
  assert.deepEqual(quotaUsageState(84, 100), { tone: 'normal', percent: 84 })
  assert.deepEqual(quotaUsageState(85, 100), { tone: 'warning', percent: 85 })
  assert.deepEqual(quotaUsageState(100, 100), { tone: 'exceeded', percent: 100 })
  assert.deepEqual(quotaUsageState(150, 100), { tone: 'exceeded', percent: 150 })
})
