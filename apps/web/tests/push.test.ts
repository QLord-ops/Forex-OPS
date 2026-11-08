import { describe, expect, it } from 'vitest'
import { keyBytes } from '../src/lib/push'

describe('push key', () => {
  it('turns the base64url VAPID key into the bytes the browser wants', () => {
    expect([...keyBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239])
    expect(keyBytes('BPublicKeyForTests').length).toBe(13)
  })
})
