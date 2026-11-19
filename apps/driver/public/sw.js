/* global self, caches, fetch, URL */
// OPS Fahrer service worker. The app opens without network: the last page and its built files come from the cache,
// the tour the phone saw last comes from the app's own storage, and marks wait there until the network is back.
// Live data (/api) is never cached here.
const CACHE = 'ops-fahrer-v1'
const PAGE = '/'
const OFFLINE = '/offline.html'
const SHELL = [PAGE, OFFLINE, '/manifest.webmanifest', '/icons/icon-192.png', '/media/hero-driver.jpg']
const MAX_ASSETS = 60

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

// The page: always the current one from the network, remembered for the next start without network.
async function page(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(PAGE, response.clone())
    return response
  } catch {
    return (await cache.match(PAGE)) || (await cache.match(OFFLINE))
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (request.mode === 'navigate') {
    event.respondWith(page(request))
    return
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/icons/')) event.respondWith(cachedAsset(request))
})
