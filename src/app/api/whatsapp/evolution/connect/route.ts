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
  console.log('=== EVOLUTION CONNECT V2 ===')

  try {
    console.log('1 - Entrou na rota')

    const ctx = await requireRole('admin')
    console.log('2 - Auth OK', {
      accountId: ctx.accountId,
    })

    const limit = await checkDistributedRateLimit(
      `account:${ctx.accountId}`,
      DISTRIBUTED_RATE_LIMITS.evolutionConnect,
    )

    console.log('3 - Rate limit', limit)

    if (!limit.success) {
      return distributedRateLimitResponse(limit)
    }

    const provider = resolveEvolutionProvider()
    console.log('4 - Provider resolvido')

    const instanceId = createInstanceId(ctx.accountId)
    console.log('5 - Instance ID', instanceId)

    const webhookUrl = resolveWebhookUrl(request)
    console.log('6 - Webhook URL', webhookUrl)

    console.log('7 - Chamando Evolution...')

    const state = await provider.createOrConnect(
      instanceId,
      webhookUrl,
    )

    console.log('8 - Evolution respondeu', state)

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

    console.log('9 - Salvando no Supabase')

    const { data, error } = await ctx.supabase
      .from('whatsapp_channels')
      .upsert(payload, { onConflict: 'account_id,provider' })
      .select(
        'provider, instance_id, status, qr_code, phone, profile_name, connected_at, last_error',
      )
      .single()

    if (error) {
      console.error('10 - Erro Supabase', error)

      return NextResponse.json(
        { error: 'Failed to persist channel status' },
        { status: 500 },
      )
    }

    console.log('11 - Finalizado com sucesso')

    return NextResponse.json({
      ok: true,
      channel: data,
    })
  } catch (err) {
    console.error('=== EVOLUTION CONNECT ERROR ===')
    console.error(err)

    if (err instanceof Error) {
      console.error('Message:', err.message)
      console.error('Stack:', err.stack)
    }

    return toErrorResponse(err)
  }
}