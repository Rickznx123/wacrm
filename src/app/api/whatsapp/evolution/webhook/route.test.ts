import { beforeEach, describe, expect, it, vi } from 'vitest'

type ConversationRow = {
  id: string
  account_id: string
  contact_id: string
  status: 'open' | 'pending' | 'closed'
  assigned_agent_id: string | null
  unread_count: number
  last_message_text: string | null
  ai_autoreply_disabled: boolean
  ai_reply_count: number
  ai_handoff_summary: string | null
  session_started_at: string | null
}

type MessageRow = {
  id: string
  conversation_id: string
  message_id: string
  status: string
}

type DbState = {
  channel: { account_id: string; instance_id: string }
  ownerUserId: string
  conversation: ConversationRow
  messages: MessageRow[]
  contactUpdates: Array<{ id: string | null; payload: Record<string, unknown> }>
  conversationUpdates: number
  messageLookupMode: 'normal' | 'miss'
  rpcInsertMode: 'ok' | 'fail_transient' | 'fail_permanent'
  channelUpdateMode: 'ok' | 'transient_error' | 'permanent_error'
}

let dbState: DbState
let infoSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

const createClientMock = vi.fn(() => {
  const api = {
    rpc(fn: string, payload: Record<string, unknown>) {
      if (fn !== 'persist_inbound_message_and_touch_conversation') {
        return Promise.resolve({ data: null, error: null })
      }

      if (dbState.rpcInsertMode === 'fail_transient') {
        return Promise.resolve({
          data: null,
          error: { code: '40001', message: 'simulated transient failure' },
        })
      }

      if (dbState.rpcInsertMode === 'fail_permanent') {
        return Promise.resolve({
          data: null,
          error: { code: '23505', message: 'simulated permanent failure' },
        })
      }

      const conversationId = String(payload.p_conversation_id)
      const messageId = String(payload.p_message_id)

      const duplicate = dbState.messages.find(
        (m) => m.conversation_id === conversationId && m.message_id === messageId,
      )
      if (duplicate) {
        return Promise.resolve({ data: false, error: null })
      }

      dbState.messages.push({
        id: `msg-${dbState.messages.length + 1}`,
        conversation_id: conversationId,
        message_id: messageId,
        status: 'delivered',
      })

      if (conversationId === dbState.conversation.id) {
        const wasClosed = dbState.conversation.status === 'closed'
        dbState.conversation = {
          ...dbState.conversation,
          status: wasClosed ? 'pending' : dbState.conversation.status,
          assigned_agent_id: wasClosed ? null : dbState.conversation.assigned_agent_id,
          unread_count: dbState.conversation.unread_count + 1,
          last_message_text: String(payload.p_last_message_text),
          ai_autoreply_disabled: wasClosed
            ? false
            : dbState.conversation.ai_autoreply_disabled,
          ai_reply_count: wasClosed ? 0 : dbState.conversation.ai_reply_count,
          ai_handoff_summary: wasClosed ? null : dbState.conversation.ai_handoff_summary,
          session_started_at: wasClosed
            ? String(payload.p_created_at)
            : dbState.conversation.session_started_at,
        }
        dbState.conversationUpdates += 1
      }

      return Promise.resolve({ data: true, error: null })
    },

    from(table: string) {
      const ctx: {
        table: string
        selectColumns: string | null
        filters: Record<string, unknown>
        limitValue: number | null
        updatePayload: Record<string, unknown> | null
      } = {
        table,
        selectColumns: null,
        filters: {},
        limitValue: null,
        updatePayload: null,
      }

      const runUpdate = () => {
        if (!ctx.updatePayload) return { error: null }

        if (ctx.table === 'whatsapp_channels') {
          if (dbState.channelUpdateMode === 'transient_error') {
            return { error: { code: '08006', message: 'connection failure' } }
          }
          if (dbState.channelUpdateMode === 'permanent_error') {
            return { error: { code: '23514', message: 'check violation' } }
          }
          return { error: null }
        }

        if (ctx.table === 'conversations') {
          const id = ctx.filters.id
          if (id === dbState.conversation.id) {
            dbState.conversation = {
              ...dbState.conversation,
              status:
                typeof ctx.updatePayload.status === 'string'
                  ? (ctx.updatePayload.status as 'open' | 'pending' | 'closed')
                  : dbState.conversation.status,
              assigned_agent_id:
                'assigned_agent_id' in ctx.updatePayload
                  ? (ctx.updatePayload.assigned_agent_id as string | null)
                  : dbState.conversation.assigned_agent_id,
              unread_count:
                typeof ctx.updatePayload.unread_count === 'number'
                  ? (ctx.updatePayload.unread_count as number)
                  : dbState.conversation.unread_count,
              last_message_text:
                typeof ctx.updatePayload.last_message_text === 'string'
                  ? (ctx.updatePayload.last_message_text as string)
                  : dbState.conversation.last_message_text,
              ai_autoreply_disabled:
                typeof ctx.updatePayload.ai_autoreply_disabled === 'boolean'
                  ? (ctx.updatePayload.ai_autoreply_disabled as boolean)
                  : dbState.conversation.ai_autoreply_disabled,
              ai_reply_count:
                typeof ctx.updatePayload.ai_reply_count === 'number'
                  ? (ctx.updatePayload.ai_reply_count as number)
                  : dbState.conversation.ai_reply_count,
              ai_handoff_summary:
                'ai_handoff_summary' in ctx.updatePayload
                  ? (ctx.updatePayload.ai_handoff_summary as string | null)
                  : dbState.conversation.ai_handoff_summary,
              session_started_at:
                typeof ctx.updatePayload.session_started_at === 'string'
                  ? (ctx.updatePayload.session_started_at as string)
                  : dbState.conversation.session_started_at,
            }
            dbState.conversationUpdates += 1
          }
          return { error: null }
        }

        if (ctx.table === 'messages') {
          const messageId = ctx.filters.message_id
          const row = dbState.messages.find((m) => m.message_id === messageId)
          if (row && typeof ctx.updatePayload.status === 'string') {
            row.status = ctx.updatePayload.status
          }
          return { error: null }
        }

        if (ctx.table === 'contacts') {
          dbState.contactUpdates.push({
            id: typeof ctx.filters.id === 'string' ? ctx.filters.id : null,
            payload: ctx.updatePayload,
          })
          return { error: null }
        }

        return { error: null }
      }

      const builder: {
        select: (columns: string) => typeof builder
        eq: (col: string, val: unknown) => typeof builder
        limit: (value: number) => typeof builder
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>
        update: (payload: Record<string, unknown>) => typeof builder
        insert: (payload: Record<string, unknown>) => Promise<{ error: unknown }> | {
          select: (_columns: string) => {
            single: () => Promise<{ data: unknown; error: unknown }>
          }
        }
        then: <TResult1 = { error: unknown }, TResult2 = never>(
          onfulfilled?: ((value: { error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => Promise<TResult1 | TResult2>
      } = {
        select(columns: string) {
          ctx.selectColumns = columns
          return builder
        },
        eq(col: string, val: unknown) {
          ctx.filters[col] = val
          return builder
        },
        limit(value: number) {
          ctx.limitValue = value
          return builder
        },
        maybeSingle() {
          if (ctx.table === 'whatsapp_channels') {
            const match =
              ctx.filters.provider === 'evolution' &&
              ctx.filters.instance_id === dbState.channel.instance_id
            return Promise.resolve({
              data: match ? dbState.channel : null,
              error: null,
            })
          }

          if (ctx.table === 'accounts') {
            const match = ctx.filters.id === dbState.channel.account_id
            return Promise.resolve({
              data: match ? { owner_user_id: dbState.ownerUserId } : null,
              error: null,
            })
          }

          if (ctx.table === 'conversations') {
            const match =
              ctx.filters.account_id === dbState.conversation.account_id &&
              ctx.filters.contact_id === dbState.conversation.contact_id
            return Promise.resolve({
              data: match
                ? {
                    id: dbState.conversation.id,
                    unread_count: dbState.conversation.unread_count,
                  }
                : null,
              error: null,
            })
          }

          if (ctx.table === 'messages') {
            if (ctx.filters.conversation_id && ctx.filters.message_id) {
              if (dbState.messageLookupMode === 'miss') {
                return Promise.resolve({ data: null, error: null })
              }
              const found = dbState.messages.find(
                (m) =>
                  m.conversation_id === ctx.filters.conversation_id &&
                  m.message_id === ctx.filters.message_id,
              )
              return Promise.resolve({
                data: found ? { id: found.id } : null,
                error: null,
              })
            }

            if (ctx.filters.message_id) {
              const found = dbState.messages.find(
                (m) => m.message_id === ctx.filters.message_id,
              )
              if (!found) return Promise.resolve({ data: null, error: null })
              return Promise.resolve({
                data: {
                  conversation_id: found.conversation_id,
                  conversations: { account_id: dbState.channel.account_id },
                },
                error: null,
              })
            }
          }

          return Promise.resolve({ data: null, error: null })
        },
        update(payload: Record<string, unknown>) {
          ctx.updatePayload = payload
          return builder
        },
        insert() {
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({ data: null, error: null })
                },
              }
            },
          }
        },
        then(onfulfilled, onrejected) {
          return Promise.resolve(runUpdate()).then(onfulfilled, onrejected)
        },
      }

      return builder
    },
  }

  return api
})

