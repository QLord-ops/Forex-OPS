import { describe, expect, it } from 'vitest'

import { entryOf, newerBuild } from '../src/lib/app-version'

const page = (entry: string) => `<!doctype html><html><head><script src="/theme-init.js"></script><link rel="stylesheet" crossorigin href="/assets/index-aaa.css"></head>
<body><div id="root"></div><script type="module" crossorigin src="${entry}"></script></body></html>`

describe('new version of the app', () => {
  it('finds the program a page runs by its entry script, not by the theme script or the stylesheet', () => {
    expect(entryOf(page('/assets/index-B1x9.js'))).toBe('/assets/index-B1x9.js')
    expect(entryOf('<html><body>Сервер временно недоступен</body></html>')).toBeNull()
  })

  it('a tab opened before a deploy is told about it; an unreadable answer never is', () => {
    expect(newerBuild('/assets/index-B1x9.js', entryOf(page('/assets/index-C2y0.js')))).toBe(true)
    expect(newerBuild('/assets/index-B1x9.js', entryOf(page('/assets/index-B1x9.js')))).toBe(false)
    expect(newerBuild('/assets/index-B1x9.js', null)).toBe(false)
    expect(newerBuild(null, '/assets/index-C2y0.js')).toBe(false)
  })
})
