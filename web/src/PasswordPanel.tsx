import { useState, type FormEvent } from 'react'
import { ArrowLeft } from 'lucide-react'
import { AccountStorageSection } from './AccountStorageSection'
import { api, type CurrentUser } from './api/client'
import type { SelfStorageSummary } from './SidebarStorageBar'
import { avatarInitial } from './avatar'
import { PageHeading } from './PageHeading'
import { PasswordInput } from './PasswordInput'

export function PasswordPanel({
  user,
  organizationPath,
  onBackToFiles,
  storageSummary,
  storageLoading = false,
  storageError,
  onRefreshStorage,
}: {
  user: CurrentUser
  organizationPath?: string
  onBackToFiles: () => void
  storageSummary?: SelfStorageSummary
  storageLoading?: boolean
  storageError?: string
  onRefreshStorage?: () => void
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean }>()

  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (newPassword !== confirmPassword) {
      setFeedback({ text: '两次输入的新密码不一致', ok: false })
      return
    }
    setBusy(true)
    setFeedback(undefined)
    try {
      const { response } = await api.PUT('/password', {
        body: { currentPassword, newPassword },
      })
      if (response.ok) {
        setFeedback({ text: '密码已修改', ok: true })
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
      } else {
        setFeedback({ text: '修改失败，请检查当前密码', ok: false })
      }
    } catch {
      setFeedback({ text: '无法连接服务，请重试', ok: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="workspace-page account-page" aria-label="账户设置">
      <PageHeading title="账户设置"
        actions={<button type="button" className="ghost" onClick={onBackToFiles}>
          <ArrowLeft size={16} aria-hidden="true" />返回文件
        </button>} />

      <div className="account-stack">
        <div className="panel account-card">
          <div className="account-identity" aria-label="账号信息">
            <span className="avatar account-avatar" aria-hidden="true">{avatarInitial(user.displayName)}</span>
            <div className="account-identity-text">
              <div className="account-title-row">
                <strong>{user.displayName}</strong>
                <span className="pill account-role">{user.isAdministrator ? '系统管理员' : '授权用户'}</span>
              </div>
              <p className="account-meta">
                <span className="account-mono">{user.username}</span>
                <span aria-hidden="true">·</span>
                <span className="account-mono tabular-nums">#{user.id}</span>
                {organizationPath && <>
                  <span aria-hidden="true">·</span>
                  <span>{organizationPath}</span>
                </>}
              </p>
            </div>
          </div>

          <form className="panel-form account-password-form" onSubmit={event => void submit(event)}>
            <input type="hidden" name="username" value={user.username} autoComplete="username" />
            <div className="account-password-fields">
              <PasswordInput label="当前密码" name="currentPassword" autoComplete="current-password"
                required maxLength={1024} value={currentPassword}
                onChange={event => { setCurrentPassword(event.target.value); setFeedback(undefined) }} />
              <PasswordInput label="新密码" name="newPassword" autoComplete="new-password"
                required maxLength={1024} value={newPassword}
                onChange={event => { setNewPassword(event.target.value); setFeedback(undefined) }} />
              <div className="account-confirm-field">
                <PasswordInput label="确认新密码" name="confirmPassword" autoComplete="new-password"
                  required maxLength={1024} value={confirmPassword}
                  aria-invalid={mismatch || undefined}
                  aria-describedby={mismatch ? 'password-mismatch-hint' : undefined}
                  onChange={event => { setConfirmPassword(event.target.value); setFeedback(undefined) }} />
                {mismatch && <small id="password-mismatch-hint" className="danger account-inline-error">两次输入的新密码不一致</small>}
              </div>
            </div>

            <div className="account-form-footer">
              <div className="account-footer-left">
                <button className="primary" disabled={busy}>{busy ? '正在修改…' : '修改密码'}</button>
                {feedback && (
                  <p className={`banner ${feedback.ok ? 'success' : 'error'}`} role="status">{feedback.text}</p>
                )}
              </div>
              {!feedback && <span className="account-side-effect">修改后当前会话保持有效</span>}
            </div>
          </form>
        </div>

        <AccountStorageSection
          summary={storageSummary}
          loading={storageLoading}
          error={storageError}
          onRefresh={() => onRefreshStorage?.()}
        />
      </div>
    </section>
  )
}
