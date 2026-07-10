import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { resolveEvolutionProvider } from '@/integrations/registry'
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
  distributedRateLimitResponse,
} from '@/lib/distributed-rate-limit'

function createInstanceId(accountId: string) {
  return `acct-${accountId.slice(0, 8)}`
}

function resolveWebhookUrl(request: Request) {
  const origin = new URL(request.url).origin
  return `${origin}/api/whatsapp/evolution/webhook`
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const limit = await checkDistributedRateLimit(
      `account:${ctx.accountId}`,
      DISTRIBUTED_RATE_LIMITS.evolutionConnect,
    )

    if (!limit.success) {
      return distributedRateLimitResponse(limit)
    }

    const provider = resolveEvolutionProvider()

    const instanceId = createInstanceId(ctx.accountId)

    const webhookUrl = resolveWebhookUrl(request)

    const state = await provider.createOrConnect(
      instanceId,
      webhookUrl,
    )

    const now = new Date().toISOString()

    const payload = {
      account_id: ctx.accountId,
      provider: 'evolution',
      instance_id: state.instanceId ?? instanceId,
      status: state.status,
      qr_code: state.qrCode ?? null,
      phone: state.phone ?? null,
      profile_name: state.profileName ?? null,
      last_error: state.lastError ?? null,
      connected_at: state.status === 'connected' ? now : null,
      disconnected_at: state.status === 'connected' ? null : now,
    }

    const { data, error } = await ctx.supabase
      .from('whatsapp_channels')
      .upsert(payload, { onConflict: 'account_id,provider' })
      .select(
        'provider, instance_id, status, qr_code, phone, profile_name, connected_at, last_error',
      )
      .single()

    if (error) {
      return NextResponse.json(
        { error: 'Failed to persist channel status' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      ok: true,
      channel: data,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}