import { lazy, Suspense, type ReactElement } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { AuthGate } from './components/AuthGate'
import { DashboardPage } from './pages/DashboardPage'

// The dashboard is the start page; the rest load on first visit and keep the first download small.
const VehiclesPage = lazy(() => import('./pages/VehiclesPage').then((module) => ({ default: module.VehiclesPage })))
const VehicleDetailPage = lazy(() => import('./pages/VehicleDetailPage').then((module) => ({ default: module.VehicleDetailPage })))
const ToursPage = lazy(() => import('./pages/ToursPage').then((module) => ({ default: module.ToursPage })))
const EditTourPage = lazy(() => import('./pages/EditTourPage').then((module) => ({ default: module.EditTourPage })))
const NewOrderPage = lazy(() => import('./pages/NewOrderPage').then((module) => ({ default: module.NewOrderPage })))
const AlertsPage = lazy(() => import('./pages/AlertsPage').then((module) => ({ default: module.AlertsPage })))
const HistoryPage = lazy(() => import('./pages/HistoryPage').then((module) => ({ default: module.HistoryPage })))
const DispatchersPage = lazy(() => import('./pages/DispatchersPage').then((module) => ({ default: module.DispatchersPage })))

function PageLoading() {
  return <div className="page-subtitle p-4" role="status">Загрузка страницы…</div>
}

function page(element: ReactElement) {
  return <Suspense fallback={<PageLoading />}>{element}</Suspense>
}

export function App() {
  return (
    <AuthGate><Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="vehicles" element={page(<VehiclesPage />)} />
        <Route path="vehicles/:id" element={page(<VehicleDetailPage />)} />
        <Route path="tours" element={page(<ToursPage />)} />
        <Route path="tours/:id/edit" element={page(<EditTourPage />)} />
        <Route path="orders/new" element={page(<NewOrderPage />)} />
        <Route path="alerts" element={page(<AlertsPage />)} />
        <Route path="history" element={page(<HistoryPage />)} />
        <Route path="dispatchers" element={page(<DispatchersPage />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes></AuthGate>
  )
}
