import {
  AlertTriangle,
  ClipboardList,
  History,
  LayoutDashboard,
  MapPinned,
  PlusCircle,
  Truck
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { OperationsNotifications } from './OperationsNotifications'

const navItems = [
  { to: '/', label: 'Панель управления', icon: LayoutDashboard },
  { to: '/vehicles', label: 'Грузовики', icon: Truck },
  { to: '/tours', label: 'Маршруты', icon: ClipboardList },
  { to: '/orders/new', label: 'Новый заказ', icon: PlusCircle },
  { to: '/alerts', label: 'Предупреждения', icon: AlertTriangle },
  { to: '/history', label: 'История', icon: History }
]

export function AppShell() {
  const location = useLocation()
  const isDashboard = location.pathname === '/'

  return (
    <div className={isDashboard ? 'h-dvh overflow-hidden text-slate-950' : 'min-h-screen text-slate-950'}>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-20 border-r border-slate-800 bg-slate-950 text-white transition-[width] 2xl:w-64 lg:block">
        <div className="flex h-16 items-center justify-center gap-3 border-b border-slate-800 px-3 2xl:justify-start 2xl:px-5">
          <MapPinned className="h-6 w-6 text-sky-300" aria-hidden="true" />
          <div className="hidden 2xl:block">
            <div className="text-sm font-semibold tracking-wide">OPS Disponent</div>
            <div className="text-xs text-slate-400">Диспетчерская грузовиков</div>
          </div>
        </div>
        <nav className="space-y-1 px-2 py-4 2xl:px-3" aria-label="Основная навигация">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              title={item.label}
              className={({ isActive }) =>
                [
                  'flex min-h-12 items-center justify-center gap-3 rounded-md px-2 py-2 text-sm font-medium outline-none transition 2xl:justify-start 2xl:px-3',
                  isActive
                    ? 'bg-sky-500 text-white'
                    : 'text-slate-300 hover:bg-slate-900 hover:text-white focus:bg-slate-900'
                ].join(' ')
              }
            >
              <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="hidden min-w-0 text-balance-safe 2xl:block">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className={isDashboard ? 'h-dvh lg:pl-20 2xl:pl-64' : 'lg:pl-20 2xl:pl-64'}>
        <header className="border-b border-slate-200 bg-white lg:hidden">
          <nav className="flex gap-1 overflow-x-auto px-3 py-2" aria-label="Мобильная навигация">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  [
                    'inline-flex min-h-10 shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
                    isActive ? 'bg-slate-950 text-white' : 'text-slate-700'
                  ].join(' ')
                }
              >
                <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className={isDashboard ? 'dashboard-main' : 'px-4 py-5 lg:px-6'}>
          <Outlet />
          <OperationsNotifications />
        </main>
      </div>
    </div>
  )
}
