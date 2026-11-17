import { ChevronLeft, KeyRound, Search, UserPlus } from 'lucide-react'
import { Fragment, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { DispatcherLinesEditor } from '../components/CustomerLineCells'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { accountsApi, customersApi, type DispatcherAccount } from '../lib/api'
import { currentDispatcher, currentDispatcherRole } from '../lib/auth'
import { accountCounts, filterAccounts, initialsOf, lastLoginText, type AccountFilter } from '../lib/dispatcher-list'

const MIN_PASSWORD = 12

/** Admin page: personal dispatcher accounts. Accounts are switched off, never deleted, so history keeps its names. */
export function DispatchersPage() {
  const isAdmin = currentDispatcherRole() === 'admin'
  const { data, error, loading, refetch } = usePolling(accountsApi.list, 0, isAdmin)
  const customers = usePolling(customersApi.list, 0, isAdmin).data ?? []
  const [form, setForm] = useState({ login: '', displayName: '', role: 'dispatcher' as 'admin' | 'dispatcher', password: '' })
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<AccountFilter>('active')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const me = currentDispatcher()
  const lineNames = useMemo(() => new Map(customers.flatMap((customer) => customer.lines.map((line) => [line.id, `${customer.name} · ${line.name}`] as const))), [customers])

  if (!isAdmin) return <EmptyState label="Раздел доступен только администратору." />

  const accounts = data ?? []
  const counts = accountCounts(accounts)
  const shown = filterAccounts(accounts, filter, query, (id) => lineNames.get(id))
  const filters: Array<{ id: AccountFilter; label: string; count: number }> = [
    { id: 'active', label: 'Активные', count: counts.active },
    { id: 'no-lines', label: 'Без линий', count: counts.noLines },
    { id: 'off', label: 'Отключённые', count: counts.off }
  ]

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
      setCreating(false)
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

  function toggleActive(account: DispatcherAccount) {
    if (account.active && !window.confirm(`Отключить ${account.displayName}? Вход перестанет работать в течение минуты, история сохранится.`)) return
    void run(`active-${account.id}`, () => accountsApi.update(account.id, { active: !account.active }), account.active ? 'Аккаунт отключён.' : 'Аккаунт включён.')
  }

  return (
    <div className="accounts-page">
      <Link to="/settings" className="accounts-back"><ChevronLeft className="h-4 w-4" aria-hidden="true" />Настройки</Link>
      <div className="page-header">
        <div className="min-w-0">
          <h1 className="page-title">Диспетчеры</h1>
          <p className="page-subtitle">Личные аккаунты: каждый входит под своим логином, журнал показывает, кто что сделал</p>
        </div>
        <button type="button" className="primary-button" aria-expanded={creating} aria-controls="new-dispatcher" onClick={() => setCreating((value) => !value)}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />Новый диспетчер
        </button>
      </div>

      {creating ? <section id="new-dispatcher" className="work-surface accounts-new" aria-labelledby="new-dispatcher-title">
        <h2 id="new-dispatcher-title" className="section-title">Новый диспетчер</h2>
        <form className="accounts-new-form" onSubmit={create}>
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
          <div className="accounts-new-actions">
            <button type="submit" className="primary-button" disabled={busy !== null || form.password.length < MIN_PASSWORD}>{busy === 'create' ? 'Создаём…' : 'Создать'}</button>
            <button type="button" className="secondary-button" onClick={() => setCreating(false)}>Отмена</button>
            <p className="accounts-hint">Пароль — не меньше {MIN_PASSWORD} символов. Его не видно ни в журнале, ни администратору после сохранения. Сообщите его коллеге лично.</p>
          </div>
        </form>
      </section> : null}

      {message ? <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-sm text-red-700' : 'text-sm text-emerald-800'}>{message.text}</p> : null}

      <div className="accounts-toolbar">
        <label className="accounts-search">
          <Search className="h-4 w-4" aria-hidden="true" />
          <input type="search" aria-label="Найти диспетчера по имени, логину или линии" placeholder="Имя, логин или линия" value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="accounts-filters" role="group" aria-label="Показать">
          {filters.map((item) => <button key={item.id} type="button" className="accounts-filter" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}<span>{item.count}</span>
          </button>)}
        </div>
        <span className="accounts-meta">{counts.active} активных · {counts.admins} {counts.admins === 1 ? 'администратор' : 'администраторов'}</span>
      </div>

      <section className="work-surface accounts-list" aria-label="Аккаунты">
        {loading && !data ? <LoadingState /> : error && !data ? <ErrorState error={error} onRetry={refetch} /> : !accounts.length ? <EmptyState label="Аккаунтов пока нет. Создайте первый — после этого общий пароль диспетчера перестанет работать." />
          : !shown.length ? <EmptyState label={query ? 'Никого не нашли.' : filter === 'no-lines' ? 'У всех активных диспетчеров есть линии.' : 'Отключённых аккаунтов нет.'} /> : (
          <table className="accounts-table">
            <thead>
              <tr><th scope="col">Диспетчер</th><th scope="col">Роль</th><th scope="col">Линии</th><th scope="col">Последний вход</th><th scope="col"><span className="sr-only">Действия</span></th></tr>
            </thead>
            <tbody>
              {shown.map((account) => {
                const self = account.id === me?.id
                const resetting = resetFor === account.id
                return (
                  <Fragment key={account.id}>
                    <tr className={account.active ? undefined : 'accounts-row-off'}>
                      <td>
                        <div className="accounts-person">
                          <span className="accounts-avatar" aria-hidden="true">{initialsOf(account.displayName)}</span>
                          <div className="min-w-0">
                            <p className="accounts-name">{account.displayName}{self ? <span className="accounts-self">это вы</span> : null}</p>
                            <p className="accounts-sub"><span className="font-mono">{account.login}</span> · {account.active
                              ? <span className={account.onboardingCompletedAt ? undefined : 'accounts-warn'}>{account.onboardingCompletedAt ? 'обучение пройдено' : 'обучение не пройдено'}</span>
                              : 'отключён'}</p>
                          </div>
                        </div>
                      </td>
                      <td>
                        <select className="accounts-role" aria-label={`Роль ${account.displayName}`} value={account.role} disabled={self || busy !== null || !account.active}
                          onChange={(event) => void run(`role-${account.id}`, () => accountsApi.update(account.id, { role: event.target.value as 'admin' | 'dispatcher' }), 'Роль изменена.')}>
                          <option value="dispatcher">Диспетчер</option>
                          <option value="admin">Администратор</option>
                        </select>
                      </td>
                      <td><DispatcherLinesEditor account={account} customers={customers} onSaved={(text) => { setMessage({ tone: 'ok', text }); void refetch() }} /></td>
                      <td><span className="accounts-phone-label">Последний вход: </span><span className={`accounts-last${account.lastLoginAt ? '' : ' accounts-warn'}`}>{lastLoginText(account.lastLoginAt)}</span></td>
                      <td>
                        <div className="accounts-actions">
                          {account.active ? <button type="button" className="secondary-button" aria-expanded={resetting} disabled={busy !== null}
                            onClick={() => { setResetFor(resetting ? null : account.id); setResetPassword('') }}><KeyRound className="h-4 w-4" aria-hidden="true" />Сбросить пароль</button> : null}
                          {!self ? <button type="button" className={account.active ? 'accounts-quiet' : 'secondary-button'} disabled={busy !== null} onClick={() => toggleActive(account)}>{account.active ? 'Отключить' : 'Включить'}</button> : null}
                        </div>
                      </td>
                    </tr>
                    {resetting ? <tr className="accounts-reset-row">
                      <td colSpan={5}>
                        <form className="accounts-reset" onSubmit={(event) => reset(account, event)}>
                          <label className="block text-sm">
                            <span className="metric-label">Новый пароль для {account.displayName}</span>
                            <input className="field-input" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} maxLength={1024} required value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} autoFocus />
                          </label>
                          <button type="submit" className="primary-button" disabled={busy !== null || resetPassword.length < MIN_PASSWORD}>Сохранить</button>
                          <button type="button" className="secondary-button" onClick={() => { setResetFor(null); setResetPassword('') }}>Отмена</button>
                          <p className="accounts-hint">Не меньше {MIN_PASSWORD} символов. Старый пароль перестанет работать сразу.</p>
                        </form>
                      </td>
                    </tr> : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {filter !== 'off' && counts.off ? <button type="button" className="accounts-off-link" onClick={() => setFilter('off')}>
        Отключённые · {counts.off}<span>— вход не работает, история с их именем сохранена</span>
      </button> : null}
    </div>
  )
}
