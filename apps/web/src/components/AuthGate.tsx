import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { dispatcherAuth } from '../lib/auth'

export function DispatcherLogout() {
  const [error, setError] = useState('')
  return <><button type="button" onClick={() => { void dispatcherAuth.logout().then(() => window.dispatchEvent(new Event('ops:session-expired'))).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Не удалось выйти')) }}>Выйти</button>{error && <span role="alert">{error}</span>}</>
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const expired = () => { setAuthenticated(false); setError('Сессия завершена. Войдите снова.') }
    window.addEventListener('ops:session-expired', expired)
    void dispatcherAuth.session().then(session => { if (active) setAuthenticated(session.authenticated) }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Не удалось проверить вход') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; window.removeEventListener('ops:session-expired', expired) }
  }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError('')
    try { const session = await dispatcherAuth.login(password); setAuthenticated(session.authenticated); setPassword('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось войти') }
    finally { setLoading(false) }
  }
  if (authenticated) return <>{children}</>
  return <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24, background: '#f3f6fa' }}>
    <form onSubmit={event => { void submit(event) }} style={{ width: 'min(100%, 380px)', padding: 32, borderRadius: 20, background: '#fff', boxShadow: '0 12px 40px #1232' }}>
      <h1 style={{ margin: '0 0 12px' }}>OPS Disponent</h1>
      <p>Вход в диспетчерскую</p>
      <label htmlFor="dispatcher-password">Пароль</label>
      <input id="dispatcher-password" type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} style={{ display: 'block', boxSizing: 'border-box', width: '100%', padding: 12, margin: '8px 0 16px', border: '1px solid #cbd5e1', borderRadius: 8 }} />
      {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
      <button type="submit" disabled={loading} style={{ width: '100%', padding: 12, border: 0, borderRadius: 8, background: '#1461a8', color: 'white', cursor: loading ? 'wait' : 'pointer' }}>{loading ? 'Подключение…' : 'Войти'}</button>
    </form>
  </main>
}
