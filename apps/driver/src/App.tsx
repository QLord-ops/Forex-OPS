import { useEffect, useState } from 'react'
import { driverApi, type DriverSession } from './api'
import { LoginScreen } from './LoginScreen'
import { ShiftScreen } from './ShiftScreen'

type Signed = Extract<DriverSession, { authenticated: true }>

export function App() {
  const [session, setSession] = useState<Signed | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    driverApi.session()
      .then(found => setSession(found.authenticated ? found : null))
      .catch(() => setSession(null))
      .finally(() => setChecking(false))
  }, [])

  if (checking) return <div className="boot" role="status"><span className="spinner" aria-hidden="true" />Проверяем вход…</div>
  if (!session) return <LoginScreen onSignedIn={setSession} />
  return <ShiftScreen session={session} onSignedOut={() => setSession(null)} />
}
