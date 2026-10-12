import { AlertCircle, Inbox, Loader2, RefreshCw } from 'lucide-react'

export function LoadingState({ label = 'Данные загружаются' }: { label?: string }) {
  return (
    <div className="state-box text-slate-600">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      {label}
    </div>
  )
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="state-box text-slate-600">
      <Inbox className="h-5 w-5" aria-hidden="true" />
      {label}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="state-box border-red-200 bg-red-50 text-red-800">
      <AlertCircle className="h-5 w-5" aria-hidden="true" />
      <span>Ошибка загрузки: {error.message}</span>
      {onRetry ? (
        <button className="inline-flex items-center gap-2 rounded-md border border-red-300 px-3 py-1 text-sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Повторить
        </button>
      ) : null}
    </div>
  )
}
