import type { FormEventHandler, ReactNode } from 'react'
import { PlatformBrand, platformName } from './PlatformBrand'
import archiveImage from './assets/archive.webp'

export function AuthLayout({ title, description, hideHeading, onSubmit, children, footer }: {
  title: string
  description?: string
  hideHeading?: boolean
  onSubmit: FormEventHandler<HTMLFormElement>
  children: ReactNode
  footer: ReactNode
}) {
  return <main className="sign-in" data-theme={localStorage.getItem('ftp-theme')}>
    <div className="auth-visual" aria-hidden="true">
      <img src={archiveImage} width="1122" height="1402" alt="" fetchPriority="high" />
      <p>{platformName}</p>
    </div>
    <div className="auth-content">
      <div className="brand"><PlatformBrand /></div>
      <form className="sign-in-form" onSubmit={onSubmit}>
        <div className={hideHeading ? 'auth-heading visually-hidden' : 'auth-heading'}>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {children}
      </form>
      <div className="auth-footer">{footer}</div>
    </div>
  </main>
}
