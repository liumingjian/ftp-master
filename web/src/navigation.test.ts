// Pure-unit tests, run by `pnpm test:unit` with Node's own test runner.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathAfterSignIn } from './navigation.ts'

test('returns to the page the visitor asked for', () => {
  assert.equal(pathAfterSignIn('?next=%2Ffiles%2Fa%3Fview%3Dlist%23top'), '/files/a?view=list#top')
})

test('goes home without a next page', () => {
  assert.equal(pathAfterSignIn(''), '/')
  assert.equal(pathAfterSignIn('?next='), '/')
})

test('never leaves the site after signing in', () => {
  for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example/', 'javascript:alert(1)', 'files']) {
    assert.equal(pathAfterSignIn(`?next=${encodeURIComponent(next)}`), '/', next)
  }
})

test('does not loop back to sign-in', () => {
  assert.equal(pathAfterSignIn('?next=%2Fsign-in%3Fnext%3D%252F'), '/')
})
