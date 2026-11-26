import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatFileTypeLabel, resolveFileIcon } from './fileIconKind.ts'

describe('resolveFileIcon', () => {
  it('classifies normal, drop-box, and traversable folders', () => {
    assert.deepEqual(resolveFileIcon({ isFile: false, name: '合同', rights: 1 }), {
      kind: 'folder',
      icon: 'file-folder',
    })
    assert.deepEqual(resolveFileIcon({ isFile: false, name: '报送投递箱', rights: 4 }), {
      kind: 'folder-dropbox',
      icon: 'file-folder-dropbox',
    })
    assert.deepEqual(resolveFileIcon({ isFile: false, name: '总行', rights: 0, traversable: true }), {
      kind: 'folder-traversable',
      icon: 'file-folder-traversable',
    })
  })

  it('classifies office, pdf, text, media, archive, and generic files', () => {
    const cases: Array<[string, string, string]> = [
      ['report.docx', 'word', 'file-word'],
      ['draft.wps', 'word', 'file-word'],
      ['ledger.xlsx', 'sheet', 'file-sheet'],
      ['export.csv', 'sheet', 'file-sheet'],
      ['deck.pptx', 'slides', 'file-slides'],
      ['signed.pdf', 'pdf', 'file-pdf'],
      ['notes.md', 'text', 'file-text'],
      ['config.yaml', 'text', 'file-text'],
      ['scan.webp', 'image', 'file-image'],
      ['briefing.mp4', 'video', 'file-video'],
      ['recording.m4a', 'audio', 'file-audio'],
      ['bundle.zip', 'archive', 'file-archive'],
      ['README', 'generic', 'file-generic'],
      ['binary.dat', 'dat', 'file-generic'],
    ]
    for (const [name, kind, icon] of cases) {
      assert.deepEqual(resolveFileIcon({ isFile: true, name, rights: 1 }), { kind, icon })
    }
  })

  it('prefers latestVersion.format over filename extension', () => {
    assert.deepEqual(
      resolveFileIcon({ isFile: true, name: 'renamed.txt', rights: 1, latestVersion: { format: 'pdf' } }),
      { kind: 'pdf', icon: 'file-pdf' },
    )
    assert.equal(
      formatFileTypeLabel({ isFile: true, name: 'deck.pptx', rights: 1, latestVersion: { format: 'pptx' } }),
      'PPT 演示文稿',
    )
  })
})
