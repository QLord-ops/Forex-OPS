/* global self, caches, fetch, URL */
// OPS FOREX service worker. Makes the app installable, keeps the built files for a fast start and shows notifications.
// Live data (/api) is never cached: without a connection the dispatcher sees «Нет связи», not stale positions.
const CACHE = 'ops-shell-v1'
const OFFLINE = '/offline.html'
const SHELL = [OFFLINE, '/favicon.svg', '/icons/icon-192.png']
const MAX_ASSETS = 80

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()))
})

// Built files carry a hash in their name: once fetched they never change. The oldest go when the cache grows.
async function cachedAsset(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
    const keys = await cache.keys()
    const assets = keys.filter((key) => new URL(key.url).pathname.startsWith('/assets/'))
    for (const old of assets.slice(0, Math.max(0, assets.length - MAX_ASSETS))) await cache.delete(old)
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (request.mode === 'navigate') {
    // Always the current app from the network; the offline page only when there is none.
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)))
    return
  }
  if (url.pathname.startsWith('/assets/')) event.respondWith(cachedAsset(request))
})

// A click on a notification opens the truck in the running app, or starts the app there.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && typeof event.notification.data.url === 'string') ? event.notification.data.url : '/'
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (open) {
      open.postMessage({ type: 'ops:open', url })
      return open.focus()
    }
    return self.clients.openWindow(url)
  }))
})
