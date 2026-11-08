import { Bot, Building2, ChartColumn, ChevronRight, CircleHelp, ClipboardList, GraduationCap, Route, Settings, Truck, Users } from 'lucide-react'
import { Link } from 'react-router-dom'

import { AlertToggle } from '../components/AlertToggle'
import { PushToggle } from '../components/PushToggle'
import { DispatcherLogout } from '../components/AuthGate'
import { ThemeToggle } from '../components/ThemeToggle'
import { currentDispatcher, currentDispatcherRole } from '../lib/auth'
import { ONBOARDING_EVENT } from '../lib/onboarding-steps'
import '../components/mobile.css'

/** «Ещё» on the phone: the sections that have no tab, the AI dispatcher, the theme, sound, the tour and logout. */
export function MorePage() {
  const person = currentDispatcher()
  const role = currentDispatcherRole()
  const name = person?.name ?? (role === 'admin' ? 'Администратор' : 'Диспетчер')
  const initials = person ? person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?' : role === 'admin' ? 'АД' : 'ДС'
  const sections = [
    { to: '/status', label: 'Статус 07:00', icon: ClipboardList },
    { to: '/tours', label: 'Туры', icon: Route },
    { to: '/vehicles', label: 'Машины и Webfleet', note: 'добавить, привязать', icon: Truck },
    { to: '/customers', label: 'Заказчики', icon: Building2 },
    { to: '/analytics', label: 'Аналитика', icon: ChartColumn },
    ...(role === 'admin' ? [{ to: '/dispatchers', label: 'Диспетчеры', icon: Users }] : []),
    { to: '/settings', label: 'Настройки', note: 'рабочие часы, правила', icon: Settings }
  ]
  return <div className="more-page">
    <header className="more-who">
      <span className="account-menu-avatar" aria-hidden="true">{initials}</span>
      <span className="min-w-0"><strong>{name}</strong><span>{role === 'admin' ? 'администратор' : 'диспетчер'}{person ? '' : ' · общий вход'}</span></span>
    </header>
    <button type="button" className="more-assistant" onClick={() => window.dispatchEvent(new CustomEvent('ops:assistant-context', { detail: { open: true } }))}>
      <Bot className="h-6 w-6" aria-hidden="true" />
      <span className="min-w-0"><strong>ИИ-диспетчер</strong><span>Спросить про машину: Termin, часы, маршрут</span></span>
      <ChevronRight className="h-5 w-5" aria-hidden="true" />
    </button>
    <nav className="more-list" aria-label="Остальные разделы">
      {sections.map((item) => <Link key={item.to} to={item.to} className="more-item">
        <item.icon className="h-5 w-5" aria-hidden="true" /><span className="more-item-label">{item.label}</span>{item.note ? <span className="more-item-note">{item.note}</span> : null}<ChevronRight className="h-4 w-4 more-item-chevron" aria-hidden="true" />
      </Link>)}
    </nav>
    <div className="more-list" role="group" aria-label="Этот телефон">
      <ThemeToggle className="more-item" />
      <AlertToggle className="more-item" />
      <PushToggle className="more-item" />
    </div>
    <div className="more-list" role="group" aria-label="Помощь">
      <button type="button" className="more-item" onClick={() => window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT, { detail: { start: 0 } }))}><GraduationCap className="h-5 w-5" aria-hidden="true" /><span className="more-item-label">Обучение</span><span className="more-item-note">пройти снова</span></button>
      <Link to="/help" className="more-item"><CircleHelp className="h-5 w-5" aria-hidden="true" /><span className="more-item-label">Справка</span><ChevronRight className="h-4 w-4 more-item-chevron" aria-hidden="true" /></Link>
    </div>
    <div className="more-list">
      <DispatcherLogout className="more-item more-logout" />
    </div>
  </div>
}