const findExistingContactMock = vi.fn(async () => ({
  id: 'contact-1',
  phone: '+5511999999999',
  name: 'Cliente',
  avatar_url: null,
}))

const dispatchWebhookEventMock = vi.fn(async () => undefined)

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: findExistingContactMock,
  isUniqueViolation: (err: unknown) =>
    !!err && typeof err === 'object' && (err as { code?: string }).code === '23505',
}))

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: dispatchWebhookEventMock,
}))

describe('Evolution webhook idempotency', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.resetModules()

    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    process.env.EVOLUTION_WEBHOOK_SECRET = 'evolution-secret'

    dbState = {
      channel: { account_id: 'acct-1', instance_id: 'inst-1' },
      ownerUserId: 'owner-1',
      conversation: {
        id: 'conv-1',
        account_id: 'acct-1',
        contact_id: 'contact-1',
        status: 'open',
        assigned_agent_id: null,
        unread_count: 0,
        last_message_text: null,
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
        ai_handoff_summary: null,
        session_started_at: null,
      },
      messages: [],
      contactUpdates: [],
      conversationUpdates: 0,
      messageLookupMode: 'normal',
      rpcInsertMode: 'ok',
      channelUpdateMode: 'ok',
    }
  })

  function makeInboundPayload(messageId: string) {
    return {
      instance: 'inst-1',
      event: 'messages.upsert',
      data: {
        messages: [
          {
            key: {
              id: messageId,
              remoteJid: '5511999999999@s.whatsapp.net',
              fromMe: false,
            },
            messageTimestamp: 1_700_000_000,
            pushName: 'Cliente',
            message: {
              conversation: 'oi',
            },
          },
        ],
      },
    }
  }

  async function sendEventTwice(payload: unknown) {
    const { POST } = await import('./route')

    const first = await POST(
      new Request('http://localhost/api/whatsapp/evolution/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-evolution-secret': 'evolution-secret',
        },
        body: JSON.stringify(payload),
      }),
    )

    const second = await POST(
      new Request('http://localhost/api/whatsapp/evolution/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-evolution-secret': 'evolution-secret',
        },
        body: JSON.stringify(payload),
      }),
    )

    return { first, second }
  }

  async function sendEventOnce(payload: unknown, headers?: Record<string, string>) {
    const { POST } = await import('./route')
    return POST(
      new Request('http://localhost/api/whatsapp/evolution/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-evolution-secret': 'evolution-secret',
          ...(headers ?? {}),
        },
        body: JSON.stringify(payload),
      }),
    )
  }

  function parseStructuredCalls(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls
      .map((call: unknown[]) => {
        const first = call[0]
        if (typeof first !== 'string') return null
        try {
          return JSON.parse(first) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((entry: Record<string, unknown> | null): entry is Record<string, unknown> => entry != null)
  }

  it('does not create duplicate messages on replay of the same event', async () => {
    const payload = makeInboundPayload('evo-msg-1')
    const { first, second } = await sendEventTwice(payload)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    expect(dbState.messages).toHaveLength(1)
    expect(dbState.messages[0]?.message_id).toBe('evo-msg-1')
    expect(dbState.conversation.unread_count).toBe(1)
    expect(dbState.conversationUpdates).toBe(1)
  })

  it('remains idempotent when lookup misses and insert hits duplicate key', async () => {
    dbState.messageLookupMode = 'miss'

    const payload = makeInboundPayload('evo-msg-race-1')
    const { first, second } = await sendEventTwice(payload)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    expect(dbState.messages).toHaveLength(1)
    expect(dbState.messages[0]?.message_id).toBe('evo-msg-race-1')
    expect(dbState.conversation.unread_count).toBe(1)
    expect(dbState.conversationUpdates).toBe(1)
  })

  it('does not update conversation state when message persistence fails', async () => {
    dbState.rpcInsertMode = 'fail_permanent'
    dbState.conversation.unread_count = 7
    dbState.conversation.last_message_text = 'mensagem-anterior'

    const payload = makeInboundPayload('evo-msg-fail-1')
    const response = await sendEventOnce(payload)

    expect(response.status).toBe(200)
    expect(dbState.messages).toHaveLength(0)
    expect(dbState.conversation.unread_count).toBe(7)
    expect(dbState.conversation.last_message_text).toBe('mensagem-anterior')
    expect(dbState.conversationUpdates).toBe(0)
  })

  it('returns 503 for transient processing error (safe retry)', async () => {
    dbState.rpcInsertMode = 'fail_transient'

    const payload = makeInboundPayload('evo-msg-transient-1')
    const response = await sendEventOnce(payload)

    expect(response.status).toBe(503)
    expect(dbState.messages).toHaveLength(0)
    expect(dbState.conversationUpdates).toBe(0)
  })

  it('returns 200 for permanent processing error (no retry loop)', async () => {
    dbState.rpcInsertMode = 'fail_permanent'

    const payload = makeInboundPayload('evo-msg-permanent-1')
    const response = await sendEventOnce(payload)

    expect(response.status).toBe(200)
    expect(dbState.messages).toHaveLength(0)
    expect(dbState.conversationUpdates).toBe(0)
  })

  it('returns 400 for invalid payload', async () => {
    const { POST } = await import('./route')

    const response = await POST(
      new Request('http://localhost/api/whatsapp/evolution/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-evolution-secret': 'evolution-secret',
        },
        body: '{',
      }),
    )

    expect(response.status).toBe(400)
  })

  it('returns 401 for invalid authentication', async () => {
    const { POST } = await import('./route')

    const response = await POST(
      new Request('http://localhost/api/whatsapp/evolution/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-evolution-secret': 'wrong-secret',
        },
        body: JSON.stringify(makeInboundPayload('evo-msg-auth-1')),
      }),
    )

    expect(response.status).toBe(401)
  })

  it('logs structured start/end with correlation id and no sensitive payload', async () => {
    const correlationId = 'corr-obs-1'
    const payload = makeInboundPayload('evo-msg-obs-1')

    const response = await sendEventOnce(payload, {
      'x-correlation-id': correlationId,
    })

    expect(response.status).toBe(200)

    const infoEntries = parseStructuredCalls(infoSpy)
    const startLog = infoEntries.find((entry: Record<string, unknown>) => entry.event === 'request.start')
    const finishLog = infoEntries.find((entry: Record<string, unknown>) => entry.event === 'request.finish')

    expect(startLog).toBeTruthy()
    expect(finishLog).toBeTruthy()
    expect(startLog?.correlationId).toBe(correlationId)
    expect(finishLog?.correlationId).toBe(correlationId)

    const allLogText = JSON.stringify([
      ...parseStructuredCalls(infoSpy),
      ...parseStructuredCalls(warnSpy),
      ...parseStructuredCalls(errorSpy),
    ])
    expect(allLogText).not.toContain('evolution-secret')
    expect(allLogText).not.toContain('"text":"oi"')
  })

  it('logs transient errors with structured investigation context', async () => {
    dbState.rpcInsertMode = 'fail_transient'

    const response = await sendEventOnce(makeInboundPayload('evo-msg-obs-transient'))

    expect(response.status).toBe(503)

    const errorEntries = parseStructuredCalls(errorSpy)
    const persistError = errorEntries.find((entry: Record<string, unknown>) => entry.event === 'message.persist_failed')

    expect(persistError).toBeTruthy()
    expect(persistError?.transient).toBe(true)
    expect(persistError?.code).toBe('40001')

    const finishEntry = parseStructuredCalls(infoSpy).find(
      (entry: Record<string, unknown>) => entry.event === 'request.finish',
    )
    expect(finishEntry?.outcome).toBe('transient_error')
    expect(finishEntry?.httpStatus).toBe(503)
  })

  it('ignores inbound messages flagged as groups', async () => {
    const payload = {
      instance: 'inst-1',
      event: 'messages.upsert',
      data: {
        messages: [
          {
            key: {
              id: 'evo-msg-group-1',
              remoteJid: '5511999999999@s.whatsapp.net',
              fromMe: false,
              isGroup: true,
            },
            messageTimestamp: 1_700_000_000,
            pushName: 'Grupo',
            message: {
              conversation: 'mensagem de grupo',
            },
          },
        ],
      },
    }

    const response = await sendEventOnce(payload)

    expect(response.status).toBe(200)
    expect(dbState.messages).toHaveLength(0)
    expect(dbState.conversationUpdates).toBe(0)
  })

  it('ignores inbound messages with @g.us or broadcast JIDs', async () => {
    const groupPayload = {
      instance: 'inst-1',
      event: 'messages.upsert',
      data: {
        messages: [
          {
            key: {
              id: 'evo-msg-group-jid',
              remoteJid: '123456@g.us',
              fromMe: false,
            },
            messageTimestamp: 1_700_000_000,
            message: {
              conversation: 'grupo',
            },
          },
          {
            key: {
              id: 'evo-msg-broadcast-jid',
              remoteJid: 'status@broadcast',
              fromMe: false,
            },
            messageTimestamp: 1_700_000_001,
            message: {
              conversation: 'lista',
            },
          },
        ],
      },
    }

    const response = await sendEventOnce(groupPayload)

    expect(response.status).toBe(200)
    expect(dbState.messages).toHaveLength(0)
    expect(dbState.conversationUpdates).toBe(0)
  })

  it('persists contact avatar_url when profilePicUrl is present', async () => {
    const payload = {
      instance: 'inst-1',
      event: 'messages.upsert',
      data: {
        messages: [
          {
            key: {
              id: 'evo-msg-avatar-1',
              remoteJid: '5511999999999@s.whatsapp.net',
              fromMe: false,
            },
            messageTimestamp: 1_700_000_000,
            pushName: 'Cliente',
            profilePicUrl: 'https://cdn.example.com/avatar.jpg',
            message: {
              conversation: 'oi',
            },
          },
        ],
      },
    }

    const response = await sendEventOnce(payload)

    expect(response.status).toBe(200)
    expect(dbState.contactUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'contact-1',
          payload: expect.objectContaining({
            avatar_url: 'https://cdn.example.com/avatar.jpg',
          }),
        }),
      ]),
    )
  })

  it('reopens a closed conversation as pending and resets AI/session state', async () => {
    dbState.conversation.status = 'closed'
    dbState.conversation.assigned_agent_id = 'agent-1'
    dbState.conversation.ai_autoreply_disabled = true
    dbState.conversation.ai_reply_count = 4
    dbState.conversation.ai_handoff_summary = 'handoff note'
    dbState.conversation.session_started_at = '2026-01-01T00:00:00.000Z'

    const payload = makeInboundPayload('evo-msg-reopen-1')
    const response = await sendEventOnce(payload)

    expect(response.status).toBe(200)
    expect(dbState.conversation.status).toBe('pending')
    expect(dbState.conversation.assigned_agent_id).toBeNull()
    expect(dbState.conversation.ai_autoreply_disabled).toBe(false)
    expect(dbState.conversation.ai_reply_count).toBe(0)
    expect(dbState.conversation.ai_handoff_summary).toBeNull()
    expect(dbState.conversation.session_started_at).toBe('2023-11-14T22:13:20.000Z')
  })
})
