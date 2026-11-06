import { Play } from 'lucide-react'

import { ONBOARDING_EVENT, ONBOARDING_STEPS } from '../lib/onboarding-steps'

/** The tour as text: every section of the program with what it is for, and a way to see each one in place. */
export function HelpPage() {
  const start = (at: number) => window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT, { detail: { start: at } }))
  return <div className="space-y-5">
    <div className="page-header">
      <div className="min-w-0">
        <h2 className="page-title">Справка</h2>
        <p className="page-subtitle">Где что находится и за что отвечает. Кнопка у шага покажет его прямо в программе.</p>
      </div>
      <button type="button" className="primary-button" onClick={() => start(0)}><Play className="h-4 w-4" aria-hidden="true" />Пройти обучение</button>
    </div>
    <ol className="help-steps">
      {ONBOARDING_STEPS.map((step, index) => <li key={step.id} className="help-step">
        <span className="help-step-number" aria-hidden="true">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <h3 className="help-step-title">{step.title}</h3>
          <p className="help-step-text">{step.text}</p>
        </div>
        {step.selector ? <button type="button" className="secondary-button compact-button" onClick={() => start(index)} aria-label={`Показать в программе: ${step.title}`}>Показать</button> : null}
      </li>)}
    </ol>
  </div>
}
