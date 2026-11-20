import type { AlertPermission } from './alerts'
import type { PushState } from './push'
import type { WorkHours } from './work-hours'

/** Where a setting lives: in this browser only, shared by the whole team, or seen by the admin alone. */
export type SettingsScope = 'local' | 'shared' | 'admin'

export const SCOPE_BADGE: Record<SettingsScope, { label: string; title: string }> = {
  local: { label: 'Этот браузер', title: 'Хранится только в этом браузере: на другом компьютере или телефоне своя настройка' },
  shared: { label: 'Общее для всех', title: 'Одно для всей команды: правку видят все диспетчеры' },
  admin: { label: 'Только админ', title: 'Этот блок видит только администратор' }
}

export type SummaryTone = 'ok' | 'warn' | 'off'
export interface SummaryValue { value: string; tone: SummaryTone }

const WEEK = [1, 2, 3, 4, 5, 6, 0]
const DAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

/** «Пн–Пт», «Пн–Сб», «Пн, Ср, Пт»: three or more days in a row become a range, the week runs Monday to Sunday. */
export function workDaysShort(days: number[]): string {
  const ordered = WEEK.filter((day) => days.includes(day))
  if (!ordered.length) return 'нет дней'
  const runs: number[][] = []
  for (const day of ordered) {
    const last = runs[runs.length - 1]
    if (last && WEEK.indexOf(day) === WEEK.indexOf(last[last.length - 1]!) + 1) last.push(day)
    else runs.push([day])
  }
  return runs.map((run) => run.length >= 3 ? `${DAY_NAMES[run[0]!]}–${DAY_NAMES[run[run.length - 1]!]}` : run.map((day) => DAY_NAMES[day]).join(', ')).join(', ')
}

export function workDayShort(hours: WorkHours): string {
  return `${workDaysShort(hours.days)} · ${hours.start}–${hours.end}`
}

export function soundSummary(permission: AlertPermission, sound: boolean): SummaryValue {
  if (permission === 'denied') return { value: 'Запрещены в браузере', tone: 'warn' }
  if (permission === 'default') return { value: 'Не включены', tone: 'warn' }
  if (permission === 'unsupported') return sound ? { value: 'Только звук', tone: 'ok' } : { value: 'Звук выключен', tone: 'warn' }
  return sound ? { value: 'Включены', tone: 'ok' } : { value: 'Без звука', tone: 'warn' }
}

export function pushSummary(state: PushState | null): SummaryValue {
  if (state === null) return { value: 'Проверяем…', tone: 'off' }
  if (state === 'on') return { value: 'Включён здесь', tone: 'ok' }
  if (state === 'off') return { value: 'Выключен здесь', tone: 'warn' }
  if (state === 'denied') return { value: 'Запрещён в браузере', tone: 'warn' }
  if (state === 'not-configured') return { value: 'Не настроен на сервере', tone: 'off' }
  return { value: 'Недоступен здесь', tone: 'off' }
}

export function rulesSummary(rules: { total: number; fresh: number } | null): SummaryValue {
  if (!rules) return { value: '…', tone: 'off' }
  if (!rules.total) return { value: 'Пока нет', tone: 'off' }
  return { value: rules.fresh ? `${rules.total} · ${rules.fresh} новых` : String(rules.total), tone: rules.fresh ? 'warn' : 'ok' }
}

export interface SettingsNavGroup { name: string; items: Array<{ id: string; label: string }> }

/** The groups of the settings page, in page order. Admin blocks are left out for a dispatcher. */
export function settingsNav(admin: boolean): SettingsNavGroup[] {
  return [
    { name: 'Личные', items: [{ id: 'theme', label: 'Тема' }, { id: 'notifications', label: 'Уведомления' }, { id: 'workday', label: 'Рабочий день' }] },
    { name: 'Адреса', items: [{ id: 'address-rules', label: 'Правила адресов' }, { id: 'own-addresses', label: 'Адреса из Auftrag' },
      ...(admin ? [{ id: 'stop-coordinates', label: 'Координаты точек' }, { id: 'base', label: 'База и заезды' }] : [])] },
    { name: 'Импорт Auftrag', items: [{ id: 'import-rules', label: 'Правила импорта' }, ...(admin ? [{ id: 'import-speed', label: 'Скорость распознавания' }] : [])] },
    { name: 'Доступ и подключения', items: [{ id: 'access', label: admin ? 'Диспетчеры, команда, Webfleet' : 'Команда, Webfleet' }] }
  ]
}
