import { AlertTriangle, Check } from 'lucide-react'

import { FIELD_LABEL, LEVEL_TEXT, reasonText, type FieldView } from '../lib/field-confidence'

/**
 * One field to check or in doubt, with the reason and the quote the AI read. A doubt needs the dispatcher: change the
 * value or press «Верно».
 */
export function FieldNote({ view, onVerify, withLabel = true }: { view: FieldView | undefined; onVerify: (key: string) => void; withLabel?: boolean }) {
  if (!view || (view.state !== 'CHECK' && view.state !== 'DOUBT')) return null
  const label = FIELD_LABEL[view.field]
  return <span className={`field-note field-note-${view.state === 'DOUBT' ? 'doubt' : 'check'}`}>
    {view.state === 'DOUBT' ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> : null}
    <span>{withLabel ? <strong>{label}</strong> : null}{withLabel ? ' — ' : ''}{LEVEL_TEXT[view.state]}: {reasonText(view.score)}{view.score.evidence ? <span className="field-note-evidence"> · в документе: «{view.score.evidence}»</span> : null}</span>
    {view.state === 'DOUBT' ? <button type="button" className="field-verify" onClick={() => onVerify(view.key)} aria-label={`${label}: значение верно`}>
      <Check className="h-3.5 w-3.5" aria-hidden="true" />Верно
    </button> : null}
  </span>
}

/** Everything of one stop (or of the Auftrag) still to look at, for the read-only view. */
export function FieldNotes({ views, onVerify }: { views: FieldView[]; onVerify: (key: string) => void }) {
  const open = views.filter((view) => view.state === 'CHECK' || view.state === 'DOUBT')
  if (!open.length) return null
  return <ul className="field-notes">{open.map((view) => <li key={view.key}><FieldNote view={view} onVerify={onVerify} /></li>)}</ul>
}

/** The count above the check: doubts block «Подтвердить», fields to check do not. */
export function ConfidenceSummary({ doubt, check }: { doubt: number; check: number }) {
  if (!doubt && !check) return null
  return <p className={`field-summary ${doubt ? 'field-summary-doubt' : ''}`} role="status">
    {doubt ? <><AlertTriangle className="h-4 w-4" aria-hidden="true" /><span><strong>Под сомнением: {doubt}</strong> — исправьте или отметьте «Верно».{check ? ` Проверить: ${check}.` : ''}</span></>
      : <span>Проверьте поля, отмеченные жёлтым: {check}.</span>}
  </p>
}
