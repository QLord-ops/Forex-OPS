import { describe, expect, it } from 'vitest'

import { copyIntoMemory } from '../src/lib/file-copy'

describe('a dropped Auftrag is read at once (owner, 16.11: dragged from Outlook, «Failed to fetch»)', () => {
  it('keeps the bytes, name and type, so the upload no longer needs the temporary file', async () => {
    const original = new File(['%PDF-1.7 tesla'], 'TRP_AUFTR.pdf', { type: 'application/pdf' })
    const { files, unreadable } = await copyIntoMemory([original])
    expect(unreadable).toEqual([])
    expect(files[0]).not.toBe(original)
    expect(files[0]).toMatchObject({ name: 'TRP_AUFTR.pdf', type: 'application/pdf', size: original.size })
    expect(await files[0].text()).toBe('%PDF-1.7 tesla')
  })

  it('names the file that could not be read instead of failing the others', async () => {
    const gone = new File(['x'], 'gone.pdf', { type: 'application/pdf' })
    Object.defineProperty(gone, 'arrayBuffer', { value: () => Promise.reject(new DOMException('NotReadableError')) })
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' })
    const fine = new File(['%PDF'], 'fine.pdf', { type: 'application/pdf' })
    const { files, unreadable } = await copyIntoMemory([gone, empty, fine])
    expect(files.map((file) => file.name)).toEqual(['fine.pdf'])
    expect(unreadable).toEqual(['gone.pdf', 'empty.pdf'])
  })
})
