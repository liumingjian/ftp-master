import type { ReactNode } from 'react'

export function PageHeading({ title, actions }: { title: string; actions?: ReactNode }) {
  return <div className="page-heading">
    <h1>{title}</h1>
    {actions && <div className="page-actions">{actions}</div>}
  </div>
}
