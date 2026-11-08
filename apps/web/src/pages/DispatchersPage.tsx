import { KeyRound, UserPlus, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { accountsApi, customersApi, type DispatcherAccount } from '../lib/api'
import { DispatcherLinesEditor } from '../components/CustomerLineCells'
import { currentDispatcher, currentDispatcherRole } from '../lib/auth'
import { formatDateTime } from '../lib/format'

const MIN_PASSWORD = 12

/** Admin page: personal dispatcher accounts. Accounts are switched off, never deleted, so history keeps its names. */
export function DispatchersPage() {
  const isAdmin = currentDispatcherRole() === 'admin'
  const { data, error, loading, refetch } = usePolling(accountsApi.list, 0, isAdmin)
  const customers = usePolling(customersApi.list, 0, isAdmin).data ?? []
  const [form, setForm] = useState({ login: '', displayName: '', role: 'dispatcher' as 'admin' | 'dispatcher', password: '' })
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const me = currentDispatcher()

  if (!isAdmin) return <EmptyState label="Раздел доступен только администратору." />

  async function run(key: string, work: () => Promise<unknown>, done: string) {
    setBusy(key)
    setMessage(null)
    try {
      await work()
      setMessage({ tone: 'ok', text: done })
      await refetch()
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : 'Не удалось сохранить.' })
    } finally {
      setBusy(null)
    }
  }

  function create(event: FormEvent) {
    event.preventDefault()
    void run('create', async () => {
      await accountsApi.create({ ...form, login: form.login.trim().toLowerCase(), displayName: form.displayName.trim() })
      setForm({ login: '', displayName: '', role: 'dispatcher', password: '' })
    }, 'Аккаунт создан. Сообщите пароль коллеге лично и попросите сменить его после входа.')
  }

  function reset(account: DispatcherAccount, event: FormEvent) {
    event.preventDefault()
    void run(`reset-${account.id}`, async () => {
      await accountsApi.resetPassword(account.id, resetPassword)
      setResetFor(null)
      setResetPassword('')
    }, `Пароль для ${account.displayName} изменён.`)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-center gap-3">
        <Users className="h-6 w-6 text-slate-500" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-semibold text-slate-950">Диспетчеры</h1>
          <p className="text-sm text-slate-500">Личные аккаунты: каждый входит под своим логином, журнал показывает, кто что сделал.</p>
        </div>
      </header>

      <section className="work-surface p-4" aria-label="Новый диспетчер">
        <h2 className="mb-3 flex items-center gap-2 font-semibold text-slate-900"><UserPlus className="h-4 w-4" aria-hidden="true" />Новый диспетчер</h2>
        <form className="grid gap-3 md:grid-cols-[1fr_1.4fr_auto_1.2fr_auto] md:items-end" onSubmit={create}>
          <label className="block text-sm">
            <span className="metric-label">Логин</span>
            <input className="field-input" required autoComplete="off" autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9._\-]{3,40}" title="3–40 символов: латиница, цифры, точка, дефис, подчёркивание"
              value={form.login} onChange={(event) => setForm({ ...form, login: event.target.value })} placeholder="anna.b" />
          </label>
          <label className="block text-sm">
            <span className="metric-label">Имя и фамилия</span>
            <input className="field-input" required minLength={2} maxLength={80} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="Anna Beispiel" />
          </label>
          <label className="block text-sm">
            <span className="metric-label">Роль</span>
            <select className="field-input" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as 'admin' | 'dispatcher' })}>
              <option value="dispatcher">Диспетчер</option>
              <option value="admin">Администратор</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="metric-label">Временный пароль</span>
            <input className="field-input" type="password" required minLength={MIN_PASSWORD} maxLength={1024} autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </label>
          <button type="submit" className="primary-button" disabled={busy !== null || form.password.length < MIN_PASSWORD}>{busy === 'create' ? 'Создаём…' : 'Создать'}</button>
        </form>
        <p className="mt-2 text-xs text-slate-500">Пароль — не меньше {MIN_PASSWORD} символов. Его не видно ни в журнале, ни администратору после сохранения.</p>
      </section>

      {message ? <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-sm text-red-700' : 'text-sm text-emerald-800'}>{message.text}</p> : null}

      <section className="work-surface overflow-x-auto" aria-label="Аккаунты">
        {loading && !data ? <LoadingState /> : error && !data ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? <EmptyState label="Аккаунтов пока нет. Создайте первый — после этого общий пароль диспетчера перестанет работать." /> : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500">
              <tr><th className="px-4 py-2 font-medium">Имя</th><th className="px-4 py-2 font-medium">Логин</th><th className="px-4 py-2 font-medium">Роль</th><th className="px-4 py-2 font-medium">Линии</th><th className="px-4 py-2 font-medium">Последний вход</th><th className="px-4 py-2 font-medium">Обучение</th><th className="px-4 py-2 font-medium">Статус</th><th className="px-4 py-2" /></tr>
            </thead>
            <tbody>
              {data.map((account) => {
                const self = account.id === me?.id
                return (
                  <tr key={account.id} className={account.active ? 'border-b border-slate-100' : 'border-b border-slate-100 text-slate-400'}>
                    <td className="px-4 py-3 font-medium">{account.displayName}{self ? <span className="ml-2 text-xs text-slate-500">это вы</span> : null}</td>
                    <td className="px-4 py-3 font-mono text-xs">{account.login}</td>
                    <td className="px-4 py-3">
                      <select className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm" aria-label={`Роль ${account.displayName}`} value={account.role} disabled={self || busy !== null || !account.active}
                        onChange={(event) => void run(`role-${account.id}`, () => accountsApi.update(account.id, { role: event.target.value as 'admin' | 'dispatcher' }), 'Роль изменена.')}>
                        <option value="dispatcher">Диспетчер</option>
                        <option value="admin">Администратор</option>
                      </select>
                    </td>
                    <td className="px-4 py-3"><DispatcherLinesEditor account={account} customers={customers} onSaved={(text) => { setMessage({ tone: 'ok', text }); void refetch() }} /></td>
                    <td className="px-4 py-3 tabular-nums">{account.lastLoginAt ? formatDateTime(account.lastLoginAt) : 'ещё не входил'}</td>
                    <td className="px-4 py-3">{account.onboardingCompletedAt ? 'пройдено' : 'нет'}</td>
                    <td className="px-4 py-3">{account.active ? 'Активен' : 'Отключён'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        {resetFor === account.id ? (
                          <form className="flex gap-2" onSubmit={(event) => reset(account, event)}>
                            <input className="rounded-md border border-slate-300 px-2 py-1 text-sm" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required aria-label={`Новый пароль для ${account.displayName}`} value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
                            <button type="submit" className="secondary-button" disabled={busy !== null || resetPassword.length < MIN_PASSWORD}>Сохранить</button>
                            <button type="button" className="secondary-button" onClick={() => { setResetFor(null); setResetPassword('') }}>Отмена</button>
                          </form>
                        ) : (
                          <button type="button" className="secondary-button" disabled={busy !== null || !account.active} onClick={() => setResetFor(account.id)}><KeyRound className="h-4 w-4" aria-hidden="true" />Сбросить пароль</button>
                        )}
                        {!self ? (
                          <button type="button" className="secondary-button" disabled={busy !== null}
                            onClick={() => {
                              if (account.active && !window.confirm(`Отключить ${account.displayName}? Вход перестанет работать в течение минуты, история сохранится.`)) return
                              void run(`active-${account.id}`, () => accountsApi.update(account.id, { active: !account.active }), account.active ? 'Аккаунт отключён.' : 'Аккаунт включён.')
                            }}>
                            {account.active ? 'Отключить' : 'Включить'}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
