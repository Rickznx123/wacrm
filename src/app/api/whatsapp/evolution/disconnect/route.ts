import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { resolveEvolutionProvider } from '@/integrations/registry'
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
  distributedRateLimitResponse,
} from '@/lib/distributed-rate-limit'

export async function POST() {
  try {
    const ctx = await requireRole('admin')

    const limit = await checkDistributedRateLimit(
      `account:${ctx.accountId}`,
      DISTRIBUTED_RATE_LIMITS.evolutionDisconnect,
    )
    if (!limit.success) {
      return distributedRateLimitResponse(limit)
    }

    const { data: channel, error } = await ctx.supabase
      .from('whatsapp_channels')
      .select('instance_id')
      .eq('account_id', ctx.accountId)
      .eq('provider', 'evolution')
      .maybeSingle()

    if (error) {
      console.error('[evolution/disconnect] channel lookup error:', error)
      return NextResponse.json({ error: 'Failed to load channel' }, { status: 500 })
    }

    if (!channel?.instance_id) {
      return NextResponse.json({ ok: true, disconnected: true })
    }

    const provider = resolveEvolutionProvider()

    await provider.disconnect(channel.instance_id)

    const now = new Date().toISOString()
    const { error: updateError } = await ctx.supabase
      .from('whatsapp_channels')
      .update({
        status: 'disconnected',
        qr_code: null,
        disconnected_at: now,
      })
      .eq('account_id', ctx.accountId)
      .eq('provider', 'evolution')

    if (updateError) {
      console.error('[evolution/disconnect] channel update error:', updateError)
      return NextResponse.json({ error: 'Failed to persist channel status' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, disconnected: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
