export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'ops-theme'
export const THEME_EVENT = 'ops:theme-changed'
const THEME_COLOR: Record<Theme, string> = { light: '#ffffff', dark: '#08101b' }

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

function system(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme
  return value === 'dark' || value === 'light' ? value : stored() ?? system()
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }))
}

/** The dispatcher's own choice wins over the system setting and is kept on this computer. */
export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Private mode: the choice lasts until reload.
  }
  apply(theme)
}

/** Until the dispatcher chooses, follow the system's light or dark setting live. */
export function followSystemTheme(): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  if (!media) return () => undefined
  const onChange = () => { if (!stored()) apply(media.matches ? 'dark' : 'light') }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
