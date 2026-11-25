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
