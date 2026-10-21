import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rate-limit'
import { sendingAllowedByEnv } from '@/lib/refill/core'
import { loadRefillSettings } from '@/lib/refill/supabase-repo'
import { ponteAccountId, syncAccountFromPonte } from '@/lib/refill/sync'

/** Server-side switches the settings screen can't read by itself. */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    return NextResponse.json({
      sendingAllowedByEnv: sendingAllowedByEnv(),
      ponteConfigured: Boolean(process.env.PONTE_URL && process.env.PONTE_API_KEY),
      ponteBound: ponteAccountId() === accountId,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** "Sincronizar agora": import PONTE sales for this account. Never sends. */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit('refill-sync:' + userId, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const settings = await loadRefillSettings(supabase, accountId)
    const outcome = await syncAccountFromPonte(supabase, { accountId, auditUserId: userId, settings })
    return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
