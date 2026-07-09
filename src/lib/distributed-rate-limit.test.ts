import { beforeEach, describe, expect, it, vi } from 'vitest'

type CounterRow = {
  count: number
  resetAt: string
}

const counters = new Map<string, CounterRow>()
let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0)

function currentNowIso() {
  return new Date(nowMs).toISOString()
}

function makeWindowStartIso(windowSeconds: number): string {
  const seconds = Math.floor(nowMs / 1000)
  const bucket = Math.floor(seconds / windowSeconds) * windowSeconds
  return new Date(bucket * 1000).toISOString()
}

const createClientMock = vi.fn(() => ({
  rpc: vi.fn(
    async (
      fn: string,
      args: {
        p_scope: string
        p_key: string
        p_limit: number
        p_window_seconds: number
      },
    ) => {
      if (fn !== 'consume_rate_limit') {
        return { data: null, error: { message: 'unknown function' } }
      }

      const windowStart = makeWindowStartIso(args.p_window_seconds)
      const resetAt = new Date(
        Date.parse(windowStart) + args.p_window_seconds * 1000,
      ).toISOString()
      const id = `${args.p_scope}|${args.p_key}|${windowStart}`

      const row = counters.get(id)
      const nextCount = row ? row.count + 1 : 1
      counters.set(id, { count: nextCount, resetAt })

      return {
        data: [
          {
            allowed: nextCount <= args.p_limit,
            remaining: Math.max(args.p_limit - nextCount, 0),
            reset_at: resetAt,
            current_count: nextCount,
          },
        ],
        error: null,
      }
    },
  ),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}))

describe('checkDistributedRateLimit', () => {
  beforeEach(async () => {
    counters.clear()
    nowMs = Date.UTC(2026, 0, 1, 0, 0, 0)

    const mod = await import('./distributed-rate-limit')
    mod.__resetDistributedRateLimitClientForTests()
    vi.clearAllMocks()
  })

  it('allows requests within the limit', async () => {
    const { checkDistributedRateLimit } = await import('./distributed-rate-limit')

    const r1 = await checkDistributedRateLimit('acct-1', {
      scope: 'evolution_connect',
      limit: 2,
      windowMs: 60_000,
    })
    const r2 = await checkDistributedRateLimit('acct-1', {
      scope: 'evolution_connect',
      limit: 2,
      windowMs: 60_000,
    })

    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(r2.remaining).toBe(0)
  })

  it('blocks when limit is exceeded', async () => {
    const { checkDistributedRateLimit } = await import('./distributed-rate-limit')

    await checkDistributedRateLimit('acct-1', {
      scope: 'evolution_connect',
      limit: 1,
      windowMs: 60_000,
    })

    const r2 = await checkDistributedRateLimit('acct-1', {
      scope: 'evolution_connect',
      limit: 1,
      windowMs: 60_000,
    })

    expect(r2.success).toBe(false)
    expect(r2.remaining).toBe(0)
  })

  it('resets after the window changes', async () => {
    const { checkDistributedRateLimit } = await import('./distributed-rate-limit')

    await checkDistributedRateLimit('acct-1', {
      scope: 'evolution_connect',
      limit: 1,
      windowMs: 60_000,
    })

    nowMs += 61_000

    const nextWindow = await checkDistributedRateLimit('acct-1', {
      scope: 'evolution_connect',
      limit: 1,
      windowMs: 60_000,
    })

    expect(nextWindow.success).toBe(true)
    expect(nextWindow.remaining).toBe(0)
  })

  it('behaves correctly under simple concurrency', async () => {
    const { checkDistributedRateLimit } = await import('./distributed-rate-limit')

    const [a, b, c] = await Promise.all([
      checkDistributedRateLimit('acct-1', {
        scope: 'evolution_connect',
        limit: 2,
        windowMs: 60_000,
      }),
      checkDistributedRateLimit('acct-1', {
        scope: 'evolution_connect',
        limit: 2,
        windowMs: 60_000,
      }),
      checkDistributedRateLimit('acct-1', {
        scope: 'evolution_connect',
        limit: 2,
        windowMs: 60_000,
      }),
    ])

    const allowedCount = [a, b, c].filter((r) => r.success).length
    const deniedCount = [a, b, c].filter((r) => !r.success).length

    expect(allowedCount).toBe(2)
    expect(deniedCount).toBe(1)
  })
})
