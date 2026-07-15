import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().eq().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

function fakeDbWithSpies(rows: unknown[]) {
  const gte = vi.fn(() => chain)
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    gte,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return {
    db: chain as unknown as SupabaseClient,
    gte,
  }
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('limits context to the current logical session when provided', async () => {
    const { db, gte } = fakeDbWithSpies([
      { sender_type: 'customer', content_text: 'new-session-msg' },
    ])

    const out = await buildConversationContext(
      db,
      'conv-1',
      '2026-07-15T12:00:00.000Z',
    )

    expect(gte).toHaveBeenCalledWith('created_at', '2026-07-15T12:00:00.000Z')
    expect(out).toEqual([{ role: 'user', content: 'new-session-msg' }])
  })
})
