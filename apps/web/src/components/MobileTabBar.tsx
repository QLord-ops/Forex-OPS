import { Bell, Ellipsis, FileText, Map as MapIcon, Truck } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'

import { useNotifications } from '../context/notifications'
import { needsAttention } from '../lib/alerts'

type TabId = 'list' | 'map' | 'decisions' | 'orders' | 'more'

/** Pages reached through «Ещё» keep that tab lit. */
const MORE_PATHS = ['/more', '/vehicles', '/tours', '/status', '/customers', '/analytics', '/history', '/alerts', '/dispatchers', '/settings', '/help']

function activeTab(pathname: string, search: string): TabId | null {
  if (pathname === '/') return new URLSearchParams(search).get('view') === 'map' ? 'map' : 'list'
  if (pathname.startsWith('/decisions')) return 'decisions'
  if (pathname.startsWith('/orders')) return 'orders'
  return MORE_PATHS.some((path) => pathname.startsWith(path)) ? 'more' : null
}

/** «Машины» and «Карта» keep the selected truck, so switching tabs never loses it. */
function dashboardLink(search: string, view: 'list' | 'map') {
  const params = new URLSearchParams(search)
  const next = new URLSearchParams()
  const vehicleId = params.get('vehicleId')
  if (vehicleId) next.set('vehicleId', vehicleId)
  if (view === 'map') next.set('view', 'map')
  const query = next.toString()
  return query ? `/?${query}` : '/'
}

/** Five tabs at the bottom of the phone instead of the top bar and the bell (phones only, see mobile.css). */
export function MobileTabBar() {
  const location = useLocation()
  const { open, pending } = useNotifications()
  const active = activeTab(location.pathname, location.search)
  const decisions = open.filter(needsAttention).length
  const search = location.pathname === '/' ? location.search : ''
  const tabs: Array<{ id: TabId; to: string; label: string; icon: typeof Truck; badge?: number; badgeLabel?: string }> = [
    { id: 'list', to: dashboardLink(search, 'list'), label: 'Машины', icon: Truck },
    { id: 'map', to: dashboardLink(search, 'map'), label: 'Карта', icon: MapIcon },
    { id: 'decisions', to: '/decisions', label: 'Решения', icon: Bell, badge: decisions, badgeLabel: `требуют решения: ${decisions}` },
    { id: 'orders', to: '/orders/new', label: 'Auftrag', icon: FileText, badge: pending.length, badgeLabel: `Termin ждут проверки: ${pending.length}` },
    { id: 'more', to: '/more', label: 'Ещё', icon: Ellipsis }
  ]
  return <nav className="mobile-tabbar" aria-label="Разделы">
    {tabs.map((tab) => <Link key={tab.id} to={tab.to} data-tab={tab.id} className={tab.id === active ? 'mobile-tab mobile-tab-active' : 'mobile-tab'} aria-current={tab.id === active ? 'page' : undefined}>
      <span className="mobile-tab-icon"><tab.icon className="h-5 w-5" aria-hidden="true" />{tab.badge ? <span className="mobile-tab-badge" aria-label={tab.badgeLabel}>{tab.badge > 99 ? '99+' : tab.badge}</span> : null}</span>
      <span>{tab.label}</span>
    </Link>)}
  </nav>
}
