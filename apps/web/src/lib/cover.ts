import type { TeamCover } from './api'

export type CoverMode = 'take' | 'give' | 'assign'

const UNTIL = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
export const coverUntil = (iso: string) => UNTIL.format(new Date(iso)).replace(',', '')
export function trucks(count: number) {
  const tail = count % 100 >= 11 && count % 100 <= 14 ? 'машин' : count % 10 === 1 ? 'машина' : count % 10 >= 2 && count % 10 <= 4 ? 'машины' : 'машин'
  return `${count} ${tail}`
}
export const coverScope = (cover: TeamCover) => `${cover.allLines ? 'все линии' : cover.lines.map((line) => line.name).join(', ')}, ${trucks(cover.vehicleCount)}`

export function notifyCoverChanged() {
  window.dispatchEvent(new CustomEvent('ops:data-changed'))
}
