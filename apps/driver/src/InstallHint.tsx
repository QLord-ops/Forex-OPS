import { Download } from 'lucide-react'
import { useEffect, useState } from 'react'

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
const DISMISSED = 'ops-driver-install-dismissed'

/**
 * Chrome on Android offers to install the app (icon on the home screen, own window). Shown once until the driver
 * installs it or says «Не сейчас»; an installed app never sees the offer.
 */
export function InstallHint() {
  const [offer, setOffer] = useState<InstallPrompt | null>(null)
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(DISMISSED) === '1' } catch { return false } })

  useEffect(() => {
    const onOffer = (event: Event) => { event.preventDefault(); setOffer(event as InstallPrompt) }
    const onInstalled = () => setOffer(null)
    window.addEventListener('beforeinstallprompt', onOffer)
    window.addEventListener('appinstalled', onInstalled)
    return () => { window.removeEventListener('beforeinstallprompt', onOffer); window.removeEventListener('appinstalled', onInstalled) }
  }, [])

  if (!offer || hidden) return null
  const install = async () => {
    await offer.prompt()
    await offer.userChoice.catch(() => null)
    setOffer(null)
  }
  const later = () => {
    try { localStorage.setItem(DISMISSED, '1') } catch { /* Only a convenience. */ }
    setHidden(true)
  }
  return (
    <section className="card install" aria-label="Установить приложение">
      <p><strong>Установить на телефон</strong>Иконка на экране, открывается без браузера и работает без сети.</p>
      <div className="install-actions">
        <button type="button" className="button button-primary" onClick={() => { void install() }}><Download aria-hidden="true" /><span>Установить</span></button>
        <button type="button" className="button button-quiet" onClick={later}>Не сейчас</button>
      </div>
    </section>
  )
}
