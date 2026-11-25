export type QuotaUnit = 'MB' | 'GB' | 'TB'

export const QUOTA_UNIT_MULTIPLIERS: Record<QuotaUnit, number> = {
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
}

export interface QuotaOrganization {
  id: number
  name: string
  parentId: number | null
  quotaBytes: number | null
  committedBytes: number
  reservedBytes: number
  usedBytes: number
  allocatedBytes: number
  unallocatedBytes: number | null
}

export interface PlatformStorageSummary {
  totalCommittedBytes: number
  totalReservedBytes: number
  totalUsedBytes: number
  topLevelAllocatedBytes: number
  cappedOrgCount: number
}

export interface OrgAncestorBudget {
  ancestor: QuotaOrganization | null
  ancestorUnallocatedBytes: number
  maxAllowedQuotaBytes: number
  minRequiredQuotaBytes: number
}

export interface UserOrgBudget {
  ancestor: QuotaOrganization | null
  ancestorUnallocatedBytes: number
  maxAllowedQuotaBytes: number
}

export type QuotaUsageTone = 'unlimited' | 'normal' | 'warning' | 'exceeded'

export function formatBinaryBytes(bytes: number): string {
  const safe = Math.max(0, bytes)
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, safe)) / Math.log(1024)))
  return `${(safe / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
}

export function parseQuotaInput(raw: string, unit: QuotaUnit): { ok: true; bytes: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, bytes: null }
  const num = Number(trimmed)
  if (!Number.isFinite(num) || num < 0) {
    return { ok: false, error: '存储配额须为不小于 0 的数字，留空表示不限' }
  }
  const bytes = Math.round(num * QUOTA_UNIT_MULTIPLIERS[unit])
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return { ok: false, error: '存储配额超出支持范围' }
  }
  return { ok: true, bytes }
}

function formatDraftNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return String(rounded)
}

export function bytesToQuotaDraft(bytes: number | null): { value: string; unit: QuotaUnit } {
  if (bytes === null) return { value: '', unit: 'GB' }
  if (bytes === 0) return { value: '0', unit: 'GB' }
  if (bytes % QUOTA_UNIT_MULTIPLIERS.TB === 0) {
    return { value: String(bytes / QUOTA_UNIT_MULTIPLIERS.TB), unit: 'TB' }
  }
  if (bytes % QUOTA_UNIT_MULTIPLIERS.GB === 0) {
    return { value: String(bytes / QUOTA_UNIT_MULTIPLIERS.GB), unit: 'GB' }
  }
  if (bytes >= QUOTA_UNIT_MULTIPLIERS.TB) {
    return { value: formatDraftNumber(bytes / QUOTA_UNIT_MULTIPLIERS.TB), unit: 'TB' }
  }
  if (bytes >= QUOTA_UNIT_MULTIPLIERS.GB) {
    return { value: formatDraftNumber(bytes / QUOTA_UNIT_MULTIPLIERS.GB), unit: 'GB' }
  }
  return { value: formatDraftNumber(bytes / QUOTA_UNIT_MULTIPLIERS.MB), unit: 'MB' }
}

export function computePlatformStorageSummary(organizations: QuotaOrganization[]): PlatformStorageSummary {
  const byId = new Map(organizations.map(org => [org.id, org]))
  let totalCommittedBytes = 0
  let totalReservedBytes = 0
  let totalUsedBytes = 0
  let topLevelAllocatedBytes = 0
  let cappedOrgCount = 0

  for (const org of organizations) {
    if (org.quotaBytes !== null) cappedOrgCount++
    if (org.parentId === null || !byId.has(org.parentId)) {
      totalCommittedBytes += org.committedBytes
      totalReservedBytes += org.reservedBytes
      totalUsedBytes += org.usedBytes
      topLevelAllocatedBytes += org.quotaBytes !== null ? org.quotaBytes : org.allocatedBytes
    }
  }

  return {
    totalCommittedBytes,
    totalReservedBytes,
    totalUsedBytes,
    topLevelAllocatedBytes,
    cappedOrgCount,
  }
}

function findNearestCappedAncestor(
  byId: Map<number, QuotaOrganization>,
  startParentId: number | null,
): QuotaOrganization | null {
  const visited = new Set<number>()
  let current = startParentId
  while (current !== null && !visited.has(current)) {
    visited.add(current)
    const org = byId.get(current)
    if (!org) return null
    if (org.quotaBytes !== null) return org
    current = org.parentId
  }
  return null
}

export function computeOrgAncestorBudget(
  organizations: QuotaOrganization[],
  editingOrgId: number | undefined,
  selectedParentId: number | null,
): OrgAncestorBudget {
  const byId = new Map(organizations.map(org => [org.id, org]))
  const editingOrg = editingOrgId !== undefined ? byId.get(editingOrgId) : undefined
  const minRequiredQuotaBytes = editingOrg?.allocatedBytes ?? 0
  const ancestor = findNearestCappedAncestor(byId, selectedParentId)
  if (!ancestor) {
    return {
      ancestor: null,
      ancestorUnallocatedBytes: 0,
      maxAllowedQuotaBytes: 0,
      minRequiredQuotaBytes,
    }
  }
  const ancestorUnallocatedBytes = ancestor.unallocatedBytes ?? 0
  let maxAllowedQuotaBytes = ancestorUnallocatedBytes
  if (editingOrg) {
    const previousAncestor = findNearestCappedAncestor(byId, editingOrg.parentId)
    if (previousAncestor?.id === ancestor.id) {
      maxAllowedQuotaBytes += editingOrg.quotaBytes !== null ? editingOrg.quotaBytes : editingOrg.allocatedBytes
    }
  }
  return {
    ancestor,
    ancestorUnallocatedBytes,
    maxAllowedQuotaBytes,
    minRequiredQuotaBytes,
  }
}

export function computeUserOrgBudget(
  organizations: QuotaOrganization[],
  userCurrentOrgId: number,
  userCurrentQuotaBytes: number | null,
  selectedOrgId: number,
): UserOrgBudget {
  const byId = new Map(organizations.map(org => [org.id, org]))
  const ancestor = findNearestCappedAncestor(byId, selectedOrgId)
  if (!ancestor) {
    return {
      ancestor: null,
      ancestorUnallocatedBytes: 0,
      maxAllowedQuotaBytes: 0,
    }
  }
  const ancestorUnallocatedBytes = ancestor.unallocatedBytes ?? 0
  let maxAllowedQuotaBytes = ancestorUnallocatedBytes
  if (userCurrentQuotaBytes !== null) {
    const previousAncestor = findNearestCappedAncestor(byId, userCurrentOrgId)
    if (previousAncestor?.id === ancestor.id) {
      maxAllowedQuotaBytes += userCurrentQuotaBytes
    }
  }
  return {
    ancestor,
    ancestorUnallocatedBytes,
    maxAllowedQuotaBytes,
  }
}

export function quotaUsageState(usedBytes: number, quotaBytes: number | null): { tone: QuotaUsageTone; percent: number } {
  if (quotaBytes === null) return { tone: 'unlimited', percent: 0 }
  if (quotaBytes === 0) return { tone: 'exceeded', percent: 100 }
  const percent = (usedBytes / quotaBytes) * 100
  if (percent >= 100) return { tone: 'exceeded', percent }
  if (percent >= 85) return { tone: 'warning', percent }
  return { tone: 'normal', percent }
}

export interface QuotaExceededPayload {
  code?: string
  message?: string
  scope?: 'user' | 'organization_pool' | 'organization_total'
  requiredBytes?: number
  availableBytes?: number
  organizationName?: string
}

export function isQuotaExceededError(status: number | undefined, error: { code?: string } | undefined): boolean {
  return status === 507 || error?.code === 'quota_exceeded'
}

export function formatQuotaExceededError(error: QuotaExceededPayload | undefined, fallback: string): string {
  if (error?.message?.trim()) return error.message
  if (error?.scope && typeof error.availableBytes === 'number') {
    const avail = formatBinaryBytes(error.availableBytes)
    const need = typeof error.requiredBytes === 'number' && error.requiredBytes > 0 ? `，本次需要 ${formatBinaryBytes(error.requiredBytes)}` : ''
    if (error.scope === 'user') {
      return `超出个人存储配额（当前可用 ${avail}${need}）`
    }
    const orgLabel = error.organizationName ? `“${error.organizationName}”` : ''
    if (error.scope === 'organization_pool') {
      return `超出组织${orgLabel}未分配配额池可用空间（当前可用 ${avail}${need}）`
    }
    if (error.scope === 'organization_total') {
      return `超出组织${orgLabel}总存储配额（当前可用 ${avail}${need}）`
    }
  }
  return fallback
}

export type EffectiveQuotaScope = 'user' | 'organization_pool' | 'organization_total'

export interface SelfStorageSummaryLike {
  committedBytes: number
  reservedBytes: number
  usedBytes: number
  quotaBytes: number | null
  availableBytes: number | null
  effectiveLimitBytes: number | null
  effectiveUsedBytes: number
  effectiveScope: EffectiveQuotaScope | null
  constrainingOrganization: {
    name: string
    quotaBytes: number
    usedBytes: number
    allocatedBytes: number
    unallocatedPoolBytes: number
    unallocatedPoolUsedBytes: number
    remainingBytes: number
    constraintKind: 'organization_pool' | 'organization_total'
  } | null
  pendingUploads: readonly unknown[]
  pendingBatches: readonly unknown[]
}

export interface SidebarStorageView {
  label: string
  tone: Exclude<QuotaUsageTone, 'unlimited'>
  percent: number
  barPercent: number
  usageText: string
  availableText: string
  statusTag?: string
  pendingCount: number
}

export function sidebarStorageView(summary: SelfStorageSummaryLike): SidebarStorageView | null {
  if (summary.effectiveLimitBytes === null) return null
  const { tone, percent } = quotaUsageState(summary.effectiveUsedBytes, summary.effectiveLimitBytes)
  if (tone === 'unlimited') return null
  const label = summary.effectiveScope === 'organization_pool'
    ? '组织共享池'
    : summary.effectiveScope === 'organization_total'
      ? '组织配额'
      : '存储空间'
  let statusTag: string | undefined
  if (tone === 'exceeded') {
    statusTag = summary.effectiveUsedBytes > summary.effectiveLimitBytes ? '已超额' : '已满'
  } else if (tone === 'warning') {
    statusTag = '将满'
  }
  return {
    label,
    tone,
    percent,
    barPercent: Math.min(100, Math.max(0, percent)),
    usageText: `${formatBinaryBytes(summary.effectiveUsedBytes)} / ${formatBinaryBytes(summary.effectiveLimitBytes)}`,
    availableText: formatBinaryBytes(Math.max(0, summary.availableBytes ?? 0)),
    statusTag,
    pendingCount: summary.pendingUploads.length + summary.pendingBatches.length,
  }
}
