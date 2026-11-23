import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { FolderPlus, Trash2, X } from 'lucide-react'
import { api } from './api/client'
import { DirectoryPicker } from './DirectoryPicker'
import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']

export function CreateFolderDialog({ parentId, close, created }: {
  parentId?: number
  close: () => void
  created: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  function dismiss() {
    if (busy) return
    dialogRef.current?.close()
    close()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const name = String(new FormData(event.currentTarget).get('name'))
    setBusy(true)
    setError('')
    try {
      const { response } = await api.POST('/tree', { body: { name, parentId } })
      if (response.ok) {
        dialogRef.current?.close()
        created()
      } else {
        setError(response.status === 409 ? '此位置已有同名项目，请更换名称'
          : response.status === 400 ? '名称不可用，请检查后重试'
          : response.status === 403 ? '当前账户没有此操作的权限' : '创建失败，请重试')
      }
    } catch {
      setError('无法连接服务，请重试')
    } finally {
      setBusy(false)
    }
  }

  return <dialog ref={dialogRef} className="action-dialog" aria-labelledby="create-folder-title"
    onCancel={event => { event.preventDefault(); dismiss() }}
    onClick={event => { if (event.target === event.currentTarget) dismiss() }}>
    <header className="action-dialog-header">
      <FolderPlus size={18} className="action-dialog-icon" aria-hidden="true" />
      <h2 id="create-folder-title">新建文件夹</h2>
      <button type="button" className="ghost icon dialog-close" title="关闭" aria-label="关闭" disabled={busy} onClick={dismiss}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    <form className="stack action-dialog-form" onSubmit={event => void submit(event)}>
      <label>目录名称<input name="name" autoFocus readOnly={busy} required maxLength={255} /></label>
      {error && <p className="banner error" role="alert">{error}</p>}
      <div className="action-dialog-footer">
        <button type="button" className="ghost" disabled={busy} onClick={dismiss}>取消</button>
        <button className="primary" disabled={busy}>{busy ? '正在创建…' : '创建'}</button>
      </div>
    </form>
  </dialog>
}

export function RenameDialog({ node, close, renamed }: {
  node: Node
  close: () => void
  renamed: (nextName: string) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    const input = inputRef.current
    if (input) {
      input.focus()
      const dot = node.isFile ? node.name.lastIndexOf('.') : -1
      input.setSelectionRange(0, dot > 0 ? dot : node.name.length)
    }
  }, [node.id, node.isFile, node.name])

  function dismiss() {
    if (busy) return
    dialogRef.current?.close()
    close()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const name = String(new FormData(event.currentTarget).get('name'))
    setBusy(true)
    setError('')
    try {
      const { response } = await api.POST('/tree/{id}/rename', {
        params: { path: { id: node.id } },
        body: { name },
      })
      if (response.ok) {
        dialogRef.current?.close()
        renamed(name)
      } else {
        setError(response.status === 409 ? '此位置已有同名项目，请更换名称'
          : response.status === 400 ? '名称不可用，请检查后重试'
          : response.status === 403 ? '当前账户没有重命名权限' : '保存失败，请重试')
      }
    } catch {
      setError('无法连接服务，请重试')
    } finally {
      setBusy(false)
    }
  }

  return <dialog ref={dialogRef} className="action-dialog" aria-labelledby="rename-dialog-title"
    onCancel={event => { event.preventDefault(); dismiss() }}
    onClick={event => { if (event.target === event.currentTarget) dismiss() }}>
    <header className="action-dialog-header">
      <h2 id="rename-dialog-title">重命名</h2>
      <button type="button" className="ghost icon dialog-close" title="关闭" aria-label="关闭" disabled={busy} onClick={dismiss}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    <form className="stack action-dialog-form" onSubmit={event => void submit(event)}>
      <label>新名称<input ref={inputRef} name="name" defaultValue={node.name} readOnly={busy} required maxLength={255} /></label>
      {error && <p className="banner error" role="alert">{error}</p>}
      <div className="action-dialog-footer">
        <button type="button" className="ghost" disabled={busy} onClick={dismiss}>取消</button>
        <button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存'}</button>
      </div>
    </form>
  </dialog>
}

export function MoveDialog({ node, administrator, close, moved }: {
  node: Node
  administrator: boolean
  close: () => void
  moved: (parentId: number | null) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  function dismiss() {
    if (busy) return
    dialogRef.current?.close()
    close()
  }

  async function move(parentId: number | null) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const { response } = await api.POST('/tree/{id}/move', {
        params: { path: { id: node.id } },
        body: { parentId },
      })
      if (response.ok) {
        dialogRef.current?.close()
        moved(parentId)
      } else {
        setError(response.status === 409 ? '目标位置已有同名项目，或目标位于自身子目录'
          : response.status === 403 ? '当前账户没有移动到此目录的权限' : '移动失败，请重试')
      }
    } catch {
      setError('无法连接服务，请重试')
    } finally {
      setBusy(false)
    }
  }

  return <dialog ref={dialogRef} className="action-dialog move-dialog" aria-labelledby="move-dialog-title"
    onCancel={event => { event.preventDefault(); dismiss() }}
    onClick={event => { if (event.target === event.currentTarget) dismiss() }}>
    <header className="action-dialog-header">
      <h2 id="move-dialog-title" title={node.name}>移动「{node.name}」</h2>
      <button type="button" className="ghost icon dialog-close" title="关闭" aria-label="关闭" disabled={busy} onClick={dismiss}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    <div className="move-dialog-body">
      <DirectoryPicker label="移动目标" submitLabel="移动到此目录" administrator={administrator}
        excludeId={node.id} busy={busy} choose={id => void move(id)} close={dismiss} />
      {error && <p className="banner error" role="alert">{error}</p>}
    </div>
  </dialog>
}

export function DeleteFolderDialog({ node, location, busy, close, confirm }: {
  node: Node
  location?: string
  busy: boolean
  close: () => void
  confirm: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  function dismiss() {
    if (busy) return
    dialogRef.current?.close()
    close()
  }

  const fullPath = location ? `${location} / ${node.name}` : node.name

  return <dialog ref={dialogRef} className="action-dialog" aria-labelledby="delete-folder-title"
    onCancel={event => { event.preventDefault(); dismiss() }}
    onClick={event => { if (event.target === event.currentTarget) dismiss() }}>
    <header className="action-dialog-header">
      <Trash2 size={18} className="action-dialog-icon danger" aria-hidden="true" />
      <h2 id="delete-folder-title">移入回收站</h2>
      <button type="button" className="ghost icon dialog-close" title="关闭" aria-label="关闭" disabled={busy} onClick={dismiss}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    <div className="action-dialog-warning-group">
      <p className="action-dialog-warning">「{node.name}」及其全部内容将移入回收站，可在 30 天内恢复。</p>
      <p className="action-dialog-path" title={fullPath}>位置：{fullPath}</p>
    </div>
    <div className="action-dialog-footer">
      <button type="button" className="ghost" disabled={busy} onClick={dismiss} autoFocus>取消</button>
      <button type="button" className="danger-button" disabled={busy} onClick={confirm}>
        {busy ? '正在移入…' : '移入回收站'}
      </button>
    </div>
  </dialog>
}
