import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

export interface DistributedRateLimitOptions {
  scope: string
  limit: number
  windowMs: number
}

export interface DistributedRateLimitResult {
  success: boolean
  remaining: number
  reset: number
  limit: number
}

type ConsumeRateLimitRow = {
  allowed: boolean
  remaining: number
  reset_at: string
  current_count: number
}

let _adminClient: ReturnType<typeof createAdminClient> | null = null

function supabaseAdmin() {
  if (_adminClient) return _adminClient
  _adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  return _adminClient
}

export async function checkDistributedRateLimit(
  key: string,
  options: DistributedRateLimitOptions,
): Promise<DistributedRateLimitResult> {
  const windowSeconds = Math.max(1, Math.floor(options.windowMs / 1000))

  const admin = supabaseAdmin() as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: unknown }>
  }

  const { data, error } = await admin.rpc('consume_rate_limit', {
    p_scope: options.scope,
    p_key: key,
    p_limit: options.limit,
    p_window_seconds: windowSeconds,
  })

  if (error) {
    throw error
  }

  const row = Array.isArray(data)
    ? ((data[0] as ConsumeRateLimitRow | undefined) ?? null)
    : ((data as ConsumeRateLimitRow | null) ?? null)

  if (!row || typeof row.allowed !== 'boolean') {
    throw new Error('Invalid consume_rate_limit response')
  }

  return {
    success: row.allowed,
    remaining: Math.max(0, Number(row.remaining ?? 0)),
    reset: new Date(row.reset_at).getTime(),
    limit: options.limit,
  }
}

export function distributedRateLimitResponse(result: DistributedRateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000))
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  )
}

export const DISTRIBUTED_RATE_LIMITS = {
  evolutionConnect: { scope: 'evolution_connect', limit: 20, windowMs: 60_000 },
  evolutionDisconnect: { scope: 'evolution_disconnect', limit: 20, windowMs: 60_000 },
  evolutionQrcode: { scope: 'evolution_qrcode', limit: 120, windowMs: 60_000 },
} as const

export function __resetDistributedRateLimitClientForTests() {
  _adminClient = null
}
