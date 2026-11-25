import { useState } from 'react'
import { Building2, FileUp, FolderUp, HardDrive, RefreshCw } from 'lucide-react'
import { api } from './api/client'
import type { components } from './api/schema.gen'
import { formatBinaryBytes, sidebarStorageView } from './quota'
import {
  classifyCancelOutcome,
  clearMatchingBatchResume,
  clearMatchingUploadResume,
  notifyStorageUploadCancelled,
} from './uploadCancel'

type SelfStorageSummary = components['schemas']['SelfStorageSummary']
type PendingUpload = components['schemas']['PendingUpload']
type PendingUploadBatch = components['schemas']['PendingUploadBatch']

type Props = {
  summary?: SelfStorageSummary
  loading: boolean
  error?: string
  onRefresh: () => void
}

function formatUploadTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function AccountStorageSection({ summary, loading, error, onRefresh }: Props) {
  const [cancellingKey, setCancellingKey] = useState<string>()
  const [cancelError, setCancelError] = useState<string>()

  async function cancelPendingUpload(item: PendingUpload) {
    const key = `upload:${item.id}`
    if (cancellingKey) return
    setCancellingKey(key)
    setCancelError(undefined)
    try {
      const result = await api.DELETE('/uploads/{id}', { params: { path: { id: item.id } } })
      const outcome = classifyCancelOutcome(result.response.status)
      if (outcome === 'cleared' || outcome === 'already_completed') {
        clearMatchingUploadResume(localStorage, item.parentId, item.id)
        notifyStorageUploadCancelled({ kind: 'upload', id: item.id, parentId: item.parentId })
        onRefresh()
      } else {
        setCancelError(result.error?.message ?? '取消上传失败，请重试')
      }
    } catch {
      setCancelError('无法连接服务，取消上传失败')
    } finally {
      setCancellingKey(undefined)
    }
  }

  async function cancelPendingBatch(batch: PendingUploadBatch) {
    const key = `batch:${batch.id}`
    if (cancellingKey) return
    setCancellingKey(key)
    setCancelError(undefined)
    try {
      const result = await api.DELETE('/upload-batches/{id}', { params: { path: { id: batch.id } } })
      const outcome = classifyCancelOutcome(result.response.status)
      if (outcome === 'cleared' || outcome === 'already_completed') {
        clearMatchingBatchResume(localStorage, batch.parentId, batch.id)
        notifyStorageUploadCancelled({ kind: 'batch', id: batch.id, parentId: batch.parentId })
        onRefresh()
      } else {
        setCancelError(result.error?.message ?? '取消文件夹上传失败，请重试')
      }
    } catch {
      setCancelError('无法连接服务，取消文件夹上传失败')
    } finally {
      setCancellingKey(undefined)
    }
  }

  const barView = summary ? sidebarStorageView(summary) : null
  const pendingTotal = summary ? summary.pendingUploads.length + summary.pendingBatches.length : 0

  return (
    <section className="panel account-storage-card" aria-label="存储配额与待完成上传">
      <div className="account-storage-header">
        <div className="account-storage-title">
          <HardDrive size={18} aria-hidden="true" />
          <h2>存储空间</h2>
          {summary && (
            barView
              ? <span className={`storage-status-pill is-${barView.tone}`}>
                {barView.statusTag ?? `${Math.round(barView.percent)}%`}
              </span>
              : <span className="storage-status-pill is-unlimited">不限</span>
          )}
        </div>
        <button
          type="button"
          className="ghost icon"
          title="刷新存储状态"
          aria-label="刷新存储状态"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={15} className={loading ? 'storage-spin' : undefined} aria-hidden="true" />
        </button>
      </div>

      {error && !summary && (
        <div className="account-storage-body">
          <p className="banner error" role="alert">{error}</p>
        </div>
      )}

      {!summary && !error && (
        <div className="account-storage-body">
          <p className="storage-empty">正在读取存储信息…</p>
        </div>
      )}

      {summary && (
        <div className="account-storage-body">
          {barView ? (
            <div className={`account-storage-meter is-${barView.tone}`} data-storage-tone={barView.tone}>
              <div className="account-storage-meter-row">
                <span className="account-storage-meter-label">{barView.label}</span>
                <strong className="tabular-nums">{barView.usageText}</strong>
              </div>
              <div
                className="account-storage-track"
                role="progressbar"
                aria-label={barView.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(barView.barPercent)}
              >
                <span className={`account-storage-fill ${barView.tone}`} style={{ width: `${barView.barPercent}%` }} />
              </div>
              <div className="account-storage-meter-foot">
                <span className="tabular-nums">可用 {barView.availableText}</span>
                <span className="tabular-nums">个人总占用 {formatBinaryBytes(summary.usedBytes)}</span>
              </div>
            </div>
          ) : (
            <div className="account-storage-unlimited">
              <span className="account-storage-unlimited-used tabular-nums">
                已用 <strong>{formatBinaryBytes(summary.usedBytes)}</strong>
              </span>
              <span className="account-storage-unlimited-cap">当前未设置存储配额上限（不限）</span>
            </div>
          )}

          <dl className="account-storage-metrics" aria-label="个人存储明细">
            <div className="account-storage-metric">
              <dt>已提交占用</dt>
              <dd className="tabular-nums">{formatBinaryBytes(summary.committedBytes)}</dd>
            </div>
            <div className="account-storage-metric">
              <dt>上传预占</dt>
              <dd className="tabular-nums">{formatBinaryBytes(summary.reservedBytes)}</dd>
            </div>
            <div className="account-storage-metric">
              <dt>个人配额</dt>
              <dd className="tabular-nums">
                {summary.quotaBytes === null ? '不限' : formatBinaryBytes(summary.quotaBytes)}
              </dd>
            </div>
            <div className="account-storage-metric">
              <dt>当前可用</dt>
              <dd className="tabular-nums">
                {summary.availableBytes === null ? '不限' : formatBinaryBytes(summary.availableBytes)}
              </dd>
            </div>
          </dl>

          {summary.constrainingOrganization && (
            <div className="account-storage-org" aria-label="约束组织存储状态">
              <div className="account-storage-org-head">
                <span className="account-storage-org-name">
                  <Building2 size={15} aria-hidden="true" />
                  <strong>{summary.constrainingOrganization.name}</strong>
                </span>
                <span className="pill">
                  {summary.constrainingOrganization.constraintKind === 'organization_pool'
                    ? '共享未分配配额池'
                    : '组织配额上限'}
                </span>
              </div>
              <div className="account-storage-org-stats tabular-nums">
                <span>组织配额 {formatBinaryBytes(summary.constrainingOrganization.quotaBytes)}</span>
                <span>组织已用 {formatBinaryBytes(summary.constrainingOrganization.usedBytes)}</span>
                {summary.constrainingOrganization.constraintKind === 'organization_pool' ? (
                  <>
                    <span>
                      未分配池 {formatBinaryBytes(summary.constrainingOrganization.unallocatedPoolUsedBytes)} / {formatBinaryBytes(summary.constrainingOrganization.unallocatedPoolBytes)}
                    </span>
                    <span>池剩余 {formatBinaryBytes(summary.constrainingOrganization.remainingBytes)}</span>
                  </>
                ) : (
                  <span>组织剩余 {formatBinaryBytes(summary.constrainingOrganization.remainingBytes)}</span>
                )}
              </div>
            </div>
          )}

          <div className="account-pending-section" aria-label="待完成上传">
            <div className="account-pending-head">
              <h3>待完成上传</h3>
              {pendingTotal > 0 && <span className="pill tabular-nums">{pendingTotal} 项</span>}
            </div>

            {cancelError && <p className="banner error" role="alert">{cancelError}</p>}

            {pendingTotal === 0 ? (
              <p className="storage-empty">暂无未完成的上传任务</p>
            ) : (
              <ul className="account-pending-list">
                {summary.pendingUploads.map(item => {
                  const key = `upload:${item.id}`
                  const busy = cancellingKey === key
                  return (
                    <li key={key} className="account-pending-item" data-pending-kind="upload" data-pending-id={item.id}>
                      <FileUp size={16} className="account-pending-icon" aria-hidden="true" />
                      <div className="account-pending-info">
                        <strong className="ellipsis" title={item.name}>{item.name}</strong>
                        <span className="account-pending-meta tabular-nums">
                          <span>单文件</span>
                          <span aria-hidden="true">·</span>
                          <span>预占 {formatBinaryBytes(item.size)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{item.state === 'completing' ? '提交中' : '上传中'}</span>
                          <span aria-hidden="true">·</span>
                          <time dateTime={item.createdAt}>{formatUploadTime(item.createdAt)}</time>
                        </span>
                      </div>
                      <button
                        type="button"
                        className="ghost account-pending-cancel"
                        disabled={Boolean(cancellingKey)}
                        onClick={() => void cancelPendingUpload(item)}
                      >
                        {busy ? '正在取消…' : '取消上传'}
                      </button>
                    </li>
                  )
                })}

                {summary.pendingBatches.map(batch => {
                  const key = `batch:${batch.id}`
                  const busy = cancellingKey === key
                  return (
                    <li key={key} className="account-pending-item" data-pending-kind="batch" data-pending-id={batch.id}>
                      <FolderUp size={16} className="account-pending-icon" aria-hidden="true" />
                      <div className="account-pending-info">
                        <strong className="ellipsis" title={batch.name}>{batch.name}</strong>
                        <span className="account-pending-meta tabular-nums">
                          <span>文件夹 · {batch.fileCount} 个文件</span>
                          <span aria-hidden="true">·</span>
                          <span>总计 {formatBinaryBytes(batch.totalBytes)}</span>
                          <span aria-hidden="true">·</span>
                          {batch.committedBytes > 0 ? (
                            <span>已提交 {formatBinaryBytes(batch.committedBytes)} / 预占 {formatBinaryBytes(batch.reservedBytes)}</span>
                          ) : (
                            <span>预占 {formatBinaryBytes(batch.reservedBytes)}</span>
                          )}
                          <span aria-hidden="true">·</span>
                          <time dateTime={batch.createdAt}>{formatUploadTime(batch.createdAt)}</time>
                        </span>
                      </div>
                      <button
                        type="button"
                        className="ghost account-pending-cancel"
                        disabled={Boolean(cancellingKey)}
                        onClick={() => void cancelPendingBatch(batch)}
                      >
                        {busy ? '正在取消…' : '取消上传'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
