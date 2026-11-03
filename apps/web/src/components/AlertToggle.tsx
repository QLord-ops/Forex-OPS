import { Bell, BellOff } from 'lucide-react'
import { useState } from 'react'

import { alertPermission, requestAlertPermission, setSoundEnabled, soundEnabled, type AlertPermission } from '../lib/alerts'

/** Sound and Windows notifications for this browser. The browser only allows the permission request on a click. */
export function AlertToggle({ className = '' }: { className?: string }) {
  const [permission, setPermission] = useState<AlertPermission>(alertPermission)
  const [sound, setSound] = useState(soundEnabled)
  const label = permission === 'default' ? 'Включить уведомления'
    : permission === 'denied' ? 'Уведомления запрещены в браузере'
      : permission === 'unsupported' ? (sound ? 'Звук включён' : 'Звук выключен')
        : sound ? 'Звук уведомлений включён' : 'Звук уведомлений выключен'
  const title = permission === 'denied' ? 'Разрешите уведомления для этого сайта в настройках браузера (значок замка слева от адреса).' : label

  async function onClick() {
    if (permission === 'default') { setPermission(await requestAlertPermission()); setSoundEnabled(true); setSound(true); return }
    setSoundEnabled(!sound)
    setSound(!sound)
  }

  const muted = permission === 'denied' || !sound
  return (
    <button type="button" className={`alert-toggle ${className}`} onClick={() => void onClick()} title={title} aria-label={label} aria-pressed={permission === 'default' ? undefined : sound}>
      <span className="alert-toggle-icon">{muted ? <BellOff className="h-5 w-5" aria-hidden="true" /> : <Bell className="h-5 w-5" aria-hidden="true" />}{permission === 'default' ? <span className="alert-toggle-dot" aria-hidden="true" /> : null}</span>
      <span className="alert-toggle-label">{label}</span>
    </button>
  )
}
