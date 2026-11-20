import { useEffect, useState } from 'react'
import { driverApi, offlineError, type DriverSession } from './api'
import { kept } from './offline'
import { LoginScreen } from './LoginScreen'
import { Shift } from './Shift'

type Signed = Extract<DriverSession, { authenticated: true }>

export function App() {
  const [session, setSession] = useState<Signed | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    driverApi.session()
      .then(found => {
        if (found.authenticated) kept.saveSession(found)
        else kept.forget()
        setSession(found.authenticated ? found : null)
      })
      .catch(cause => {
        // No network: the truck's shift is still on the phone, the driver keeps working with the kept tour.
        const offline = offlineError(cause) ? kept.session() : null
        setSession(offline ? { authenticated: true, csrfToken: '', ...offline } : null)
      })
      .finally(() => setChecking(false))
  }, [])

  if (checking) return <div className="boot" role="status"><span className="spinner" aria-hidden="true" />Проверяем вход…</div>
  if (!session) return <LoginScreen onSignedIn={signed => { kept.saveSession(signed); setSession(signed) }} />
  return <Shift session={session} onSignedOut={() => { kept.forget(); setSession(null) }} />
}
