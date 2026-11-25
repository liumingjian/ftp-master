export type CancelOutcome = 'cleared' | 'already_completed' | 'retry'

export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError'
}

export function classifyCancelOutcome(status: number | undefined): CancelOutcome {
  if (status === 204 || status === 404) return 'cleared'
  if (status === 409) return 'already_completed'
  return 'retry'
}

export function folderBatchId(
  manifest: { batchId?: string; files?: { batchId?: string }[] } | undefined,
): string | undefined {
  if (!manifest) return undefined
  if (manifest.batchId) return manifest.batchId
  const childBatchId = manifest.files?.find(file => Boolean(file.batchId))?.batchId
  return childBatchId || undefined
}

export interface StorageLike {
  getItem(key: string): string | null
  removeItem(key: string): void
}

export const STORAGE_UPLOAD_CANCELLED_EVENT = 'ftp-storage-upload-cancelled'

export interface StorageUploadCancelledDetail {
  kind: 'upload' | 'batch'
  id: string
  parentId: number
}

export function clearMatchingUploadResume(storage: StorageLike, parentId: number, uploadId: string): boolean {
  const key = `ftp-upload:${parentId}`
  try {
    const raw = storage.getItem(key)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { id?: unknown } | null
    if (parsed?.id === uploadId) {
      storage.removeItem(key)
      return true
    }
  } catch {
    return false
  }
  return false
}

export function clearMatchingBatchResume(storage: StorageLike, parentId: number, batchId: string): boolean {
  const key = `ftp-folder:${parentId}`
  try {
    const raw = storage.getItem(key)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { batchId?: string; files?: { batchId?: string }[] } | null
    if (folderBatchId(parsed ?? undefined) === batchId) {
      storage.removeItem(key)
      return true
    }
  } catch {
    return false
  }
  return false
}

export function notifyStorageUploadCancelled(detail: StorageUploadCancelledDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<StorageUploadCancelledDetail>(STORAGE_UPLOAD_CANCELLED_EVENT, { detail }))
}
