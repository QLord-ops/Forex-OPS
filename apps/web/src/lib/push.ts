import { authHeaders } from './auth'
import { readWorkHours } from './work-hours'

/** Push to this device: on (subscribed here), off, blocked by the browser, not set up on the server, or not possible here. */
export type PushState = 'on' | 'off' | 'denied' | 'not-configured' | 'unsupported'

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...authHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) {
    let message = 'Push не настроен.'
    try { message = ((await response.json()) as { error?: string }).error ?? message } catch { /* keep the default */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

/** The VAPID public key arrives base64url-encoded; the browser wants the raw bytes. */
export function keyBytes(base64url: string): Uint8Array {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

/** iPhone: push only in the app added to the Home Screen (iOS 16.4+); Android and desktop Chrome: in the browser too. */
export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function subscription() {
  if (!pushSupported() || !navigator.serviceWorker.controller) return null
  return (await navigator.serviceWorker.ready).pushManager.getSubscription()
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const config = await call<{ enabled: boolean }>('/push/config').catch(() => ({ enabled: false }))
  if (!config.enabled) return 'not-configured'
  return (await subscription()) ? 'on' : 'off'
}

function payload(current: PushSubscription) {
  const json = current.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  return { endpoint: json.endpoint ?? current.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, workHours: readWorkHours() }
}

/** Asks the browser for permission, subscribes this device and tells the server, with this device's working hours. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported() || !navigator.serviceWorker.controller) return 'unsupported'
  const config = await call<{ enabled: boolean; publicKey: string | null }>('/push/config')
  if (!config.enabled || !config.publicKey) return 'not-configured'
  if (await Notification.requestPermission() !== 'granted') return 'denied'
  const registration = await navigator.serviceWorker.ready
  const current = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) as BufferSource })
  await call('/push/subscribe', 'POST', payload(current))
  return 'on'
}

/** Off on this device: the browser forgets the subscription and the server deletes it (also on logout). */
export async function disablePush(): Promise<PushState> {
  const current = await subscription()
  if (!current) return 'off'
  const endpoint = current.endpoint
  await current.unsubscribe().catch(() => false)
  await call('/push/unsubscribe', 'POST', { endpoint }).catch(() => undefined)
  return 'off'
}

/** New working hours in the settings: the server learns them, so a closed phone rings only when it should. */
export async function syncPushWorkHours() {
  const current = await subscription().catch(() => null)
  if (current) await call('/push/subscribe', 'POST', payload(current)).catch(() => undefined)
}
