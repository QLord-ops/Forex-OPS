/**
 * Auftrag times are German wall-clock times. They are converted as Europe/Berlin, whatever the
 * timezone of the phone or computer the dispatcher is using.
 */
const ZONE = 'Europe/Berlin'

function berlinOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs))
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const wall = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))
  return wall - Math.floor(utcMs / 1000) * 1000
}

/** "2026-11-05T08:00" (Berlin) -> "2026-11-05T07:00:00.000Z". */
export function berlinLocalToIso(local: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local)
  if (!match) return new Date(local).toISOString()
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
  // Two passes settle the offset on daylight-saving change days.
  let utc = wall - berlinOffsetMs(wall)
  utc = wall - berlinOffsetMs(utc)
  return new Date(utc).toISOString()
}

/** ISO instant -> "YYYY-MM-DDTHH:mm" in Berlin, for datetime-local inputs. */
export function isoToBerlinLocal(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(date.getTime() + berlinOffsetMs(date.getTime())).toISOString().slice(0, 16)
}
