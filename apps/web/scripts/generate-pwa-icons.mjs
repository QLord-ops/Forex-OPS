/* global Buffer, console, URL */
// Renders the app icons of the PWA from the «Сеть» mark (public/favicon.svg). Run once after a logo change:
//   node apps/web/scripts/generate-pwa-icons.mjs
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const NAVY = '#13295b'
const MARK = '<g stroke="#f3ead8" stroke-width="4.5" stroke-linecap="round"><path d="M32 32 14 15M32 32l19-7M32 32 20 50M32 32l17 18"/></g>'
  + '<g fill="#f3ead8"><circle cx="14" cy="15" r="5.5"/><circle cx="51" cy="25" r="5.5"/><circle cx="20" cy="50" r="5.5"/><circle cx="49" cy="50" r="5.5"/></g>'
  + `<circle cx="32" cy="32" r="10" fill="#c8a96a"/><circle cx="32" cy="32" r="3.6" fill="${NAVY}"/>`

// «any»: the rounded tile of the favicon. Maskable and Apple: a full square (the system cuts the shape), the mark inside the safe zone.
const svg = ({ rounded, scale }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64"${rounded ? ' rx="14"' : ''} fill="${NAVY}"/>`
  + `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${MARK}</g></svg>`

const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, scale: 1 },
  { file: 'icon-512.png', size: 512, rounded: true, scale: 1 },
  { file: 'maskable-512.png', size: 512, rounded: false, scale: 0.7 },
  { file: 'apple-touch-icon.png', size: 180, rounded: false, scale: 0.82 }
]

const out = new URL('../public/icons/', import.meta.url)
await mkdir(out, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage()
for (const icon of ICONS) {
  const data = `data:image/svg+xml;base64,${Buffer.from(svg(icon)).toString('base64')}`
  await page.setViewportSize({ width: icon.size, height: icon.size })
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${data}" width="${icon.size}" height="${icon.size}" style="display:block"></body></html>`)
  await page.locator('img').evaluate((image) => image.decode())
  await writeFile(new URL(icon.file, out), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: icon.size, height: icon.size } }))
  console.log('icon', icon.file)
}
await browser.close()
