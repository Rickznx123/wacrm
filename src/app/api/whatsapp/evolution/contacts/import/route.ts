import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { resolveEvolutionProvider } from '@/integrations/registry'
import { findOrCreateContact } from '@/lib/api/v1/contacts'

export async function POST() {
  try {
    const ctx = await requireRole('admin')

    const { data: channel } = await ctx.supabase
      .from('whatsapp_channels')
      .select('instance_id, status')
      .eq('account_id', ctx.accountId)
      .eq('provider', 'evolution')
      .maybeSingle()

    if (!channel?.instance_id || channel.status !== 'connected') {
      return NextResponse.json(
        { error: 'Evolution channel is not connected' },
        { status: 400 },
      )
    }

    const provider = resolveEvolutionProvider()
    const contacts = await provider.listContacts(channel.instance_id)

    let imported = 0
    let skipped = 0

    for (const contact of contacts) {
      try {
        const result = await findOrCreateContact(ctx.supabase, ctx.accountId, ctx.userId, {
          phone: contact.phone,
          name: contact.name ?? undefined,
        })

        if (result.created) imported++
        else skipped++
      } catch {
        skipped++
      }
    }

    return NextResponse.json({ ok: true, total: contacts.length, imported, skipped })
  } catch (err) {
    return toErrorResponse(err)
  }
}
