import { Navigate, Route, Routes } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { AlertsPage } from './pages/AlertsPage'
import { DashboardPage } from './pages/DashboardPage'
import { EditTourPage } from './pages/EditTourPage'
import { HistoryPage } from './pages/HistoryPage'
import { NewOrderPage } from './pages/NewOrderPage'
import { ToursPage } from './pages/ToursPage'
import { VehicleDetailPage } from './pages/VehicleDetailPage'
import { VehiclesPage } from './pages/VehiclesPage'

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="vehicles" element={<VehiclesPage />} />
        <Route path="vehicles/:id" element={<VehicleDetailPage />} />
        <Route path="tours" element={<ToursPage />} />
        <Route path="tours/:id/edit" element={<EditTourPage />} />
        <Route path="orders/new" element={<NewOrderPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
