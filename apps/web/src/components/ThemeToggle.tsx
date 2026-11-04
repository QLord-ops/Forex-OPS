import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { THEME_EVENT, currentTheme, setTheme, type Theme } from '../lib/theme'

/** Day or "Ночная смена": the label says what a click does, the pressed state says what is on. */
export function ThemeToggle({ className = 'theme-toggle' }: { className?: string }) {
  const [theme, setLocal] = useState<Theme>(() => currentTheme())
  useEffect(() => {
    const onChange = (event: Event) => setLocal((event as CustomEvent<Theme>).detail)
    window.addEventListener(THEME_EVENT, onChange)
    return () => window.removeEventListener(THEME_EVENT, onChange)
  }, [])
  const dark = theme === 'dark'
  const label = dark ? 'Светлая тема' : 'Ночная смена'
  return (
    <button type="button" className={className} aria-pressed={dark} aria-label="Ночная смена" title={label} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      {dark ? <Sun className="h-5 w-5" aria-hidden="true" /> : <Moon className="h-5 w-5" aria-hidden="true" />}
      <span className="theme-toggle-label">{label}</span>
    </button>
  )
}
