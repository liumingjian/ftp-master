import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { api } from './api/client'
import type { components } from './api/schema.gen'
import {
  editQuotaWarning,
  formatQuotaExceededError,
  isQuotaExceededError,
  utf8ByteLength,
  type QuotaExceededPayload,
} from './quota'

type Node = components['schemas']['TreeNode']

const textFormats = /^(txt|md|csv|json|xml|log|yaml|yml|toml|ini|conf)$/i

export function canEditText(node: Node): boolean {
  return Boolean(node.isFile && (node.rights & 8) && node.latestVersion && textFormats.test(node.latestVersion.format))
}

export function TextEditorDialog({ node, availableQuotaBytes, close, saved }: {
  node: Node
  availableQuotaBytes?: number | null
  close: () => void
  saved: () => void
}) {
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [base, setBase] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [serverAvailableQuota, setServerAvailableQuota] = useState<number | null | undefined>(undefined)
  const [message, setMessage] = useState<{ text: string; error: boolean }>()
  const [busy, setBusy] = useState<'load' | 'save' | undefined>('load')
  const dialog = useRef<HTMLDialogElement>(null)
  const editorId = `editor-heading-${node.id}`

  useLayoutEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  async function load(signal?: AbortSignal) {
    setBusy('load')
    setMessage(undefined)
    try {
      const { data, error, response } = await api.GET('/tree/{id}/text', { params: { path: { id: node.id } }, signal })
      if (signal?.aborted) return
      if (data) {
        setContent(data.content)
        setSavedContent(data.content)
        setBase(data.versionId)
        setServerAvailableQuota(data.availableQuotaBytes)
        setLoaded(true)
      } else if (isQuotaExceededError(response.status, error)) {
        const payload = error as QuotaExceededPayload | undefined
        setServerAvailableQuota(payload?.availableBytes ?? 0)
        const detail = formatQuotaExceededError(payload, '当前存储配额不足')
        setMessage({ text: `暂无法打开编辑：${detail}`, error: true })
      } else {
        setMessage({ text: `无法加载文本内容（HTTP ${response.status}）`, error: true })
      }
    } catch {
      if (!signal?.aborted) setMessage({ text: '无法连接服务器', error: true })
    } finally {
      if (!signal?.aborted) setBusy(undefined)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [node.id])

  function confirmDiscard() {
    return !loaded || content === savedContent || window.confirm('有未保存的文本修改，确定放弃吗？')
  }

  function dismiss() {
    if (busy === 'save' || !confirmDiscard()) return
    dialog.current?.close()
    close()
  }

  async function save() {
    if (busy || !loaded) return
    setBusy('save')
    setMessage(undefined)
    try {
      const { data, error, response } = await api.PUT('/tree/{id}/text', {
        params: { path: { id: node.id } },
        body: { baseVersionId: base, content },
      })
      if (data) {
        const savedBytes = utf8ByteLength(content)
        setBase(data.versionId)
        setSavedContent(content)
        setServerAvailableQuota(previous => previous == null ? previous : Math.max(0, previous - savedBytes))
        setMessage({ text: '已保存为新版本', error: false })
        saved()
      } else if (isQuotaExceededError(response.status, error)) {
        const payload = error as QuotaExceededPayload | undefined
        if (typeof payload?.availableBytes === 'number') {
          setServerAvailableQuota(payload.availableBytes)
        }
        const detail = formatQuotaExceededError(payload, '存储配额不足，无法保存新版本')
        setMessage({ text: `${detail}，修改仍保留在编辑器中`, error: true })
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

  const effectiveAvailableQuota = serverAvailableQuota !== undefined ? serverAvailableQuota : availableQuotaBytes
  const quotaWarning = loaded ? editQuotaWarning(effectiveAvailableQuota, utf8ByteLength(content)) : undefined

  return <dialog ref={dialog} className="text-dialog" aria-labelledby={editorId}
    onCancel={event => {
      event.preventDefault()
      dismiss()
    }}
    onClick={event => { if (event.target === event.currentTarget) dismiss() }}>
    <div className="drawer-heading">
      <Pencil size={18} aria-hidden="true" /><h2 id={editorId}>{node.name}</h2>
      <button type="button" className="ghost icon" title="关闭" aria-label="关闭编辑" disabled={busy === 'save'}
        onClick={dismiss}><X size={18} aria-hidden="true" /></button>
    </div>
    {busy === 'load' && !loaded ? <p className="muted" role="status">正在加载文本…</p> : !loaded && message?.error ? <div className="edit-form">
      <p className="banner error" role="alert">{message.text}</p>
      <div className="form-actions">
        <button type="button" disabled={!!busy} onClick={() => void load()}>重新加载</button>
        <button type="button" onClick={dismiss}>关闭</button>
      </div>
    </div> : <form className="edit-form" onSubmit={event => { event.preventDefault(); void save() }}>
      {quotaWarning && <p className="banner warning" role="status">{quotaWarning}</p>}
      <label>文本内容<textarea value={content} onChange={event => setContent(event.target.value)} spellCheck={false} readOnly={!!busy || !loaded} /></label>
      {message && <p className={`banner ${message.error ? 'error' : 'success'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      <div className="form-actions">
        <button className="primary" disabled={!!busy || !loaded}>{busy === 'save' ? '正在保存…' : '保存文本'}</button>
        <button type="button" disabled={!!busy} onClick={() => { if (confirmDiscard()) void load() }}>重新加载</button>
      </div>
    </form>}
  </dialog>
}

export function TextEditor({ node, availableQuotaBytes, saved }: {
  node: Node
  availableQuotaBytes?: number | null
  saved: () => void
}) {
  const [open, setOpen] = useState(false)
  if (!canEditText(node)) return null
  const warning = node.latestVersion ? editQuotaWarning(availableQuotaBytes, node.latestVersion.size) : undefined
  return <>
    <button type="button" className={warning ? 'quota-tight' : undefined} title={warning} onClick={() => setOpen(true)}>
      <Pencil size={15} aria-hidden="true" />编辑文本
    </button>
    {open && <TextEditorDialog node={node} availableQuotaBytes={availableQuotaBytes} saved={saved} close={() => setOpen(false)} />}
  </>
}
