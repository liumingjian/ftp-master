import { useEffect, useRef, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { api } from './api/client'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']

export function TextEditor({ node, saved }: { node: Node; saved: () => void }) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [base, setBase] = useState(0)
  const [message, setMessage] = useState<{ text: string; error: boolean }>()
  const [busy, setBusy] = useState<'load' | 'save'>()
  const dialog = useRef<HTMLDialogElement>(null)
  const editorId = `editor-heading-${node.id}`

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal()
  }, [open])

  async function load() {
    if (busy) return
    setBusy('load')
    setMessage(undefined)
    try {
      const { data, response } = await api.GET('/tree/{id}/text', { params: { path: { id: node.id } } })
      if (data) {
        setContent(data.content)
        setSavedContent(data.content)
        setBase(data.versionId)
        setOpen(true)
      } else setMessage({ text: `无法编辑（HTTP ${response.status}）`, error: true })
    } catch {
      setMessage({ text: '无法连接服务器', error: true })
    } finally {
      setBusy(undefined)
    }
  }

  function confirmDiscard() {
    return content === savedContent || window.confirm('有未保存的文本修改，确定放弃吗？')
  }

  async function save() {
    if (busy) return
    setBusy('save')
    setMessage(undefined)
    try {
      const { data, response } = await api.PUT('/tree/{id}/text', {
        params: { path: { id: node.id } }, body: { baseVersionId: base, content },
      })
      if (data) {
        setBase(data.versionId)
        setSavedContent(content)
        setMessage({ text: '已保存为新版本', error: false })
        saved()
      } else {
        const text = response.status === 409
          ? '文件已被他人修改，请先复制您的修改，重新加载后合并。'
          : `保存失败（HTTP ${response.status}）`
        setMessage({ text, error: true })
      }
    } catch {
      setMessage({ text: '无法连接服务器，修改仍保留在编辑器中', error: true })
    } finally {
      setBusy(undefined)
    }
  }

  if (!(node.rights & 8) || !node.latestVersion ||
    !/^(txt|md|csv|json|xml|log|yaml|yml|toml|ini|conf)$/i.test(node.latestVersion.format)) return null

  const feedback = message && <p className={`banner ${message.error ? 'error' : 'success'}`} role="status">{message.text}</p>
  return <>
    <button disabled={!!busy} onClick={() => void load()}><Pencil size={15} />{busy === 'load' && !open ? '正在打开…' : '编辑文本'}</button>
    {!open && feedback}
    {open && <dialog ref={dialog} className="text-dialog" aria-labelledby={editorId}
      onCancel={event => { if (busy || !confirmDiscard()) event.preventDefault() }} onClose={() => { setOpen(false); setMessage(undefined) }}>
      <div className="drawer-heading">
        <Pencil size={18} /><h2 id={editorId}>{node.name}</h2>
        <button className="ghost icon" aria-label="关闭编辑" disabled={!!busy}
          onClick={() => { if (confirmDiscard()) dialog.current?.close() }}><X size={18} /></button>
      </div>
      <form className="edit-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <label>文本内容<textarea value={content} onChange={event => setContent(event.target.value)} spellCheck={false} readOnly={!!busy} /></label>
        {feedback}
        <div className="form-actions">
          <button className="primary" disabled={!!busy}>{busy === 'save' ? '正在保存…' : '保存文本'}</button>
          <button type="button" disabled={!!busy} onClick={() => { if (confirmDiscard()) void load() }}>重新加载文本</button>
        </div>
      </form>
    </dialog>}
  </>
}
