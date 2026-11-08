/** Registers the service worker of the installed app (production build only: dev and tests run without it). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined) })
}

/** «Открыть» on a system notification: the service worker asks the running app to show the truck. */
export function onServiceWorkerOpen(open: (path: string) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null
    if (data?.type === 'ops:open' && typeof data.url === 'string' && data.url.startsWith('/')) open(data.url)
  }
  navigator.serviceWorker.addEventListener('message', listener)
  return () => navigator.serviceWorker.removeEventListener('message', listener)
}

/**
 * Shows a system notification through the service worker: the only way in an installed app and on Android, where
 * `new Notification()` is not allowed. False when there is no worker yet; the caller then uses the page notification.
 */
export async function showWorkerNotification(title: string, options: NotificationOptions & { data?: { url: string } }): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return false
    const registration = await navigator.serviceWorker.ready
    await registration.showNotification(title, options)
    return true
  } catch {
    return false
  }
}
