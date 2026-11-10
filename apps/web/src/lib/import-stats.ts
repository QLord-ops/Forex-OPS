import type { ImportSpeedSummary, ReadStats } from '../types/domain'

const NBSP = '\u00a0'

/** 6 100 → «6,1 с», 12 400 → «12 с»: tenths matter only below ten seconds. */
export function secondsText(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds >= 9.95) return `${Math.round(seconds)}${NBSP}с`
  return `${seconds.toFixed(1).replace('.', ',')}${NBSP}с`
}

export const tokensText = (count: number) => String(Math.round(count)).replace(/\B(?=(\d{3})+$)/g, NBSP)

/** What the dispatcher waited for the answer, by the clock of their own browser. */
export const waitedMs = (startedAt: number, now: number = Date.now()) => Math.max(0, now - startedAt)

export function tierLabel(tier: string | null): string {
  if (tier === 'priority') return 'быстрый режим'
  if (tier === 'flex') return 'экономный режим'
  return 'обычный режим'
}

/** Where the time of one reading went, for the admin: «ИИ 6,1 с · текст 0,2 с · проверка 0,4 с · токены: … · быстрый режим». */
export function readStatsLine(stats: ReadStats): string {
  const total = stats.totalMs ?? (stats.contextMs ?? 0) + stats.extractMs + stats.modelMs + stats.postMs
  const checks = Math.max(0, total - stats.modelMs - stats.extractMs)
  const tokens = stats.inputTokens === null && stats.outputTokens === null ? null : [
    stats.inputTokens === null ? null : `вход ${tokensText(stats.inputTokens)}${stats.cachedTokens ? ` (кэш ${tokensText(stats.cachedTokens)})` : ''}`,
    stats.outputTokens === null ? null : `выход ${tokensText(stats.outputTokens)}`
  ].filter(Boolean).join(', ')
  return [
    `ИИ ${secondsText(stats.modelMs)}`,
    stats.readMode === 'text' ? `текст ${secondsText(stats.extractMs)}` : stats.readMode === 'image' ? 'фото' : 'PDF как файл',
    `проверка ${secondsText(checks)}`,
    tokens ? `токены: ${tokens}` : null,
    `рассуждение ${stats.effort}`,
    tierLabel(stats.serviceTier),
    stats.settingsRejected ? 'настройки скорости отклонены OpenAI' : null
  ].filter(Boolean).join(' · ')
}

export type SpeedRow = { label: string; value: string }

/** The speed card as plain rows; the verdict says in words whether the 10 s promise holds. */
export function speedCard(summary: ImportSpeedSummary): { verdict: string; onTarget: boolean; rows: SpeedRow[]; warning: string | null } | null {
  if (!summary.count || summary.medianMs === null || summary.p90Ms === null) return null
  const target = secondsText(summary.targetMs)
  const onTarget = summary.p90Ms <= summary.targetMs
  const share = Math.round((summary.withinTarget / summary.count) * 100)
  const rows: SpeedRow[] = [
    { label: `Уложились в ${target}`, value: `${summary.withinTarget} из ${summary.count} (${share}${NBSP}%)` }
  ]
  if (summary.modelMedianMs !== null) rows.push({ label: 'Ответ ИИ (медиана)', value: secondsText(summary.modelMedianMs) })
  if (summary.inputTokensMedian !== null && summary.outputTokensMedian !== null) {
    rows.push({ label: 'Токены на Auftrag (медиана)', value: `вход ${tokensText(summary.inputTokensMedian)}, выход ${tokensText(summary.outputTokensMedian)}` })
  }
  if (summary.cachedShare !== null) rows.push({ label: 'Входные токены из кэша', value: `${Math.round(summary.cachedShare * 100)}${NBSP}%` })
  rows.push({ label: 'Как читались', value: [
    summary.modes.text ? `текст PDF — ${summary.modes.text}` : null,
    summary.modes.file ? `PDF как файл — ${summary.modes.file}` : null,
    summary.modes.image ? `фото — ${summary.modes.image}` : null
  ].filter(Boolean).join(', ') })
  rows.push({ label: 'Настройка сервера', value: `рассуждение ${summary.configured.effort}, ${tierLabel(summary.configured.serviceTier)}` })
  return {
    verdict: `Медиана ${secondsText(summary.medianMs)}, 90${NBSP}% — до ${secondsText(summary.p90Ms)}. ${onTarget ? `Цель ${target} выдержана.` : summary.medianMs <= summary.targetMs ? `Обычно быстрее ${target}, но каждый десятый Auftrag дольше.` : `Медленнее цели ${target}.`}`,
    onTarget,
    rows,
    warning: summary.settingsRejected ? `OpenAI отклонил настройки скорости в ${summary.settingsRejected} из ${summary.count} разборов — они прошли с обычными настройками.` : null
  }
}
