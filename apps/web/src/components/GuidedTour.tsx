import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { accountsApi } from '../lib/api'
import { currentDispatcher, currentOnboardingCompletedAt, setOnboardingCompletedAt } from '../lib/auth'
import { ONBOARDING_EVENT, ONBOARDING_LOCAL_KEY, ONBOARDING_STEPS, type OnboardingStep } from '../lib/onboarding-steps'

type Box = { top: number; left: number; width: number; height: number }
const PAD = 6
const CARD_WIDTH = 360

function rememberLocal() {
  try { window.localStorage.setItem(ONBOARDING_LOCAL_KEY, '1') } catch { /* convenience only */ }
}

/** The tour opens by itself only for a personal account that never finished it; a shared login starts it from the menu. */
function shouldStartOnboarding(): boolean {
  return currentDispatcher() !== null && currentOnboardingCompletedAt() === null
}

function prepare(step: OnboardingStep) {
  if (step.prepare === 'open-card' && !document.querySelector('.truck-card')) document.querySelector<HTMLElement>('.vehicle-row-main')?.click()
  if (step.prepare === 'open-assistant') window.dispatchEvent(new CustomEvent('ops:assistant-context', { detail: { open: true } }))
}

/**
 * Step-by-step tour of the program for a new dispatcher: dims the screen, frames one element, explains it.
 * Starts by itself on the first sign-in and again from «Обучение» in the menu or «Справка».
 */
export function GuidedTour() {
  const navigate = useNavigate()
  const location = useLocation()
  const [index, setIndex] = useState<number | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  const step = index === null ? null : ONBOARDING_STEPS[index]

  useEffect(() => {
    const onStart = (event: Event) => { const at = (event as CustomEvent<{ start?: number }>).detail?.start ?? 0; setIndex(Math.min(Math.max(at, 0), ONBOARDING_STEPS.length - 1)) }
    window.addEventListener(ONBOARDING_EVENT, onStart)
    const timer = window.setTimeout(() => { if (shouldStartOnboarding()) setIndex(0) }, 1200)
    return () => { window.removeEventListener(ONBOARDING_EVENT, onStart); window.clearTimeout(timer) }
  }, [])

  // Each step lives on a page; moving there first, then looking for the element once the page has rendered.
  useEffect(() => {
    if (!step) return
    if (location.pathname !== step.route) { navigate(step.route); return }
    prepare(step)
    let cancelled = false
    let tries = 0
    const find = () => {
      if (cancelled) return
      const element = step.selector ? document.querySelector<HTMLElement>(step.selector) : null
      if (element) {
        element.scrollIntoView({ block: 'center', inline: 'nearest' })
        const rect = element.getBoundingClientRect()
        setBox({ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 })
        return
      }
      if (tries++ < 20) window.setTimeout(find, 100)
      else setBox(null)
    }
    setBox(null)
    find()
    const onChange = () => { tries = 0; find() }
    window.addEventListener('resize', onChange)
    return () => { cancelled = true; window.removeEventListener('resize', onChange) }
  }, [step, location.pathname, navigate])

  useLayoutEffect(() => { card.current?.focus() }, [index])

  const finish = useCallback(async (completed: boolean) => {
    setIndex(null)
    rememberLocal()
    if (!currentDispatcher()) return
    try {
      const result = await accountsApi.onboarding(completed)
      setOnboardingCompletedAt(result.onboardingCompletedAt ?? new Date().toISOString())
    } catch { setOnboardingCompletedAt(new Date().toISOString()) }
  }, [])

  if (!step || index === null) return null
  const last = index === ONBOARDING_STEPS.length - 1
  const next = () => (last ? void finish(true) : setIndex(index + 1))
  const back = () => setIndex(Math.max(0, index - 1))
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); void finish(true); return }
    if (event.key === 'ArrowRight') { event.preventDefault(); next(); return }
    if (event.key === 'ArrowLeft') { event.preventDefault(); back(); return }
    if (event.key === 'Tab' && card.current) {
      const focusable = card.current.querySelectorAll<HTMLElement>('button')
      const first = focusable[0], end = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); end?.focus() }
      else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); first?.focus() }
    }
  }
  const style = cardPosition(box)
  return <div className="guided-tour" onKeyDown={onKey}>
    <div className="guided-tour-backdrop" aria-hidden="true" />
    {box ? <div className="guided-tour-frame" aria-hidden="true" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} /> : null}
    <div ref={card} className="guided-tour-card" role="dialog" aria-modal="true" aria-labelledby="guided-tour-title" aria-describedby="guided-tour-text" tabIndex={-1} style={style}>
      <p className="guided-tour-count">Обучение · шаг {index + 1} из {ONBOARDING_STEPS.length}</p>
      <h2 id="guided-tour-title" className="guided-tour-title">{step.title}</h2>
      <p id="guided-tour-text" className="guided-tour-text">{step.text}</p>
      {step.selector && !box ? <p className="guided-tour-note">Сейчас этого элемента на экране нет — он появится, когда будут данные.</p> : null}
      <div className="guided-tour-actions">
        <button type="button" className="secondary-button compact-button" onClick={() => void finish(true)}>{last ? 'Закрыть' : 'Пропустить'}</button>
        <span className="guided-tour-spacer" />
        {index > 0 ? <button type="button" className="secondary-button compact-button" onClick={back}>Назад</button> : null}
        <button type="button" className="primary-button compact-button" onClick={next}>{last ? 'Готово' : 'Далее'}</button>
      </div>
    </div>
  </div>
}

/** The card sits under the framed element when there is room, above it otherwise, centred when nothing is framed. */
function cardPosition(box: Box | null): React.CSSProperties {
  if (!box) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight
  const width = Math.min(CARD_WIDTH, viewportWidth - 32)
  const left = Math.min(Math.max(16, box.left), viewportWidth - width - 16)
  const below = box.top + box.height + 12
  if (below + 240 < viewportHeight) return { top: below, left, width }
  const above = box.top - 12
  if (above > 240) return { bottom: viewportHeight - above, left, width }
  return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width }
}
