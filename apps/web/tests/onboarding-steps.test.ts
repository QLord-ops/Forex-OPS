import { describe, expect, it } from 'vitest'
import { ONBOARDING_STEPS } from '../src/lib/onboarding-steps'

describe('guided tour steps', () => {
  it('has unique ids, a route and Russian text for every step, and ends with a plain card', () => {
    const ids = ONBOARDING_STEPS.map((step) => step.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const step of ONBOARDING_STEPS) {
      expect(step.route.startsWith('/')).toBe(true)
      expect(step.title.length).toBeGreaterThan(2)
      expect(step.text.length).toBeGreaterThan(40)
      expect(step.text).toMatch(/[а-яё]/i)
      if (step.selector !== null) expect(step.selector).toMatch(/^[a-z.#[][\w\s.#[\]="А-Яа-яё-]*$/u)
    }
    expect(ONBOARDING_STEPS[0]).toMatchObject({ route: '/', selector: 'nav[aria-label="Основная навигация"]' })
    expect(ONBOARDING_STEPS.at(-1)).toMatchObject({ id: 'done', selector: null })
  })

  it('visits every section of the top bar', () => {
    const routes = new Set(ONBOARDING_STEPS.map((step) => step.route))
    for (const route of ['/', '/orders/new', '/vehicles', '/tours', '/status', '/settings']) expect(routes.has(route)).toBe(true)
  })
})
