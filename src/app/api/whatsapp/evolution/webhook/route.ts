import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { verifyEvolutionWebhookAuth } from '@/lib/whatsapp/evolution-webhook-auth'

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

type EvolutionWebhookEvent = {
  instanceId: string | null
  status: 'creating' | 'qrcode' | 'connected' | 'disconnected' | 'error'
  phone: string | null
  profileName: string | null
  qrCode: string | null
  lastError: string | null
}

type EvolutionStatus = 'sent' | 'delivered' | 'read' | 'failed'

type ParsedInboundMessage = {
  messageId: string
  phone: string
  name: string
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document' | 'location'
  text: string | null
  mediaUrl: string | null
  timestampIso: string
}

type ProcessingResult = 'ok' | 'transient_error' | 'permanent_error'

type WebhookLogContext = {
  correlationId: string
  instanceId?: string | null
  accountId?: string | null
}

type LogLevel = 'info' | 'warn' | 'error'

function buildCorrelationId(request: Request): string {
  const headerId =
    request.headers.get('x-correlation-id')?.trim() ||
    request.headers.get('x-request-id')?.trim() ||
    request.headers.get('traceparent')?.trim()

  if (headerId) return headerId

  const generated = globalThis.crypto?.randomUUID?.()
  if (generated) return generated
  return `evo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function sanitizeErrorContext(error: unknown): Record<string, unknown> {
  return {
    code: getErrorCode(error),
    transient: isTransientError(error),
    name:
      typeof error === 'object' && error && 'name' in error
        ? String((error as { name?: unknown }).name ?? 'Error')
        : 'Error',
  }
}

function logStructured(level: LogLevel, event: string, context: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    scope: 'evolution_webhook',
    event,
    ...context,
  })

  if (level === 'error') {
    console.error(line)
    return
  }
  if (level === 'warn') {
    console.warn(line)
    return
  }
  console.info(line)
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

function isTransientError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (code) {
    // Postgres/Supabase classes commonly considered transient.
    if (code.startsWith('08')) return true // connection exception
    if (code === '40001' || code === '40P01') return true // serialization / deadlock
    if (code === '53300' || code === '53400') return true // resource exhaustion
    if (code === '57P01' || code === '57P02' || code === '57P03') return true // shutdown/crash/cannot_connect_now
  }

  const message =
    typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : ''
  const normalized = message.toLowerCase()
  return (
    normalized.includes('timeout') ||
    normalized.includes('temporar') ||
    normalized.includes('connection reset') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('cannot_connect_now')
  )
}

function parseTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return new Date(numeric < 2_000_000_000 ? numeric * 1000 : numeric).toISOString()
    }
    const date = new Date(value)
    if (!Number.isNaN(date.valueOf())) return date.toISOString()
  }
  if (typeof value === 'number') {
    return new Date(value < 2_000_000_000 ? value * 1000 : value).toISOString()
  }
  return new Date().toISOString()
}

function phoneFromJid(raw: string | null): string | null {
  if (!raw) return null
  const left = raw.split('@')[0] ?? ''
  const digits = left.replace(/[^\d+]/g, '')
  if (!digits) return null
  return digits.startsWith('+') ? digits : `+${digits}`
}

function mapAckToStatus(value: unknown): EvolutionStatus | null {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    if (normalized.includes('read')) return 'read'
    if (normalized.includes('deliver')) return 'delivered'
    if (normalized.includes('sent')) return 'sent'
    if (normalized.includes('fail') || normalized.includes('error')) return 'failed'
    return null
  }
  if (typeof value === 'number') {
    if (value >= 3) return 'read'
    if (value === 2) return 'delivered'
    if (value === 1) return 'sent'
    if (value < 0) return 'failed'
  }
  return null
}

function normalizeEvent(body: unknown): EvolutionWebhookEvent {
  const root = asObject(body)
  const data = asObject(root.data)

  const instanceId =
    asString(root.instance) ||
    asString(root.instanceName) ||
    asString(data.instance) ||
    asString(data.instanceName) ||
    asString(root.instanceId) ||
    null

  const state = String(
    asString(root.event) || asString(data.state) || asString(root.state) || 'disconnected',
  ).toLowerCase()

  const status =
    state.includes('open') || state.includes('connected')
      ? 'connected'
      : state.includes('qrcode')
        ? 'qrcode'
        : state.includes('create')
          ? 'creating'
          : state.includes('error')
            ? 'error'
            : 'disconnected'

  const payload = Object.keys(data).length > 0 ? data : root

  return {
    instanceId,
    status,
    phone: asString(payload.wuid) || asString(payload.number) || null,
    profileName: asString(payload.profileName) || asString(payload.pushName) || null,
    qrCode:
      asString(asObject(payload.qrcode).base64) ||
      asString(payload.qrcode) ||
      asString(payload.qr) ||
      asString(payload.base64) ||
      null,
    lastError: asString(payload.error) || null,
  }
}

function parseInboundMessage(raw: Record<string, unknown>): ParsedInboundMessage | null {
  const key = asObject(raw.key)
  const fromMe = key.fromMe === true
  if (fromMe) return null

  // Use Evolution's official message id (key.id) as the idempotency key.
  const messageId = asString(key.id)
  const remoteJid = asString(key.remoteJid) || asString(raw.remoteJid)
  const phone = phoneFromJid(remoteJid) || asString(raw.phone)
  if (!messageId || !phone) return null

  const msg = asObject(raw.message)
  const pushName = asString(raw.pushName) || asString(raw.notifyName) || phone
  const timestampIso = parseTimestamp(raw.messageTimestamp || raw.timestamp)

  const textConversation = asString(msg.conversation)
  if (textConversation) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      contentType: 'text',
      text: textConversation,
      mediaUrl: null,
      timestampIso,
    }
  }

  const extended = asObject(msg.extendedTextMessage)
  if (asString(extended.text)) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      contentType: 'text',
      text: asString(extended.text),
      mediaUrl: null,
      timestampIso,
    }
  }

  const image = asObject(msg.imageMessage)
  if (Object.keys(image).length > 0) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      contentType: 'image',
      text: asString(image.caption),
      mediaUrl: asString(image.url) || asString(image.directPath) || null,
      timestampIso,
    }
  }

  const video = asObject(msg.videoMessage)
  if (Object.keys(video).length > 0) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      contentType: 'video',
      text: asString(video.caption),
      mediaUrl: asString(video.url) || asString(video.directPath) || null,
      timestampIso,
    }
  }

  const document = asObject(msg.documentMessage)
  if (Object.keys(document).length > 0) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      contentType: 'document',
      text: asString(document.fileName),
      mediaUrl: asString(document.url) || asString(document.directPath) || null,
      timestampIso,
    }
  }

  const audio = asObject(msg.audioMessage)
  if (Object.keys(audio).length > 0) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      contentType: 'audio',
      text: null,
      mediaUrl: asString(audio.url) || asString(audio.directPath) || null,
      timestampIso,
    }
  }

  const location = asObject(msg.locationMessage)
  if (Object.keys(location).length > 0) {
    const latitude = asNumber(location.degreesLatitude)
    const longitude = asNumber(location.degreesLongitude)
    const locText = [
      asString(location.name),
      asString(location.address),
      latitude != null && longitude != null ? `${latitude},${longitude}` : null,
    ]
      .filter((part): part is string => !!part)
      .join(' - ')
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      contentType: 'location',
      text: locText || '[Location]',
      mediaUrl: null,
      timestampIso,
    }
  }

  return {
    messageId,
    phone: normalizePhone(phone),
    name: pushName,
    contentType: 'text',
    text: '[Unsupported Evolution message]',
    mediaUrl: null,
    timestampIso,
  }
}

function parseInboundMessages(body: Record<string, unknown>): ParsedInboundMessage[] {
  const data = asObject(body.data)
  const rootMessages = asArray(body.messages)
  const dataMessages = asArray(data.messages)

  if (dataMessages.length > 0) {
    return dataMessages
      .map((item) => parseInboundMessage(asObject(item)))
      .filter((item): item is ParsedInboundMessage => item != null)
  }

  if (rootMessages.length > 0) {
    return rootMessages
      .map((item) => parseInboundMessage(asObject(item)))
      .filter((item): item is ParsedInboundMessage => item != null)
  }

  if (data.key || data.message) {
    const single = parseInboundMessage(data)
    return single ? [single] : []
  }

  return []
}

function parseStatusUpdates(body: Record<string, unknown>): Array<{ messageId: string; status: EvolutionStatus }> {
  const data = asObject(body.data)
  const updates = asArray(data.messages).concat(asArray(body.messages))
  const parsed: Array<{ messageId: string; status: EvolutionStatus }> = []

  for (const item of updates) {
    const row = asObject(item)
    const key = asObject(row.key)
    const messageId = asString(key.id) || asString(row.id)
    const status =
      mapAckToStatus(row.status) ||
      mapAckToStatus(row.messageStatus) ||
      mapAckToStatus(row.ack)
    if (messageId && status) {
      parsed.push({ messageId, status })
    }
  }

  if (parsed.length === 0) {
    const singleMessageId = asString(data.id) || asString(body.id)
    const singleStatus =
      mapAckToStatus(data.status) ||
      mapAckToStatus(body.status) ||
      mapAckToStatus(data.messageStatus) ||
      mapAckToStatus(body.messageStatus) ||
      mapAckToStatus(data.ack) ||
      mapAckToStatus(body.ack)
    if (singleMessageId && singleStatus) {
      parsed.push({ messageId: singleMessageId, status: singleStatus })
    }
  }

  return parsed
}

const accountOwnerCache = new Map<string, string>()

async function resolveAccountOwnerUserId(accountId: string): Promise<string | null> {
  const cached = accountOwnerCache.get(accountId)
  if (cached) return cached

  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle()

  if (error || !data?.owner_user_id) return null
  accountOwnerCache.set(accountId, data.owner_user_id)
  return data.owner_user_id
}

async function findOrCreateContact(accountId: string, ownerUserId: string, phone: string, name: string) {
  const existing = await findExistingContact(supabaseAdmin(), accountId, phone)
  if (existing) {
    if (name && name !== existing.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return existing
  }

  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: name || phone,
    })
    .select('id, phone, name')
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return raced
    }
    return null
  }
  return data
}

async function findOrCreateConversation(accountId: string, ownerUserId: string, contactId: string) {
  const { data: existing } = await supabaseAdmin()
    .from('conversations')
    .select('id, unread_count')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (existing) return { row: existing, created: false }

  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
    })
    .select('id, unread_count')
    .single()

  if (error || !data) return null
  return { row: data, created: true }
}

async function persistInboundMessage(
  accountId: string,
  ownerUserId: string,
  msg: ParsedInboundMessage,
  logCtx: WebhookLogContext,
) {
  const contact = await findOrCreateContact(accountId, ownerUserId, msg.phone, msg.name)
  if (!contact) return 'permanent_error' as ProcessingResult

  const conv = await findOrCreateConversation(accountId, ownerUserId, contact.id)
  if (!conv) return 'permanent_error' as ProcessingResult

  const { data: existingMsg } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('conversation_id', conv.row.id)
    .eq('message_id', msg.messageId)
    .maybeSingle()

  if (existingMsg) {
    return 'ok' as ProcessingResult
  }

  const lastMessageText = msg.text || `[${msg.contentType}]`

  const { data: persisted, error: persistErr } = await supabaseAdmin().rpc(
    'persist_inbound_message_and_touch_conversation',
    {
      p_conversation_id: conv.row.id,
      p_message_id: msg.messageId,
      p_content_type: msg.contentType,
      p_content_text: msg.text,
      p_media_url: msg.mediaUrl,
      p_created_at: msg.timestampIso,
      p_last_message_text: lastMessageText,
    },
  )

  if (persistErr) {
    logStructured('error', 'message.persist_failed', {
      ...logCtx,
      stage: 'persist_inbound_message_and_touch_conversation',
      contentType: msg.contentType,
      hasMedia: !!msg.mediaUrl,
      ...sanitizeErrorContext(persistErr),
    })
    return isTransientError(persistErr) ? ('transient_error' as ProcessingResult) : ('permanent_error' as ProcessingResult)
  }

  if (!persisted) {
    return 'ok' as ProcessingResult
  }

  if (conv.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conv.row.id,
      contact_id: contact.id,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conv.row.id,
    contact_id: contact.id,
    whatsapp_message_id: msg.messageId,
    content_type: msg.contentType,
    text: msg.text,
  })

  return 'ok' as ProcessingResult
}

async function persistStatusUpdate(
  accountId: string,
  status: { messageId: string; status: EvolutionStatus },
  logCtx: WebhookLogContext,
): Promise<ProcessingResult> {
  const { error } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.messageId)

  if (error) {
    logStructured('error', 'status.persist_failed', {
      ...logCtx,
      stage: 'messages.status_update',
      status: status.status,
      ...sanitizeErrorContext(error),
    })
    return isTransientError(error) ? 'transient_error' : 'permanent_error'
  }

  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.messageId)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const convRaw = msgRow.conversations as unknown
    const convObj =
      convRaw && typeof convRaw === 'object' && !Array.isArray(convRaw)
        ? (convRaw as { account_id?: string })
        : null
    const eventAccountId = convObj?.account_id || accountId
    if (eventAccountId) {
      await dispatchWebhookEvent(supabaseAdmin(), eventAccountId, 'message.status_updated', {
        whatsapp_message_id: status.messageId,
        conversation_id: msgRow.conversation_id,
        status: status.status,
      })
    }
  }

  return 'ok'
}

export async function POST(request: Request) {
  const correlationId = buildCorrelationId(request)
  const startedAtMs = Date.now()
  const finish = (response: NextResponse, context: Record<string, unknown> = {}) => {
    logStructured('info', 'request.finish', {
      correlationId,
      httpStatus: response.status,
      durationMs: Date.now() - startedAtMs,
      ...context,
    })
    return response
  }

  try {
    const rawBody = await request.text()

    logStructured('info', 'request.start', {
      correlationId,
      method: request.method,
      payloadBytes: rawBody.length,
      hasSignatureHeader:
        !!request.headers.get('x-evolution-signature') ||
        !!request.headers.get('x-signature') ||
        !!request.headers.get('x-hub-signature-256'),
      hasSecretHeader: !!request.headers.get('x-evolution-secret'),
    })

    const isAuthenticated = verifyEvolutionWebhookAuth(rawBody, {
      signature:
        request.headers.get('x-evolution-signature') ||
        request.headers.get('x-signature') ||
        request.headers.get('x-hub-signature-256'),
      secret: request.headers.get('x-evolution-secret'),
    })
    if (!isAuthenticated) {
      logStructured('warn', 'request.auth_invalid', { correlationId })
      return finish(NextResponse.json({ error: 'Invalid webhook authentication' }, { status: 401 }), {
        outcome: 'auth_invalid',
      })
    }

    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      logStructured('warn', 'request.payload_invalid_json', { correlationId })
      return finish(NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 }), {
        outcome: 'invalid_json',
      })
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      logStructured('warn', 'request.payload_invalid_shape', { correlationId })
      return finish(NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 }), {
        outcome: 'invalid_payload',
      })
    }

    const root = asObject(body)
    const parsed = normalizeEvent(root)

    if (!parsed.instanceId) {
      return finish(NextResponse.json({ ok: true, ignored: true }), {
        outcome: 'ignored_missing_instance',
      })
    }

    const { data: channel } = await supabaseAdmin()
      .from('whatsapp_channels')
      .select('account_id, instance_id')
      .eq('provider', 'evolution')
      .eq('instance_id', parsed.instanceId)
      .maybeSingle()

    if (!channel?.account_id) {
      return finish(NextResponse.json({ ok: true, ignored: true }), {
        outcome: 'ignored_unknown_channel',
        instanceId: parsed.instanceId,
      })
    }

    const accountId = channel.account_id as string
    const logCtx: WebhookLogContext = {
      correlationId,
      instanceId: parsed.instanceId,
      accountId,
    }

    const now = new Date().toISOString()

    const { error } = await supabaseAdmin()
      .from('whatsapp_channels')
      .update({
        status: parsed.status,
        qr_code: parsed.qrCode,
        phone: parsed.phone,
        profile_name: parsed.profileName,
        last_error: parsed.lastError,
        connected_at: parsed.status === 'connected' ? now : null,
        disconnected_at: parsed.status === 'connected' ? null : now,
      })
      .eq('provider', 'evolution')
      .eq('instance_id', parsed.instanceId)

    if (error) {
      if (isTransientError(error)) {
        logStructured('error', 'channel.update_failed', {
          ...logCtx,
          stage: 'whatsapp_channels.update',
          ...sanitizeErrorContext(error),
        })
        return finish(NextResponse.json({ error: 'Temporary processing failure' }, { status: 503 }), {
          outcome: 'transient_error',
        })
      }

      logStructured('error', 'channel.update_failed', {
        ...logCtx,
        stage: 'whatsapp_channels.update',
        ...sanitizeErrorContext(error),
      })
      return finish(NextResponse.json({ ok: true, ignored: true }), {
        outcome: 'permanent_error_ignored',
      })
    }

    const ownerUserId = await resolveAccountOwnerUserId(accountId)
    if (!ownerUserId) {
      return finish(NextResponse.json({ ok: true, ignored: true }), {
        ...logCtx,
        outcome: 'ignored_missing_owner',
      })
    }

    let hasTransientError = false

    const inbound = parseInboundMessages(root)
    for (const msg of inbound) {
      const result = await persistInboundMessage(accountId, ownerUserId, msg, logCtx)
      if (result === 'transient_error') hasTransientError = true
    }

    const statusUpdates = parseStatusUpdates(root)
    for (const status of statusUpdates) {
      const result = await persistStatusUpdate(accountId, status, logCtx)
      if (result === 'transient_error') hasTransientError = true
    }

    if (hasTransientError) {
      return finish(NextResponse.json({ error: 'Temporary processing failure' }, { status: 503 }), {
        ...logCtx,
        inboundCount: inbound.length,
        statusCount: statusUpdates.length,
        outcome: 'transient_error',
      })
    }

    return finish(NextResponse.json({ ok: true }), {
      ...logCtx,
      inboundCount: inbound.length,
      statusCount: statusUpdates.length,
      outcome: 'ok',
    })
  } catch (error) {
    if (isTransientError(error)) {
      logStructured('error', 'request.unexpected_error', {
        correlationId,
        stage: 'request_handler',
        ...sanitizeErrorContext(error),
      })
      return finish(NextResponse.json({ error: 'Temporary processing failure' }, { status: 503 }), {
        outcome: 'transient_error',
      })
    }

    logStructured('error', 'request.unexpected_error', {
      correlationId,
      stage: 'request_handler',
      ...sanitizeErrorContext(error),
    })
    return finish(NextResponse.json({ ok: true, ignored: true }), {
      outcome: 'permanent_error_ignored',
    })
  }
}
