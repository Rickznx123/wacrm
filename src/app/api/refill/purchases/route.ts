import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { normalizeBrMobile } from '@/lib/refill/core'
import { recordPurchase } from '@/lib/refill/service'
import { createSupabaseRefillRepo, loadRefillProducts, loadRefillSettings } from '@/lib/refill/supabase-repo'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/** Manual purchase registration (balcão / testes antes da PONTE). */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return bad('Corpo inválido')

    const phone = normalizeBrMobile(body.phone)
    if (!phone) return bad('Telefone inválido: informe um celular com DDD')

    const quantity = Number(body.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000) return bad('Quantidade inválida')

    const purchasedAt = typeof body.purchased_at === 'string' ? new Date(body.purchased_at) : new Date()
    if (Number.isNaN(purchasedAt.getTime()) || purchasedAt.getTime() > Date.now() + 60_000) {
      return bad('Data da compra inválida')
    }

    const products = await loadRefillProducts(supabase, accountId)
    const product = products.find((p) => p.id === body.product_id)
    if (!product) return bad('Produto não encontrado')

    const settings = await loadRefillSettings(supabase, accountId)
    const repo = createSupabaseRefillRepo(supabase, { accountId, auditUserId: userId, settings })
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : null
    const contact = await repo.findOrCreateContact(phone, name)
    if (!contact) return NextResponse.json({ error: 'Falha ao localizar o contato' }, { status: 500 })

    const result = await recordPurchase(repo, settings, {
      contactId: contact.id,
      product,
      source: 'manual',
      externalSaleId: `manual:${crypto.randomUUID()}`,
      externalItemKey: product.external_product_id,
      quantity,
      purchasedAt,
    })
    return NextResponse.json({ result, contact_id: contact.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
