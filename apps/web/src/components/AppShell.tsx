import {
  AlertTriangle,
  ClipboardList,
  History,
  LayoutDashboard,
  MapPinned,
  PlusCircle,
  Truck
} from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
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
  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-800 bg-slate-950 text-white lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-slate-800 px-5">
          <MapPinned className="h-6 w-6 text-sky-300" aria-hidden="true" />
          <div>
            <div className="text-sm font-semibold tracking-wide">OPS Disponent</div>
            <div className="text-xs text-slate-400">Диспетчерская грузовиков</div>
          </div>
        </div>
        <nav className="space-y-1 px-3 py-4" aria-label="Основная навигация">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                [
                  'flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium outline-none transition',
                  isActive
                    ? 'bg-sky-500 text-white'
                    : 'text-slate-300 hover:bg-slate-900 hover:text-white focus:bg-slate-900'
                ].join(' ')
              }
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex min-h-16 items-center justify-between gap-4 px-4 lg:px-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Расчётная диспетчеризация
              </p>
              <h1 className="text-lg font-semibold text-slate-950">Грузовики, маршруты и сроки</h1>
            </div>
            <div className="hidden rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 md:block">
              Расчётная позиция — без данных GPS
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto border-t border-slate-200 px-3 py-2 lg:hidden">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  [
                    'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
                    isActive ? 'bg-slate-950 text-white' : 'text-slate-700'
                  ].join(' ')
                }
              >
                <item.icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="px-4 py-5 lg:px-6">
          <Outlet />
          <OperationsNotifications />
        </main>
      </div>
    </div>
  )
}
