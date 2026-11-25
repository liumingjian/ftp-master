// Pure-unit tests, run by `pnpm test:unit` with Node's own test runner.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyCancelOutcome,
  clearMatchingBatchResume,
  clearMatchingUploadResume,
  folderBatchId,
  isAbortError,
} from './uploadCancel.ts'

test('recognises AbortError from DOMException and Error instances', () => {
  assert.equal(isAbortError(new DOMException('Upload cancelled', 'AbortError')), true)
  const err = new Error('aborted')
  err.name = 'AbortError'
  assert.equal(isAbortError(err), true)
  assert.equal(isAbortError(new Error('network error')), false)
  assert.equal(isAbortError('AbortError'), false)
  assert.equal(isAbortError(null), false)
})

test('classifies cancel HTTP statuses into cleared, already_completed, or retry', () => {
  assert.equal(classifyCancelOutcome(204), 'cleared')
  assert.equal(classifyCancelOutcome(404), 'cleared')
  assert.equal(classifyCancelOutcome(409), 'already_completed')
  assert.equal(classifyCancelOutcome(500), 'retry')
  assert.equal(classifyCancelOutcome(503), 'retry')
  assert.equal(classifyCancelOutcome(undefined), 'retry')
})

test('extracts folder batchId from top-level manifest or child session', () => {
  assert.equal(folderBatchId({ batchId: 'batch-1', files: [] }), 'batch-1')
  assert.equal(folderBatchId({ files: [{ batchId: 'batch-2' }] }), 'batch-2')
  assert.equal(folderBatchId({ batchId: '', files: [{ batchId: 'batch-3' }] }), 'batch-3')
  assert.equal(folderBatchId({ files: [{}] }), undefined)
  assert.equal(folderBatchId(undefined), undefined)
})

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => { map.delete(key) },
    has: (key: string) => map.has(key),
  }
}

test('clearMatchingUploadResume removes only matching session key for parentId', () => {
  const store = memoryStorage({
    'ftp-upload:10': JSON.stringify({ id: 'u-1', name: 'a.bin' }),
    'ftp-upload:11': JSON.stringify({ id: 'u-2', name: 'b.bin' }),
  })
  assert.equal(clearMatchingUploadResume(store, 10, 'u-other'), false)
  assert.equal(store.has('ftp-upload:10'), true)

  assert.equal(clearMatchingUploadResume(store, 10, 'u-1'), true)
  assert.equal(store.has('ftp-upload:10'), false)
  assert.equal(store.has('ftp-upload:11'), true)
})

test('clearMatchingBatchResume removes matching batch manifest by top-level or child batchId', () => {
  const store = memoryStorage({
    'ftp-folder:20': JSON.stringify({ batchId: 'b-1', name: 'FolderA', files: [] }),
    'ftp-folder:21': JSON.stringify({ name: 'FolderB', files: [{ batchId: 'b-2', id: 's-1' }] }),
    'ftp-folder:22': 'not-json',
  })
  assert.equal(clearMatchingBatchResume(store, 20, 'b-other'), false)
  assert.equal(store.has('ftp-folder:20'), true)

  assert.equal(clearMatchingBatchResume(store, 20, 'b-1'), true)
  assert.equal(store.has('ftp-folder:20'), false)

  assert.equal(clearMatchingBatchResume(store, 21, 'b-2'), true)
  assert.equal(store.has('ftp-folder:21'), false)

  assert.equal(clearMatchingBatchResume(store, 22, 'b-3'), false)
  assert.equal(store.has('ftp-folder:22'), true)
})
