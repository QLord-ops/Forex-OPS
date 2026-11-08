import { useNavigate } from 'react-router-dom'

import { EmptyState } from '../components/States'
import { DecisionGroups } from '../components/OperationsNotifications'
import { useNotifications } from '../context/notifications'
import { needsAttention } from '../lib/alerts'

/** «Решения»: everything that asks for the dispatcher, one card per truck, with the buttons in the card (the phone's bell). */
export function DecisionsPage() {
  const notifications = useNotifications()
  const navigate = useNavigate()
  const open = notifications.open
  const decisions = open.filter(needsAttention).length
  return <div className="space-y-4">
    <div className="page-header">
      <div className="min-w-0">
        <h2 className="page-title">Требует решения</h2>
        <p className="page-subtitle">{decisions ? `Ждут решения: ${decisions}` : 'Срочного нет'}{open.length > decisions ? ` · для сведения: ${open.length - decisions}` : ''}</p>
      </div>
    </div>
    {open.length
      ? <DecisionGroups items={open} onSelect={(vehicleId) => navigate(`/?vehicleId=${encodeURIComponent(vehicleId)}&card=${encodeURIComponent(vehicleId)}`)} />
      : <EmptyState label="Открытых вопросов нет. Новые уведомления появятся здесь и на вкладке «Решения»." />}
  </div>
}
