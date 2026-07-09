import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { resolveEvolutionProvider } from '@/integrations/registry'
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
  distributedRateLimitResponse,
} from '@/lib/distributed-rate-limit'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')

    const limit = await checkDistributedRateLimit(
      `account:${ctx.accountId}`,
      DISTRIBUTED_RATE_LIMITS.evolutionQrcode,
    )
    if (!limit.success) {
      return distributedRateLimitResponse(limit)
    }

    const { data: channel, error } = await ctx.supabase
      .from('whatsapp_channels')
      .select('provider, instance_id, status, qr_code, phone, profile_name, last_error, connected_at')
      .eq('account_id', ctx.accountId)
      .eq('provider', 'evolution')
      .maybeSingle()

    if (error) {
      console.error('[evolution/qrcode] fetch channel error:', error)
      return NextResponse.json({ error: 'Failed to load channel' }, { status: 500 })
    }

    if (!channel) {
      return NextResponse.json({ connected: false, configured: false, channel: null })
    }

    const provider = resolveEvolutionProvider()
    if (channel.instance_id) {
      try {
        const live = await provider.readState(channel.instance_id)
        if (live.status !== channel.status || live.qrCode !== channel.qr_code) {
          await ctx.supabase
            .from('whatsapp_channels')
            .update({
              status: live.status,
              qr_code: live.qrCode ?? null,
              phone: live.phone ?? channel.phone,
              profile_name: live.profileName ?? channel.profile_name,
              last_error: live.lastError ?? null,
              connected_at: live.status === 'connected' ? new Date().toISOString() : channel.connected_at,
            })
            .eq('account_id', ctx.accountId)
            .eq('provider', 'evolution')
        }

        return NextResponse.json({
          configured: true,
          connected: live.status === 'connected',
          channel: {
            ...channel,
            status: live.status,
            qr_code: live.qrCode ?? channel.qr_code,
            phone: live.phone ?? channel.phone,
            profile_name: live.profileName ?? channel.profile_name,
            last_error: live.lastError ?? channel.last_error,
          },
        })
      } catch (liveErr) {
        console.error('[evolution/qrcode] provider readState error:', liveErr)
      }
    }

    return NextResponse.json({
      configured: true,
      connected: channel.status === 'connected',
      channel,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
