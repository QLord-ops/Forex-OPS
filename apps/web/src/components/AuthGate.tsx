import { ArrowRight, Cog, Eye, EyeOff, LockKeyhole } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { DispatcherAuthError, dispatcherAuth } from '../lib/auth'
import './auth-gate.css'

type AuthPhase = 'checking' | 'idle' | 'submitting' | 'success'

function AuthBrand() {
  return <div className="auth-brand" aria-label="OPS FOREX — Fleet Operations">
    <span className="auth-brand__ops">OPS</span>
    <span className="auth-brand__name" aria-hidden="true">
      <span>F</span><span className="auth-brand__gear"><Cog /></span><span>REX</span>
    </span>
    <span className="auth-brand__tagline">FLEET OPERATIONS</span>
  </div>
}

function loginErrorMessage(cause: unknown): string {
  if (cause instanceof DispatcherAuthError) {
    if (cause.status === 401) return 'Incorrect password'
    if (cause.status === 429) return cause.retryAfter
      ? `Too many attempts. Try again in ${Math.ceil(cause.retryAfter / 60)} min.`
      : 'Too many attempts. Please try again later.'
    if (cause.status === 503) return 'Secure access is not configured yet.'
    if (cause.status === 403) return 'This sign-in request was blocked. Refresh the page.'
  }
  return 'Unable to connect. Please try again.'
}

function isPasswordError(cause: unknown): boolean {
  return cause instanceof DispatcherAuthError && cause.status === 401
}

export function DispatcherLogout() {
  const [error, setError] = useState('')
  return <><button type="button" onClick={() => { void dispatcherAuth.logout().then(() => window.dispatchEvent(new Event('ops:session-expired'))).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Не удалось выйти')) }}>Выйти</button>{error && <span role="alert">{error}</span>}</>
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [phase, setPhase] = useState<AuthPhase>('checking')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [error, setError] = useState('')
  const [passwordError, setPasswordError] = useState(false)
  const transitionTimer = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    const expired = () => {
      if (transitionTimer.current) window.clearTimeout(transitionTimer.current)
      setAuthenticated(false)
      setPhase('idle')
      setPassword('')
      setPasswordError(false)
      setError('Your session has ended. Sign in again.')
    }
    window.addEventListener('ops:session-expired', expired)
    void dispatcherAuth.session()
      .then(session => {
        if (!active) return
        setAuthenticated(session.authenticated)
        if (!session.authenticated) setPhase('idle')
      })
      .catch(() => {
        if (!active) return
        setPasswordError(false)
        setError('Unable to verify secure access. Please try again.')
        setPhase('idle')
      })
    return () => {
      active = false
      if (transitionTimer.current) window.clearTimeout(transitionTimer.current)
      window.removeEventListener('ops:session-expired', expired)
    }
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (phase !== 'idle' || !password) return
    setPhase('submitting')
    setPasswordError(false)
    setError('')
    try {
      const session = await dispatcherAuth.login(password)
      if (!session.authenticated) throw new Error('Unauthenticated response')
      setPassword('')
      setPhase('success')
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      transitionTimer.current = window.setTimeout(() => {
        setAuthenticated(true)
      }, reducedMotion ? 80 : 1700)
    } catch (cause) {
      setPasswordError(isPasswordError(cause))
      setError(loginErrorMessage(cause))
      setPhase('idle')
    }
  }

  if (authenticated) return <>{children}</>

  const busy = phase === 'checking' || phase === 'submitting' || phase === 'success'
  return <main className={`auth-shell auth-shell--${phase}`}>
    <section className="auth-hero" aria-hidden="true">
      <img
        className="auth-hero__image"
        src="/media/ops-forex-login-hero.jpg"
        srcSet="/media/ops-forex-login-hero-1280.jpg 1280w, /media/ops-forex-login-hero.jpg 1920w"
        sizes="(max-width: 760px) 100vw, 64vw"
        alt=""
        fetchPriority="high"
      />
      <div className="auth-hero__shade" />
    </section>

    <section className="auth-panel" aria-label="OPS FOREX secure sign in">
      <div className="auth-panel__ambient auth-panel__ambient--one" />
      <div className="auth-panel__ambient auth-panel__ambient--two" />
      <div className="auth-panel__content">
        <AuthBrand />

        {phase === 'checking' ? <div className="auth-session-check" role="status">
          <span className="auth-spinner" />
          <span>VERIFYING SECURE SESSION</span>
        </div> : <form className={`auth-form${passwordError ? ' auth-form--error' : ''}`} onSubmit={event => { void submit(event) }} noValidate>
          <div className="auth-form__heading">
            <h1>WELCOME BACK</h1>
            <p>Sign in to your workspace</p>
          </div>

          <div className="auth-field">
            <label htmlFor="dispatcher-password">Password</label>
            <div className="auth-field__control">
              <LockKeyhole className="auth-field__lock" aria-hidden="true" />
              <input
                id="dispatcher-password"
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="current-password"
                required
                maxLength={1024}
                autoFocus
                disabled={busy}
                aria-invalid={passwordError}
                aria-describedby={error ? 'dispatcher-password-error' : undefined}
                value={password}
                onChange={event => {
                  setPassword(event.target.value)
                  if (error) setError('')
                  if (passwordError) setPasswordError(false)
                }}
              />
              <button
                className="auth-field__visibility"
                type="button"
                onClick={() => setPasswordVisible(visible => !visible)}
                aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                disabled={busy}
              >
                {passwordVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>
            <div className="auth-form__message" aria-live="polite">
              {error && <span id="dispatcher-password-error" role="alert">{error}</span>}
            </div>
          </div>

          <button className="auth-submit" type="submit" disabled={busy || !password}>
            <span className="auth-submit__label">{phase === 'success' ? 'ACCESS GRANTED' : 'SIGN IN'}</span>
            {phase === 'submitting' ? <span className="auth-spinner auth-spinner--button" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
          </button>

          <div className="auth-secure">
            <span /><LockKeyhole aria-hidden="true" /><small>Secure fleet access</small><span />
          </div>
        </form>}
      </div>
    </section>

    <div className="auth-transition-light" aria-hidden="true" />
  </main>
}
