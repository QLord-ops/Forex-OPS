import { useState } from 'react'
import { HelpCircle } from 'lucide-react'

/**
 * A city code of the Tourbemerkung nobody could explain. The dispatcher names the town once; it is remembered for
 * every later Auftrag and this one is worked out again.
 */
export function AbbreviationQuestion({ code, options, busy, onAnswer }: { code: string; options: string[]; busy: boolean; onAnswer: (city: string) => void }) {
  const [city, setCity] = useState('')
  const typed = city.trim()
  return <form className="abbreviation-question" aria-label={`Расшифровка ${code}`} onSubmit={(event) => { event.preventDefault(); if (typed.length >= 2 && !busy) onAnswer(typed) }}>
    <p className="abbreviation-title"><HelpCircle className="h-4 w-4" />Что значит «{code}»?</p>
    <p className="abbreviation-hint">Назовите город — он запомнится для следующих Auftrag, а этот будет пересчитан.</p>
    {options.length ? <div className="abbreviation-options" role="group" aria-label="Города из этого Auftrag">{options.map((option) =>
      <button key={option} type="button" className="secondary-button" disabled={busy} onClick={() => onAnswer(option)}>{option}</button>)}</div> : null}
    <div className="abbreviation-input">
      <label className="min-w-0 flex-1"><span className="field-label">Город для «{code}»</span>
        <input className="field-input" value={city} maxLength={100} placeholder="например, Salzgitter" onChange={(event) => setCity(event.target.value)} /></label>
      <button type="submit" className="primary-button" disabled={busy || typed.length < 2}>Запомнить</button>
    </div>
  </form>
}
