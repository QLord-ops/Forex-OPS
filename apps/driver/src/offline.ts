import type { DriverSession, DriverStop, TourView } from './api'

/** A «Прибыл» or «выполнено» pressed without network: kept on the phone until the server has it. */
export type PendingMark = { id: string; vehicle: string; stopId: string; action: 'arrived' | 'done'; at: string }
type Signed = Extract<DriverSession, { authenticated: true }>
/** What the phone remembers of the session: enough to open the app without network, never the CSRF token. */
export type KeptSession = { vehicle: Signed['vehicle']; expiresAt: string }

const KEYS = { view: 'ops-driver-view', session: 'ops-driver-session', marks: 'ops-driver-marks' }

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch { /* Private mode or a full store: the app still works online. */ }
}

const vehicleKey = (vehicle: Signed['vehicle']) => vehicle.licensePlate ?? vehicle.vehicleNumber

export const kept = {
  session: (now = Date.now()): KeptSession | null => {
    const session = read<KeptSession>(KEYS.session)
    return session && Date.parse(session.expiresAt) > now ? session : null
  },
  saveSession: (session: Signed) => write(KEYS.session, { vehicle: session.vehicle, expiresAt: session.expiresAt } satisfies KeptSession),
  /** The last tour the server sent and how far the phone's clock is off the server's. */
  view: (): { view: TourView; offsetMs: number; savedAt: number } | null => read(KEYS.view),
  saveView: (view: TourView, receivedAt = Date.now()) => write(KEYS.view, { view, offsetMs: Date.parse(view.serverTime) - receivedAt, savedAt: receivedAt }),
  /** Signing out forgets the tour; marks not yet sent stay, the next sign-in of the truck sends them. */
  forget: () => { write(KEYS.session, null); write(KEYS.view, null) },
  marks: (vehicle?: Signed['vehicle']): PendingMark[] => (read<PendingMark[]>(KEYS.marks) ?? []).filter(mark => !vehicle || mark.vehicle === vehicleKey(vehicle)),
  addMark: (vehicle: Signed['vehicle'], stopId: string, action: PendingMark['action'], at: Date): PendingMark => {
    const mark: PendingMark = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, vehicle: vehicleKey(vehicle), stopId, action, at: at.toISOString() }
    write(KEYS.marks, [...(read<PendingMark[]>(KEYS.marks) ?? []), mark])
    return mark
  },
  dropMark: (id: string) => write(KEYS.marks, (read<PendingMark[]>(KEYS.marks) ?? []).filter(mark => mark.id !== id)),
  /** Taking back «выполнено» before it was sent also takes back the arrival kept with it, if that was not sent either. */
  dropMarksOf: (stopId: string, action?: PendingMark['action']) =>
    write(KEYS.marks, (read<PendingMark[]>(KEYS.marks) ?? []).filter(mark => mark.stopId !== stopId || (action !== undefined && mark.action !== action)))
}

/** The server's time on the phone: the phone's clock may be off, a kept mark must carry the moment it really was. */
export function serverNow(offsetMs: number, now = Date.now()) {
  return new Date(now + offsetMs)
}

/** The tour as the driver sees it: what the server knows, plus the marks still waiting on the phone. */
export function withPending(view: TourView, marks: PendingMark[]): TourView {
  if (!view.tour || !marks.length) return view
  const stops: DriverStop[] = view.tour.stops.map(stop => {
    const own = marks.filter(mark => mark.stopId === stop.id)
    if (!own.length) return stop
    const arrived = own.find(mark => mark.action === 'arrived')
    const done = own.find(mark => mark.action === 'done')
    return {
      ...stop,
      arrivedAt: stop.arrivedAt ?? arrived?.at ?? done?.at ?? null,
      completedAt: stop.completedAt ?? done?.at ?? null,
      pending: true
    }
  })
  return { ...view, tour: { ...view.tour, stops, currentStopId: stops.find(stop => !stop.completedAt)?.id ?? null } }
}
