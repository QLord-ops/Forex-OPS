import type { Customer, CustomerCategory, CustomerProfile } from './api'

export const CATEGORY_LABEL: Record<CustomerCategory, string> = {
  OEM_LOGISTICS: 'OEM-логистика',
  WAREHOUSE: 'Склад',
  SPOT: 'Разовые',
  OTHER: 'Другое'
}

export const ROUTE_SOURCE_LABEL: Record<CustomerProfile['import']['routeSource'], string> = {
  TOUR_REMARKS: 'Строка Tourbemerkung',
  TABLE: 'Таблица точек',
  EMAIL_TEXT: 'Текст письма'
}

/** Field names of import corrections, as the profile shows them. */
export const CORRECTED_FIELD_LABEL: Record<string, string> = {
  company: 'Компания', address: 'Адрес', city: 'Город', type: 'Тип точки',
  STOP_REMOVED: 'Лишняя точка', STOP_ADDED: 'Пропущенная точка'
}

/** Every active line of every active customer, for a select: "Schnellecke · Nord". */
export function lineOptions(customers: Customer[]) {
  return customers.filter((customer) => customer.active).map((customer) => ({
    customer,
    lines: customer.lines.filter((line) => line.active).map((line) => ({ id: line.id, label: `${customer.name} · ${line.name}` }))
  })).filter((group) => group.lines.length)
}

/** "Lager, vorladen" ⇄ ["Lager", "vorladen"]: comma lists in the profile form. */
export const joinWords = (words: string[]) => words.join(', ')
export const splitWords = (text: string) => [...new Set(text.split(/[,;\n]+/).map((word) => word.trim()).filter((word) => word.length >= 2))]

/** A readable fallback colour when a customer has none, stable per customer. */
export function customerColor(customer: { color: string | null; slug: string }) {
  if (customer.color) return customer.color
  const palette = ['#1d4ed8', '#b91c1c', '#047857', '#7c3aed', '#c2410c', '#0369a1']
  let hash = 0
  for (const char of customer.slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}
