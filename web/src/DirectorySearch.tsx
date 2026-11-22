import { Search } from 'lucide-react'

export function DirectorySearch({ label, value, onChange }: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return <label className="directory-search">
    <Search size={16} aria-hidden="true" />
    <input type="search" aria-label={label} placeholder={label} value={value}
      onChange={event => onChange(event.target.value)} />
  </label>
}

export function matchesSearch(query: string, ...values: string[]) {
  const haystack = values.join(' ').toLocaleLowerCase()
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => haystack.includes(word))
}
