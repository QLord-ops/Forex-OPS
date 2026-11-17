import { ChevronRight, Moon, Sun } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'

import { AddressRules } from '../components/AddressRules'
import { AlertToggle } from '../components/AlertToggle'
import { ImportRules } from '../components/ImportRules'
import { ImportSpeed } from '../components/ImportSpeed'
import { OwnAddresses } from '../components/OwnAddresses'
import { PushToggle } from '../components/PushToggle'
import { ScopeBadge, SettingsSection } from '../components/SettingsSection'
import { StopCoordinatesCheck } from '../components/StopCoordinatesCheck'
import { WorkHoursSettings } from '../components/WorkHoursSettings'
import { alertPermission, soundEnabled } from '../lib/alerts'
import { currentDispatcher, currentDispatcherRole } from '../lib/auth'
import { notificationsScope, useFleetScope } from '../lib/fleet-scope'
import type { PushState } from '../lib/push'
import { pushSummary, rulesSummary, settingsNav, soundSummary, workDayShort, type SummaryValue } from '../lib/settings-summary'
import { THEME_EVENT, currentTheme, setTheme, type Theme } from '../lib/theme'
import { WORK_HOURS_EVENT, readWorkHours } from '../lib/work-hours'

/** Personal settings of this browser, the team's shared rules and addresses, and the admin's tools, grouped. */
export function SettingsPage() {
  const [theme, setLocal] = useState<Theme>(() => currentTheme())
  useEffect(() => {
    const onChange = (event: Event) => setLocal((event as CustomEvent<Theme>).detail)
    window.addEventListener(THEME_EVENT, onChange)
    return () => window.removeEventListener(THEME_EVENT, onChange)
  }, [])
  const admin = currentDispatcherRole() === 'admin'
  const person = currentDispatcher()
  const { viewer } = useFleetScope()

  const [sound, setSound] = useState<SummaryValue>(() => soundSummary(alertPermission(), soundEnabled()))
  const refreshSound = useCallback(() => setSound(soundSummary(alertPermission(), soundEnabled())), [])
  const [push, setPush] = useState<PushState | null>(null)
  const [hours, setHours] = useState(readWorkHours)
  useEffect(() => {
    const onChange = () => setHours(readWorkHours())
    window.addEventListener(WORK_HOURS_EVENT, onChange)
    return () => window.removeEventListener(WORK_HOURS_EVENT, onChange)
  }, [])
  const [rules, setRules] = useState<{ total: number; fresh: number } | null>(null)

  const nav = settingsNav(admin)
  const [active, setActive] = useState(nav[0]!.items[0]!.id)
  // A click on the menu wins over the scroll it starts: the last blocks never reach the top of the screen.
  const pickedUntil = useRef(0)
  const sectionIds = nav.flatMap((group) => group.items.map((item) => item.id)).join(',')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const sections = sectionIds.split(',').map((id) => document.getElementById(id)).filter((node): node is HTMLElement => Boolean(node))
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      if (visible && Date.now() > pickedUntil.current) setActive(visible.target.id)
    }, { rootMargin: '-80px 0px -60% 0px' })
    sections.forEach((section) => observer.observe(section))
    return () => observer.disconnect()
  }, [sectionIds])
  const go = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    document.getElementById(id)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    pickedUntil.current = Date.now() + 1500
    setActive(id)
  }

  const summary: Array<{ id: string; label: string } & SummaryValue> = [
    { id: 'notifications', label: 'Звук и окна Windows', ...sound },
    { id: 'notifications', label: 'Push на это устройство', ...pushSummary(push) },
    { id: 'workday', label: 'Рабочий день', value: workDayShort(hours), tone: 'off' },
    { id: 'address-rules', label: 'Правила адресов', ...rulesSummary(rules) }
  ]
  const ownLines = notificationsScope(viewer) === 'mine'

  return (
    <div className="settings-page">
      <div className="page-header">
        <div className="min-w-0">
          <h2 className="page-title">Настройки</h2>
          <p className="page-subtitle">{person ? `${person.name} · ${admin ? 'администратор' : 'диспетчер'} · ` : ''}личное хранится в этом браузере, правила и адреса общие для всей команды</p>
        </div>
      </div>

      <dl className="settings-summary" aria-label="Сводка настроек">
        {summary.map((item) => <div key={item.label} className="settings-summary-item">
          <dt>{item.label}</dt>
          <dd><a href={`#${item.id}`} onClick={go(item.id)}>{item.tone !== 'off' ? <span className={`settings-dot settings-dot-${item.tone}`} aria-hidden="true" /> : null}{item.value}</a></dd>
        </div>)}
      </dl>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Разделы настроек">
          {nav.map((group) => <div key={group.name} className="settings-nav-group">
            <p className="settings-nav-title">{group.name}</p>
            {group.items.map((item) => <a key={item.id} href={`#${item.id}`} onClick={go(item.id)} className="settings-nav-link" aria-current={active === item.id ? 'location' : undefined}>{item.label}</a>)}
          </div>)}
          <div className="settings-legend" aria-label="Где хранится настройка">
            <span><ScopeBadge scope="local" />только у вас</span>
            <span><ScopeBadge scope="shared" />видят все</span>
            {admin ? <span><ScopeBadge scope="admin" />только админ</span> : null}
          </div>
        </nav>

        <div className="settings-content">
          <div className="settings-group" role="group" aria-labelledby="settings-group-personal">
            <p id="settings-group-personal" className="settings-group-title">Личные</p>
            <SettingsSection id="theme" titleId="settings-theme" title="Тема" scope="local" subtitle="«Ночная смена» бережёт глаза в тёмном зале. Тема переключается и в меню профиля.">
              <div className="map-segment settings-segment" role="group" aria-label="Тема интерфейса">
                <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Sun className="h-4 w-4" aria-hidden="true" />Дневная</button>
                <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Moon className="h-4 w-4" aria-hidden="true" />Ночная смена</button>
              </div>
            </SettingsSection>
            <SettingsSection id="notifications" titleId="settings-sound" title="Уведомления" scope="local"
              subtitle="Прибытие, выезд без BELADEN/ENTLADEN, Termin и стоянки. Звук и окно Windows работают, пока вкладка OPS открыта; push приходит и при закрытой.">
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="min-w-0"><p className="settings-row-label">Звук и окна Windows</p><p className="settings-row-hint">Сигнал и окно при новом вопросе. Вне рабочего дня — только срочные.</p></div>
                  <AlertToggle className="settings-toggle" onChange={refreshSound} />
                </div>
                <div className="settings-row">
                  <div className="min-w-0"><p className="settings-row-label">Push на этот телефон или компьютер</p><p className="settings-row-hint">Только «Требует решения». На iPhone — из приложения на экране «Домой».</p></div>
                  <PushToggle className="settings-toggle" onChange={setPush} />
                </div>
                <div className="settings-row">
                  <div className="min-w-0">
                    <p className="settings-row-label">Чьи машины</p>
                    <p className="settings-row-hint">{admin && viewer.id
                      ? 'Колокольчик и push на этом устройстве следуют кнопке «Мои линии» на Диспозиции.'
                      : admin ? 'Общий логин видит весь парк.' : 'Вам приходят только ваши машины: взятые вами и свободные машины ваших линий.'}</p>
                  </div>
                  {admin && viewer.id ? <Link to="/" className="settings-chip">{ownLines ? 'Только мои линии' : 'Весь парк'}</Link> : null}
                </div>
              </div>
            </SettingsSection>
            <WorkHoursSettings />
          </div>

          <div className="settings-group" role="group" aria-labelledby="settings-group-addresses">
            <p id="settings-group-addresses" className="settings-group-title">Адреса</p>
            <AddressRules onLoaded={setRules} />
            <OwnAddresses />
            {admin ? <StopCoordinatesCheck /> : null}
          </div>

          <div className="settings-group" role="group" aria-labelledby="settings-group-import">
            <p id="settings-group-import" className="settings-group-title">Импорт Auftrag</p>
            <ImportRules />
            {admin ? <ImportSpeed /> : null}
          </div>

          <div className="settings-group" role="group" aria-labelledby="settings-group-access">
            <p id="settings-group-access" className="settings-group-title">Доступ и подключения</p>
            <div id="access" className="settings-links">
              {admin ? <Link to="/dispatchers" className="settings-card settings-link">
                <span className="min-w-0 flex-1"><strong>Диспетчеры</strong><span>Личные аккаунты, роли и пароли</span></span>
                <ChevronRight className="h-5 w-5" aria-hidden="true" />
              </Link> : null}
              <Link to="/team" className="settings-card settings-link">
                <span className="min-w-0 flex-1"><strong>Команда и подмена</strong><span>Кто какие линии и машины ведёт, подмена до назначенного времени</span></span>
                <ChevronRight className="h-5 w-5" aria-hidden="true" />
              </Link>
              <Link to="/vehicles" className="settings-card settings-link">
                <span className="min-w-0 flex-1"><strong>Webfleet</strong><span>Подключение и сопоставление машин — на странице «Машины»</span></span>
                <ChevronRight className="h-5 w-5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
