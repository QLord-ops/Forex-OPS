import { CalendarOff, UserPlus, UsersRound } from 'lucide-react'
import { useState } from 'react'

import { CoverForm, EndCoverButton } from '../components/CoverPanel'
import { ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { teamApi } from '../lib/api'
import { currentDispatcher, currentDispatcherRole } from '../lib/auth'
import { coverScope, coverUntil, trucks, type CoverMode } from '../lib/cover'
import '../components/cover.css'

/** Who works on which lines right now, who is away and who stands in; covers start and end here too. */
export function TeamPage() {
  const me = currentDispatcher()
  const isAdmin = currentDispatcherRole() === 'admin'
  const { data: team, error, loading, refetch } = usePolling(teamApi.overview, 30_000)
  const [form, setForm] = useState<{ mode: CoverMode; absentId?: string } | null>(null)

  if (loading && !team) return <LoadingState />
  if (error && !team) return <ErrorState error={error} onRetry={refetch} />
  if (!team) return null
  const done = () => { setForm(null); void refetch() }
  const mayEnd = (cover: { absent: { id: string }; cover: { id: string } }) => isAdmin || cover.absent.id === me?.id || cover.cover.id === me?.id

  return <div className="space-y-5">
    <div className="page-header">
      <div className="min-w-0">
        <h2 className="page-title">Команда</h2>
        <p className="page-subtitle">Кто какие линии и машины ведёт сейчас. Подмена заканчивается сама в назначенное время, линии хозяина при этом не меняются.</p>
      </div>
      <div className="team-actions">
        {me ? <button type="button" className="secondary-button" onClick={() => setForm({ mode: 'give' })}><CalendarOff className="h-4 w-4" aria-hidden="true" />Меня нет</button> : null}
        {isAdmin ? <button type="button" className="primary-button" onClick={() => setForm({ mode: 'assign' })}><UsersRound className="h-4 w-4" aria-hidden="true" />Назначить подмену</button> : null}
      </div>
    </div>

    {form ? <div className="work-surface"><div className="team-form" style={{ paddingTop: 16 }}>
      <CoverForm key={`${form.mode}:${form.absentId ?? ''}`} team={team} mode={form.mode} absentId={form.absentId} onDone={done} onCancel={() => setForm(null)} />
    </div></div> : null}

    <section className="work-surface" aria-label="Диспетчеры">
      <ul className="team-list">
        {team.dispatchers.map((person) => {
          const away = person.away
          const fullyAway = away.some((cover) => cover.allLines)
          return <li key={person.id} className="team-row">
            <div className="min-w-0">
              <p className="team-name">{person.name}{person.id === me?.id ? ' (вы)' : ''}
                <span className="team-count">{trucks(person.vehicleCount)}</span>
                {away.length ? <span className="cover-tag">нет до {coverUntil(away[0]!.endsAt)}</span> : null}
              </p>
              {person.lines.length ? <div className="team-lines">
                {person.lines.map((line) => <span key={line.id} className="team-line">
                  <span className="team-line-dot" style={line.color ? { background: line.color } : undefined} aria-hidden="true" />{line.customer} · {line.name}{line.isPrimary ? ' (основная)' : ''}
                </span>)}
              </div> : <p className="team-empty">Линий нет</p>}
              {away.map((cover) => <p key={cover.id} className="team-note">Ведёт {cover.cover.name}: {coverScope(cover)} · до {coverUntil(cover.endsAt)}</p>)}
              {person.covering.map((cover) => <p key={cover.id} className="team-note">Подменяет {cover.absent.name}: {coverScope(cover)} · до {coverUntil(cover.endsAt)}</p>)}
            </div>
            <div className="team-actions">
              {away.filter(mayEnd).map((cover) => <EndCoverButton key={cover.id} cover={cover} onDone={() => void refetch()} />)}
              {me && person.id !== me.id && !fullyAway ? <button type="button" className="secondary-button compact-button" aria-label={`Подменить: ${person.name}`} onClick={() => setForm({ mode: 'take', absentId: person.id })}>
                <UserPlus className="h-4 w-4" aria-hidden="true" />Подменить
              </button> : null}
            </div>
          </li>
        })}
      </ul>
    </section>

    {team.unowned.length ? <section className="work-surface" aria-label="Ничьи линии">
      <h3 className="team-section-title">Ничьи линии: диспетчера назначает администратор</h3>
      <ul className="team-list">
        {team.unowned.map((line) => <li key={line.id} className="team-row">
          <p className="team-name">{line.customer} · {line.name}<span className="team-count">{trucks(line.vehicleCount)}</span></p>
        </li>)}
      </ul>
    </section> : null}
  </div>
}
