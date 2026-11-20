import { describe, expect, it } from 'vitest'

import { pushSummary, rulesSummary, settingsNav, soundSummary, workDayShort, workDaysShort } from '../src/lib/settings-summary'

describe('settings summary', () => {
  it('writes the working days as ranges from Monday to Sunday', () => {
    expect(workDaysShort([1, 2, 3, 4, 5])).toBe('Пн–Пт')
    expect(workDaysShort([6, 5, 4, 3, 2, 1])).toBe('Пн–Сб')
    expect(workDaysShort([0, 1, 2, 3, 4, 5, 6])).toBe('Пн–Вс')
    expect(workDaysShort([1, 3, 5])).toBe('Пн, Ср, Пт')
    expect(workDaysShort([1, 2, 4, 5, 6])).toBe('Пн, Вт, Чт–Сб')
    expect(workDaysShort([6, 0])).toBe('Сб, Вс')
    expect(workDaysShort([])).toBe('нет дней')
    expect(workDayShort({ days: [1, 2, 3, 4, 5, 6], start: '06:00', end: '18:00' })).toBe('Пн–Сб · 06:00–18:00')
  })

  it('says plainly when the dispatcher will not hear or see a question', () => {
    expect(soundSummary('granted', true)).toEqual({ value: 'Включены', tone: 'ok' })
    expect(soundSummary('granted', false)).toEqual({ value: 'Без звука', tone: 'warn' })
    expect(soundSummary('denied', true)).toEqual({ value: 'Запрещены в браузере', tone: 'warn' })
    expect(soundSummary('default', true)).toEqual({ value: 'Не включены', tone: 'warn' })
    expect(soundSummary('unsupported', true)).toEqual({ value: 'Только звук', tone: 'ok' })
    expect(pushSummary(null).tone).toBe('off')
    expect(pushSummary('on')).toEqual({ value: 'Включён здесь', tone: 'ok' })
    expect(pushSummary('off')).toEqual({ value: 'Выключен здесь', tone: 'warn' })
    expect(pushSummary('unsupported')).toEqual({ value: 'Недоступен здесь', tone: 'off' })
  })

  it('counts the address rules and the new ones', () => {
    expect(rulesSummary(null).tone).toBe('off')
    expect(rulesSummary({ total: 0, fresh: 0 })).toEqual({ value: 'Пока нет', tone: 'off' })
    expect(rulesSummary({ total: 48, fresh: 3 })).toEqual({ value: '48 · 3 новых', tone: 'warn' })
    expect(rulesSummary({ total: 12, fresh: 0 })).toEqual({ value: '12', tone: 'ok' })
  })

  it('leaves the admin blocks out of the navigation of a dispatcher', () => {
    const ids = (admin: boolean) => settingsNav(admin).flatMap((group) => group.items.map((item) => item.id))
    expect(ids(true)).toEqual(['theme', 'notifications', 'workday', 'address-rules', 'own-addresses', 'stop-coordinates', 'base', 'import-rules', 'import-speed', 'access'])
    expect(ids(false)).toEqual(['theme', 'notifications', 'workday', 'address-rules', 'own-addresses', 'import-rules', 'access'])
  })
})
