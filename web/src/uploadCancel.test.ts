// Pure-unit tests, run by `pnpm test:unit` with Node's own test runner.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyCancelOutcome, folderBatchId, isAbortError } from './uploadCancel.ts'

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
