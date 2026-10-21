import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { sendingAllowedByEnv, type RefillSettings } from '@/lib/refill/core'
import { dispatchDueReminders } from '@/lib/refill/service'
import { createReminderSender, createSupabaseRefillRepo } from '@/lib/refill/supabase-repo'
import { ponteAccountId, syncAccountFromPonte } from '@/lib/refill/sync'

/**
 * Recompra automática: sync PONTE sales and dispatch due reminders for
 * every account that turned the module on. Same `x-cron-secret` as the
 * automations cron. Real sends additionally need `sending_enabled` on the
 * account AND `REFILL_SENDING_ENABLED=true` on the server; otherwise due
 * reminders stay pending (dry run).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: accounts, error } = await admin
    .from('refill_settings')
    .select('account_id, enabled, sending_enabled, default_lead_days, message_template, sensitive_message_template')
    .eq('enabled', true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const now = new Date()
  const results: Record<string, unknown> = {}

  for (const row of accounts ?? []) {
    const accountId = row.account_id as string
    const settings = row as unknown as RefillSettings
    try {
      const auditUserId = await resolveAuditUserId(admin, accountId)
      const ctx = { accountId, auditUserId, settings }

      const sync = ponteAccountId() === accountId
        ? await syncAccountFromPonte(admin, { ...ctx, now })
        : null
      const dispatch = await dispatchDueReminders(
        createSupabaseRefillRepo(admin, ctx),
        createReminderSender(admin, ctx),
        { now, sendingAllowedByEnv: sendingAllowedByEnv() },
      )
      results[accountId] = { sync, dispatch }
    } catch (err) {
      console.error('[refill/cron] account failed:', accountId, err)
      results[accountId] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return NextResponse.json({ accounts: results })
}
