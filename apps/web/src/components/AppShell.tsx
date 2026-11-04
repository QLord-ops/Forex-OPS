import { Bell, ChartColumn, FileText, Map as MapIcon, Menu, Route, Settings, Truck } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { NotificationsProvider, useNotifications } from '../context/notifications'
import { usePopover } from '../hooks/usePopover'
import { AccountMenu } from './AccountMenu'
import { BrandMark, BrandWordmark } from './Brand'
import { DispatcherAssistant } from './DispatcherAssistant'
import { DecisionCard, OperationsNotifications } from './OperationsNotifications'

/** `also` keeps a section lit on the pages that belong to it. */
const navItems = [
  { to: '/', label: 'Диспозиция', icon: MapIcon, also: [] as string[] },
  { to: '/orders/new', label: 'Auftrag', icon: FileText, also: [] },
  { to: '/vehicles', label: 'Машины', icon: Truck, also: [] },
  { to: '/tours', label: 'Туры', icon: Route, also: [] },
  { to: '/analytics', label: 'Аналитика', icon: ChartColumn, also: ['/history', '/alerts'] },
  { to: '/settings', label: 'Настройки', icon: Settings, also: ['/dispatchers'] }
]

export function AppShell() {
  return <NotificationsProvider><Shell /></NotificationsProvider>
}

function Shell() {
  const location = useLocation()
  const isDashboard = location.pathname === '/'
  return (
    <div className={isDashboard ? 'app-shell app-shell-dashboard' : 'app-shell'}>
      <TopBar />
      <main className={isDashboard ? 'dashboard-main' : 'page-main'}>
        <Outlet />
        <OperationsNotifications />
      </main>
      <DispatcherAssistant />
    </div>
  )
}

function TopBar() {
  const location = useLocation()
  const { pending } = useNotifications()
  const menu = usePopover()
  const termin = pending.length
  const isActive = (item: (typeof navItems)[number]) => item.to === '/'
    ? location.pathname === '/'
    : location.pathname.startsWith(item.to) || item.also.some((path) => location.pathname.startsWith(path))
  const links = (className: string, onClick?: () => void) => navItems.map((item) => (
    <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={onClick} className={isActive(item) ? `${className} ${className}-active` : className} aria-current={isActive(item) ? 'page' : undefined}>
      <item.icon className="topbar-link-icon" aria-hidden="true" />
      <span>{item.label}</span>
      {item.to === '/orders/new' && termin ? <span className="topbar-count" aria-label={`${termin} Termin ждут проверки`}>{termin}</span> : null}
    </NavLink>
  ))
  return (
    <header className="topbar">
      <NavLink to="/" className="topbar-brand" aria-label="OPS FOREX Disponent, Диспозиция">
        <BrandMark size={36} />
        <BrandWordmark />
      </NavLink>
      <nav className="topbar-nav" aria-label="Основная навигация">{links('topbar-link')}</nav>
      <div className="topbar-popover-anchor topbar-menu" ref={menu.ref}>
        <button type="button" className="topbar-icon-button topbar-menu-button" aria-expanded={menu.open} onClick={menu.toggle}><Menu className="h-5 w-5" aria-hidden="true" /><span>Меню</span></button>
        {menu.open ? <nav className="topbar-popover topbar-menu-popover" aria-label="Мобильная навигация">{links('topbar-menu-link', menu.close)}</nav> : null}
      </div>
      <div className="topbar-tools">
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
  const count = open.length
  return <div className="topbar-popover-anchor" ref={popover.ref}>
    <button type="button" className="topbar-icon-button topbar-bell" aria-expanded={popover.open} onClick={popover.toggle} aria-label={count ? `Требует решения: ${count}` : 'Уведомления'} title={count ? `Требует решения: ${count}` : 'Нет открытых вопросов'}>
      <Bell className="h-5 w-5" aria-hidden="true" />
      {count ? <span className="topbar-bell-count" aria-hidden="true">{count}</span> : null}
    </button>
    {popover.open ? <div className="topbar-popover bell-popover" aria-label="Требует решения">
      <p className="bell-popover-title">Требует решения <span>{count}</span></p>
      {count ? <div className="bell-popover-list">{open.map((item) => <DecisionCard key={item.id} item={item} openLink />)}</div> : <p className="bell-popover-empty">Открытых вопросов нет.</p>}
      <NavLink to="/alerts" className="bell-popover-link" onClick={popover.close}>Все предупреждения по срокам</NavLink>
    </div> : null}
  </div>
}
