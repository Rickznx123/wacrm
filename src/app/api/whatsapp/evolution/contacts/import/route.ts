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
          avatar_url: contact.profilePicUrl ?? undefined,
        })

        if (result.created) imported++
        else skipped++
      } catch (err) {
        console.error('[evolution contacts import] failed to process contact', {
          accountId: ctx.accountId,
          userId: ctx.userId,
          phone: contact.phone,
          name: contact.name ?? null,
          hasProfilePicUrl: Boolean(contact.profilePicUrl),
          error: err instanceof Error ? err.message : String(err),
        })
        skipped++
      }
    }

    return NextResponse.json({ ok: true, total: contacts.length, imported, skipped })
  } catch (err) {
    return toErrorResponse(err)
  }
}
