import { ChevronRight, Moon, Sun, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { AddressRules } from '../components/AddressRules'
import { ImportRules } from '../components/ImportRules'
import { AlertToggle } from '../components/AlertToggle'
import { WorkHoursSettings } from '../components/WorkHoursSettings'
import { currentDispatcher, currentDispatcherRole } from '../lib/auth'
import { THEME_EVENT, currentTheme, setTheme, type Theme } from '../lib/theme'
import { PushToggle } from '../components/PushToggle'

/** Personal settings of this browser plus the admin entry to accounts. */
export function SettingsPage() {
  const [theme, setLocal] = useState<Theme>(() => currentTheme())
  useEffect(() => {
    const onChange = (event: Event) => setLocal((event as CustomEvent<Theme>).detail)
    window.addEventListener(THEME_EVENT, onChange)
    return () => window.removeEventListener(THEME_EVENT, onChange)
  }, [])
  const admin = currentDispatcherRole() === 'admin'
  const person = currentDispatcher()
  return (
    <div className="space-y-6">
      <div className="page-header">
        <div className="min-w-0">
          <h2 className="page-title">Настройки</h2>
          <p className="page-subtitle">{person ? `${person.name} · ` : ''}тема, звук и рабочий день хранятся в этом браузере</p>
        </div>
      </div>
      <section className="settings-card" aria-labelledby="settings-theme">
        <h3 id="settings-theme" className="section-title">Тема</h3>
        <div className="map-segment settings-segment" role="group" aria-label="Тема интерфейса">
          <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Sun className="h-4 w-4" aria-hidden="true" />Дневная</button>
          <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Moon className="h-4 w-4" aria-hidden="true" />Ночная смена</button>
        </div>
      </section>
      <section className="settings-card" aria-labelledby="settings-sound">
        <h3 id="settings-sound" className="section-title">Уведомления</h3>
        <p className="page-subtitle">Звук и окно Windows о прибытии, выезде без BELADEN/ENTLADEN и Termin, пока вкладка OPS открыта.</p>
        <AlertToggle className="settings-toggle" />
        <PushToggle className="settings-toggle" />
        <WorkHoursSettings />
      </section>
      <AddressRules />
      <ImportRules />
      {admin ? <Link to="/dispatchers" className="settings-card settings-link">
        <Users className="h-5 w-5" aria-hidden="true" />
        <span className="min-w-0 flex-1"><strong>Диспетчеры</strong><span>Личные аккаунты, роли и пароли</span></span>
        <ChevronRight className="h-5 w-5" aria-hidden="true" />
      </Link> : null}
      <Link to="/vehicles" className="settings-card settings-link">
        <span className="min-w-0 flex-1"><strong>Webfleet</strong><span>Подключение и сопоставление машин — на странице «Машины»</span></span>
        <ChevronRight className="h-5 w-5" aria-hidden="true" />
      </Link>
    </div>
  )
}
