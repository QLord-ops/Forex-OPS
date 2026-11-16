import { describe, expect, it, vi } from 'vitest'

import { ApiError, NETWORK_ERROR_TEXT, withNetworkRetry } from '../src/lib/api'

describe('a dropped connection while an Auftrag is read (owner, 16.11: «Failed to fetch»)', () => {
  it('is tried again and succeeds once the server answers', async () => {
    const answer = new Response('{}', { status: 200 })
    const send = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(answer)
    await expect(withNetworkRetry(send, 2, 0)).resolves.toBe(answer)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('gives up with a Russian message, never the browser\'s English one', async () => {
    const send = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const error = await withNetworkRetry(send, 1, 0).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe(NETWORK_ERROR_TEXT)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('an answer, even an error, is not repeated; other failures pass through', async () => {
    const refused = new Response('{"error":"x"}', { status: 429 })
    const send = vi.fn().mockResolvedValue(refused)
    await expect(withNetworkRetry(send, 3, 0)).resolves.toBe(refused)
    expect(send).toHaveBeenCalledTimes(1)
    await expect(withNetworkRetry(vi.fn().mockRejectedValue(new Error('aborted')), 3, 0)).rejects.toThrow('aborted')
  })
})
