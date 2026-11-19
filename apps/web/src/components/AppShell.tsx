import { Bell, Building2, ChartColumn, ClipboardList, FileText, Map as MapIcon, Route, Settings, Truck } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { NotificationsProvider, useNotifications } from '../context/notifications'
import { usePopover } from '../hooks/usePopover'
import { AccountMenu } from './AccountMenu'
import { BrandMark } from './Brand'
import { DispatcherAssistant } from './DispatcherAssistant'
import { GuidedTour } from './GuidedTour'
import { MobileTabBar } from './MobileTabBar'
import './mobile.css'
import { DecisionGroups, OperationsNotifications } from './OperationsNotifications'
import { needsAttention } from '../lib/alerts'
import { UpdateNotice } from './UpdateNotice'

/** `also` keeps a section lit on the pages that belong to it; `hint` is the tooltip of a label too short to say it all. */
const navItems: Array<{ to: string; label: string; hint?: string; icon: typeof Truck; also: string[] }> = [
  // «Команда» opens from the dispatch screen, not from the rail.
  { to: '/', label: 'Карта', hint: 'Диспозиция: карта и машины', icon: MapIcon, also: ['/team'] },
  { to: '/orders/new', label: 'Auftrag', icon: FileText, also: [] },
  { to: '/vehicles', label: 'Машины', icon: Truck, also: [] },
  { to: '/customers', label: 'Заказчики', icon: Building2, also: [] },
  { to: '/tours', label: 'Туры', icon: Route, also: [] },
  { to: '/status', label: 'Статус', icon: ClipboardList, also: [] },
  { to: '/analytics', label: 'Аналитика', icon: ChartColumn, also: ['/history', '/alerts'] },
  { to: '/settings', label: 'Настройки', icon: Settings, also: ['/dispatchers', '/help'] }
]

export function AppShell() {
  return <NotificationsProvider><Shell /></NotificationsProvider>
}

function Shell() {
  const location = useLocation()
  const isDashboard = location.pathname === '/'
  return (
    <div className={isDashboard ? 'app-shell app-shell-dashboard' : 'app-shell'}>
      <Rail />
      <main className={isDashboard ? 'dashboard-main' : 'page-main'}>
        <Outlet />
        <OperationsNotifications />
      </main>
      <MobileTabBar />
      <DispatcherAssistant />
      <GuidedTour />
      <UpdateNotice />
    </div>
  )
}

/** The sections down the left edge, the bell and the dispatcher's menu at its foot; on a phone the bottom tabs replace it. */
function Rail() {
  const location = useLocation()
  const { pending } = useNotifications()
  const termin = pending.length
  const isActive = (item: (typeof navItems)[number]) => item.to === '/'
    ? location.pathname === '/' || item.also.some((path) => location.pathname.startsWith(path))
    : location.pathname.startsWith(item.to) || item.also.some((path) => location.pathname.startsWith(path))
  return (
    <header className="app-rail">
      <NavLink to="/" className="rail-brand" aria-label="OPS FOREX Disponent, Диспозиция">
        <BrandMark size={32} />
      </NavLink>
      <nav className="rail-nav" aria-label="Основная навигация">
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} title={item.hint} className={isActive(item) ? 'rail-link rail-link-active' : 'rail-link'} aria-current={isActive(item) ? 'page' : undefined}>
            <item.icon className="rail-link-icon" aria-hidden="true" />
            <span>{item.label}</span>
            {item.to === '/orders/new' && termin ? <span className="rail-count" aria-label={`${termin} Termin ждут проверки`}>{termin > 99 ? '99+' : termin}</span> : null}
          </NavLink>
        ))}
      </nav>
      <div className="rail-tools">
        <BellMenu />
        <AccountMenu />
      </div>
    </header>
  )
}

/** The bell counts the open questions; the list itself sits on the dashboard, the bell shows it on every page. */
function BellMenu() {
  const { open } = useNotifications()
  const popover = usePopover()
  const count = open.filter(needsAttention).length
  return <div className="popover-anchor" ref={popover.ref}>
    <button type="button" className="rail-round rail-bell" aria-expanded={popover.open} onClick={popover.toggle} aria-label={count ? `Требует решения: ${count}` : 'Уведомления'} title={count ? `Требует решения: ${count}` : 'Нет открытых вопросов'}>
      <Bell className="h-5 w-5" aria-hidden="true" />
      {count ? <span className="rail-bell-count" aria-hidden="true">{count > 99 ? '99+' : count}</span> : null}
    </button>
    {popover.open ? <div className="popover-menu popover-menu-side bell-popover" aria-label="Требует решения">
      <p className="bell-popover-title">Требует решения <span>{count}</span></p>
      {open.length ? <div className="bell-popover-list"><DecisionGroups items={open} openLink /></div> : <p className="bell-popover-empty">Открытых вопросов нет.</p>}
      <NavLink to="/alerts" className="bell-popover-link" onClick={popover.close}>Все предупреждения по срокам</NavLink>
    </div> : null}
  </div>
}
