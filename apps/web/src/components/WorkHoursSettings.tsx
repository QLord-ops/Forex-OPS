import { useState } from 'react'

import { readWorkHours, saveWorkHours, validWorkHours, type WorkHours } from '../lib/work-hours'

const DAYS: Array<{ day: number; label: string; name: string }> = [
  { day: 1, label: 'Пн', name: 'Понедельник' }, { day: 2, label: 'Вт', name: 'Вторник' }, { day: 3, label: 'Ср', name: 'Среда' },
  { day: 4, label: 'Чт', name: 'Четверг' }, { day: 5, label: 'Пт', name: 'Пятница' }, { day: 6, label: 'Сб', name: 'Суббота' }, { day: 0, label: 'Вс', name: 'Воскресенье' }
]

/** The working day of this dispatcher: outside it only urgent notifications ring. Kept in this browser. */
export function WorkHoursSettings() {
  const [hours, setHours] = useState<WorkHours>(readWorkHours)
  const [error, setError] = useState<string | null>(null)
  const change = (next: WorkHours) => {
    setHours(next)
    if (!validWorkHours(next)) { setError('Начало должно быть раньше конца.'); return }
    setError(null)
    saveWorkHours(next)
  }
  const toggle = (day: number) => change({ ...hours, days: hours.days.includes(day) ? hours.days.filter((item) => item !== day) : [...hours.days, day].sort() })
  return <div className="work-hours" role="group" aria-labelledby="work-hours-title">
    <p id="work-hours-title" className="section-title">Рабочий день</p>
    <div className="work-hours-days" role="group" aria-label="Рабочие дни">
      {DAYS.map((item) => <button key={item.day} type="button" className="work-hours-day" aria-pressed={hours.days.includes(item.day)} aria-label={item.name} onClick={() => toggle(item.day)}>{item.label}</button>)}
    </div>
    <div className="work-hours-times">
      <label className="work-hours-time">С<input type="time" value={hours.start} step={900} onChange={(event) => change({ ...hours, start: event.target.value })} /></label>
      <label className="work-hours-time">до<input type="time" value={hours.end} step={900} onChange={(event) => change({ ...hours, end: event.target.value })} /></label>
    </div>
    {error ? <p role="alert" className="work-hours-error">{error}</p> : null}
    <p className="page-subtitle">Вне рабочего дня звучат только срочные: уехала без BELADEN/ENTLADEN и критическая стоянка. Остальное ждёт утра, наверху — то, что требует решения.</p>
  </div>
}
