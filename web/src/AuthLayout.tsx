import type { FormEventHandler, ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { PlatformBrand } from './PlatformBrand'
import archiveImage from './assets/archive.webp'

export function AuthLayout({ title, description, onSubmit, children, footer }: {
  title: string
  description?: string
  onSubmit: FormEventHandler<HTMLFormElement>
  children: ReactNode
  footer: ReactNode
}) {
  return <main className="sign-in" data-theme={localStorage.getItem('ftp-theme')}>
    <div className="auth-visual" aria-hidden="true">
      <img src={archiveImage} width="1122" height="1402" alt="" fetchPriority="high" />
    </div>
    <div className="auth-content">
      <div className="brand"><PlatformBrand /></div>
      <form className="sign-in-form" onSubmit={onSubmit}>
        <div className="auth-heading">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {children}
      </form>
      {footer && <div className="auth-footer">{footer}</div>}
      <p className="auth-compliance">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>内部授权访问 · 全部文件操作均纳入安全审计</span>
      </p>
    </div>
  </main>
}
