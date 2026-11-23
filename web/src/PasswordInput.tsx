import { useId, useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export function PasswordInput({ label = '密码', ...props }: Omit<ComponentProps<'input'>, 'type' | 'id'> & { label?: string }) {
  const id = useId()
  const [visible, setVisible] = useState(false)
  const Icon = visible ? EyeOff : Eye

  return <div className="auth-field">
    <label htmlFor={id}>{label}</label>
    <div className="password-control">
      <input {...props} id={id} type={visible ? 'text' : 'password'} spellCheck={false} autoCapitalize="none" />
      <button type="button" className="ghost icon" aria-label={visible ? '隐藏输入内容' : '显示输入内容'}
        title={visible ? '隐藏密码' : '显示密码'}
        aria-controls={id} onClick={() => setVisible(value => !value)}>
        <Icon size={16} aria-hidden="true" />
      </button>
    </div>
  </div>
}
