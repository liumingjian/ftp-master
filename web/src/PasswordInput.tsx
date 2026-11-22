import { useId, useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export function PasswordInput(props: Omit<ComponentProps<'input'>, 'type' | 'id'>) {
  const id = useId()
  const [visible, setVisible] = useState(false)
  const Icon = visible ? EyeOff : Eye

  return <div className="auth-field">
    <label htmlFor={id}>密码</label>
    <div className="password-control">
      <input {...props} id={id} type={visible ? 'text' : 'password'} spellCheck={false} autoCapitalize="none" />
      <button type="button" className="ghost icon" aria-label={visible ? '隐藏输入内容' : '显示输入内容'}
        aria-controls={id} onClick={() => setVisible(value => !value)}>
        <Icon size={16} aria-hidden="true" />
      </button>
    </div>
  </div>
}
