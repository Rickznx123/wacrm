import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalFetch = global.fetch

describe('evolutionProvider hardening', () => {
  beforeEach(() => {
    process.env.EVOLUTION_API_BASE_URL = 'https://evolution.example.com'
    process.env.EVOLUTION_API_KEY = 'super-secret-evolution-key'
    process.env.EVOLUTION_API_TIMEOUT_MS = '1000'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    global.fetch = originalFetch
  })

  it('normalizes timeout errors', async () => {
    global.fetch = vi.fn(async () => {
      const err = new Error('timed out') as Error & { name: string }
      err.name = 'AbortError'
      throw err
    }) as unknown as typeof fetch

    const { evolutionProvider } = await import('./client')

    await expect(evolutionProvider.readState('inst-1')).rejects.toThrow(
      'Evolution API request timed out',
    )
  })

  it('sanitizes sensitive tokens from upstream error payloads', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          message:
            'provider failed token=abc123 apikey=my-private-key sb_secret_aaaaaaaaaaaaaaaaaaaa',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    const { evolutionProvider } = await import('./client')

    await expect(evolutionProvider.readState('inst-1')).rejects.toThrow(
      'provider failed token=[redacted] apikey=[redacted] [redacted]',
    )
  })

  it('normalizes non-timeout network failures', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    const { evolutionProvider } = await import('./client')

    await expect(evolutionProvider.disconnect('inst-1')).rejects.toThrow(
      'Evolution API request failed',
    )
  })
})
