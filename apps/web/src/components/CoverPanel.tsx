import { CalendarOff, Undo2, UserPlus, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { usePolling } from '../hooks/usePolling'
import { teamApi, type TeamCover, type TeamOverview } from '../lib/api'
import { currentDispatcher } from '../lib/auth'
import { coverScope, coverUntil, notifyCoverChanged, type CoverMode } from '../lib/cover'
import './cover.css'

/** Today 18:00 in the dispatcher's own time; tomorrow once the evening is near. */
function defaultUntil(now = new Date()) {
  const end = new Date(now)
  end.setHours(18, 0, 0, 0)
  if (end.getTime() - now.getTime() < 30 * 60_000) end.setDate(end.getDate() + 1)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`
}

/** «Вернуть»: either side ends the cover and the lines are the owner's again at once. */
export function EndCoverButton({ cover, onDone }: { cover: TeamCover; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function end() {
    setBusy(true); setError('')
    try { await teamApi.endCover(cover.id); notifyCoverChanged(); onDone() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось вернуть.') }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" className="secondary-button compact-button" disabled={busy} aria-label={`Вернуть линии: ${cover.absent.name}`} onClick={() => void end()}>
      <Undo2 className="h-4 w-4" aria-hidden="true" />Вернуть
    </button>
    {error ? <span className="cover-error" role="alert">{error}</span> : null}
  </>
}

/** One form for both ways in: take a colleague's lines, or give my own away. An admin picks both sides. */
export function CoverForm({ team, mode, absentId, onDone, onCancel }: { team: TeamOverview; mode: CoverMode; absentId?: string; onDone: () => void; onCancel: () => void }) {
  const me = currentDispatcher()
  const others = team.dispatchers.filter((person) => person.id !== me?.id)
  const [absent, setAbsent] = useState(mode === 'give' ? me?.id ?? '' : absentId ?? '')
  const [stand, setStand] = useState(mode === 'take' ? me?.id ?? '' : '')
  const [allLines, setAllLines] = useState(true)
  const [picked, setPicked] = useState<string[]>([])
  const [until, setUntil] = useState(defaultUntil)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lines = team.dispatchers.find((person) => person.id === absent)?.lines ?? []
  const ready = Boolean(absent && stand && absent !== stand && until && (allLines || picked.length))

  async function submit(event: FormEvent) {
    event.preventDefault()
    const endsAt = new Date(until)
    if (Number.isNaN(endsAt.getTime())) { setError('Укажите, до какого времени.'); return }
    setBusy(true); setError('')
    try {
      await teamApi.startCover({ absentDispatcherId: absent, coverDispatcherId: stand, lineIds: allLines ? null : picked, endsAt: endsAt.toISOString() })
      notifyCoverChanged(); onDone()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Подмена не оформлена.') } finally { setBusy(false) }
  }

  const title = mode === 'take' ? 'Подменить коллегу' : mode === 'give' ? 'Меня нет: передать линии' : 'Назначить подмену'
  return <form className="cover-form" aria-label={title} onSubmit={(event) => void submit(event)}>
    <h3 className="cover-form-title">{title}</h3>
    {mode !== 'give' ? <label><span className="field-label">Кого подменить</span>
      <select className="field-input" value={absent} required onChange={(event) => { setAbsent(event.target.value); setPicked([]) }}>
        <option value="" disabled>Выберите коллегу…</option>
        {(mode === 'assign' ? team.dispatchers : others).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
    </label> : null}
    {mode !== 'take' ? <label><span className="field-label">{mode === 'give' ? 'Кому передать' : 'Кто подменяет'}</span>
      <select className="field-input" value={stand} required onChange={(event) => setStand(event.target.value)}>
        <option value="" disabled>Выберите коллегу…</option>
        {(mode === 'assign' ? team.dispatchers : others).filter((person) => person.id !== absent).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
    </label> : null}
    <fieldset className="cover-lines">
      <legend className="field-label">Что передаётся</legend>
      <label className="cover-check"><input type="radio" name="cover-scope" checked={allLines} onChange={() => setAllLines(true)} />Все линии и взятые машины</label>
      <label className="cover-check"><input type="radio" name="cover-scope" checked={!allLines} disabled={!lines.length} onChange={() => setAllLines(false)} />Только выбранные линии</label>
      {!allLines ? <div className="cover-line-list">
        {lines.map((line) => <label key={line.id} className="cover-check">
          <input type="checkbox" checked={picked.includes(line.id)} onChange={(event) => setPicked(event.target.checked ? [...picked, line.id] : picked.filter((id) => id !== line.id))} />
          {line.customer} · {line.name}
        </label>)}
      </div> : null}
    </fieldset>
    <label><span className="field-label">До какого времени</span>
      <input className="field-input" type="datetime-local" value={until} required onChange={(event) => setUntil(event.target.value)} />
      <span className="cover-hint">В это время всё вернётся само. Раньше — кнопкой «Вернуть».</span>
    </label>
    {error ? <p className="cover-error" role="alert">{error}</p> : null}
    <div className="cover-form-actions">
      <button type="button" className="secondary-button" onClick={onCancel}>Отмена</button>
      <button type="submit" className="primary-button" disabled={busy || !ready}>{mode === 'take' ? 'Взять на себя' : mode === 'give' ? 'Передать' : 'Назначить'}</button>
    </div>
  </form>
}

/** The covers that concern me, each with «Вернуть». */
export function MyCovers({ team, onChanged }: { team: TeamOverview; onChanged: () => void }) {
  const me = currentDispatcher()
  const mine = team.covers.filter((cover) => cover.cover.id === me?.id || cover.absent.id === me?.id)
  if (!mine.length) return null
  return <ul className="cover-list">
    {mine.map((cover) => <li key={cover.id} className="cover-strip">
      <span className="cover-strip-text">
        <strong>{cover.cover.id === me?.id ? `Веду за ${cover.absent.name}` : `Ваши линии ведёт ${cover.cover.name}`}</strong>
        <span>{coverScope(cover)} · до {coverUntil(cover.endsAt)}</span>
      </span>
      <EndCoverButton cover={cover} onDone={onChanged} />
    </li>)}
  </ul>
}

/** On the dispatch screen: take a colleague's lines or give mine away without leaving the trucks. */
export function CoverPanel() {
  const me = currentDispatcher()
  const personal = Boolean(me)
  const { data: team, refetch } = usePolling(teamApi.overview, 60_000, personal)
  const [mode, setMode] = useState<CoverMode | null>(null)
  // An older server answers without the team: the dispatch screen stays as it was.
  if (!personal || !team?.dispatchers) return null
  const done = () => { setMode(null); void refetch() }
  return <section className="cover-panel" aria-label="Подмена диспетчера">
    <div className="cover-actions">
      <button type="button" className="cover-button" aria-expanded={mode === 'take'} onClick={() => setMode(mode === 'take' ? null : 'take')}><UserPlus className="h-4 w-4" aria-hidden="true" />Подменить коллегу</button>
      <button type="button" className="cover-button" aria-expanded={mode === 'give'} onClick={() => setMode(mode === 'give' ? null : 'give')}><CalendarOff className="h-4 w-4" aria-hidden="true" />Меня нет</button>
      <Link to="/team" className="cover-button"><Users className="h-4 w-4" aria-hidden="true" />Команда</Link>
    </div>
    <MyCovers team={team} onChanged={() => void refetch()} />
    {mode ? <CoverForm key={mode} team={team} mode={mode} onDone={done} onCancel={() => setMode(null)} /> : null}
  </section>
}
