import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Pencil, ShieldCheck } from 'lucide-react'
import { api } from './api/client'
import { PageHeading } from './PageHeading'

export function UploadSettings() {
  const [saved, setSaved] = useState<string[]>()
  const [draft, setDraft] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const editButton = useRef<HTMLButtonElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const restoreFocus = useRef(false)
  const editing = draft !== undefined
  const changed = editing && saved?.join(', ') !== draft

  useLayoutEffect(() => {
    if (editing) editor.current?.focus()
    else if (restoreFocus.current) {
      restoreFocus.current = false
      editButton.current?.focus()
    }
  }, [editing])

  async function load(signal?: AbortSignal) {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.GET('/upload-policy', { signal })
      if (signal?.aborted) return
      if (!data) { setError('无法读取上传限制'); return }
      setSaved(data.blockedExtensions ?? [])
    } catch {
      if (!signal?.aborted) setError('无法连接服务')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (draft === undefined || !changed || saving) return
    const blockedExtensions = draft.split(/[,，\n]/).map(value => value.trim()).filter(Boolean)
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const { data, response } = await api.PUT('/upload-policy', { body: { blockedExtensions } })
      if (data) {
        setSaved(data.blockedExtensions ?? [])
        setDraft(undefined)
        setMessage('上传限制已保存')
      } else setError(response.status === 400 ? '扩展名无效，请检查格式' : '无法保存上传限制')
    } catch {
      setError('无法连接服务')
    } finally {
      setSaving(false)
    }
  }

  return <section className="workspace-page upload-settings" aria-label="系统设置">
    <PageHeading title="系统设置" />
    <OfficeEditSetting />
    <section className="panel upload-policy" aria-labelledby="upload-policy-title">
      <div className="upload-policy-heading">
        <span className="upload-policy-icon"><ShieldCheck size={18} aria-hidden="true" /></span>
        <div>
          <h2 id="upload-policy-title">上传扩展名限制</h2>
          <p>匹配列表中扩展名的文件会在上传前被拒绝</p>
        </div>
        {saved && !editing && <button type="button" ref={editButton} onClick={() => {
          setError('')
          setMessage('')
          restoreFocus.current = true
          setDraft(saved.join(', '))
        }}><Pencil size={16} />编辑规则</button>}
      </div>
      <div className="upload-policy-content">
        {loading && <p className="banner" role="status">正在加载上传限制…</p>}
        {error && <p className="banner error" role="alert">{error}</p>}
        {message && <p className="banner success" role="status">{message}</p>}
        {!loading && !saved && <button type="button" onClick={() => void load()}>重新加载</button>}
        {saved && !editing && <>
          <div className="upload-policy-summary">
            <h3>当前禁止的扩展名</h3>
            <span className="muted">{saved.length} 项</span>
          </div>
          {saved.length ? <ul className="upload-policy-extensions" aria-label="当前禁止的扩展名">
            {saved.map((extension, index) => <li key={index}><code>.{extension}</code></li>)}
          </ul> : <p className="muted upload-policy-empty">当前允许上传任意扩展名的文件</p>}
        </>}
        {editing && <form className="panel-form upload-policy-form" onSubmit={save}>
          <label>禁止扩展名<textarea ref={editor} rows={4} value={draft} onChange={event => {
            setDraft(event.target.value)
            setError('')
          }} placeholder="exe, bat, sh" aria-describedby="extensions-hint" disabled={saving} spellCheck={false} /></label>
          <small className="muted" id="extensions-hint">使用逗号或换行分隔。清空列表后保存可移除全部限制。</small>
          <div className="form-actions">
            <button type="button" disabled={saving} onClick={() => { setDraft(undefined); setError('') }}>取消</button>
            <button className="primary" disabled={!changed || saving}>{saving ? '正在保存…' : '保存上传限制'}</button>
          </div>
        </form>}
      </div>
    </section>
  </section>
}

function OfficeEditSetting() {
  const [enabled, setEnabled] = useState<boolean>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    setError('')
    void api.GET('/office-edit-policy', { signal }).then(({ data }) => {
      if (signal.aborted) return
      if (data) setEnabled(data.enabled)
      else setError('无法读取 Office 编辑设置')
    }).catch(() => { if (!signal.aborted) setError('无法连接服务') })
    return () => controller.abort()
  }, [attempt])

  async function change(value: boolean) {
    const previous = enabled
    setEnabled(value)
    setSaving(true)
    setError('')
    try {
      const { data } = await api.PUT('/office-edit-policy', { body: { enabled: value } })
      if (data) setEnabled(data.enabled)
      else { setEnabled(previous); setError('保存失败，请重试') }
    } catch {
      setEnabled(previous)
      setError('无法连接服务，请重试')
    } finally {
      setSaving(false)
    }
  }
  return <section className="panel upload-policy" aria-labelledby="office-setting-title">
    <div className="upload-policy-heading">
      <span className="upload-policy-icon"><Pencil size={18} aria-hidden="true" /></span>
      <div><h2 id="office-setting-title">Office 在线编辑</h2>
        <p id="office-setting-hint">启用后，有修改权限的用户可通过 WPS 插件编辑文件。关闭后将暂停编辑与保存，只读预览仍可使用。</p>
      </div>
      <label className="office-policy-toggle"><input type="checkbox" role="switch" aria-label="启用 Office 在线编辑"
        aria-describedby="office-setting-hint" checked={enabled === true} disabled={enabled === undefined || saving}
        onChange={event => void change(event.target.checked)} />
        {saving ? '保存中…' : enabled === undefined ? '读取中…' : enabled ? '已启用' : '已关闭'}
      </label>
    </div>
    {error && <p role="alert" className="banner error">{error} {enabled === undefined &&
      <button onClick={() => retry(n => n + 1)}>重试</button>}</p>}
  </section>
}
