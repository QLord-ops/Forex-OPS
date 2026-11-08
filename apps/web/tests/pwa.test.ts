import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const file = (path: string) => new URL(`../public/${path}`, import.meta.url)
const pngSize = (path: string) => {
  const png = readFileSync(file(path))
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

describe('installable app', () => {
  const manifest = JSON.parse(readFileSync(file('manifest.webmanifest'), 'utf8')) as {
    name: string; short_name: string; start_url: string; scope: string; display: string; icons: Array<{ src: string; sizes: string; purpose: string }>
  }

  it('has a manifest a phone can install from', () => {
    expect(manifest).toMatchObject({ short_name: 'OPS FOREX', start_url: '/', scope: '/', display: 'standalone' })
    expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable'])
  })

  it('ships every icon in its declared size, and the Apple icon', () => {
    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split('x').map(Number)
      expect(pngSize(icon.src.replace(/^\//, ''))).toEqual({ width, height })
    }
    expect(pngSize('icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
  })

  it('never answers live data from its cache', () => {
    const worker = readFileSync(file('sw.js'), 'utf8')
    expect(worker).toMatch(/url\.pathname\.startsWith\('\/api\/'\)\) return/)
    expect(readFileSync(file('offline.html'), 'utf8')).toContain('Нет связи')
  })
})
