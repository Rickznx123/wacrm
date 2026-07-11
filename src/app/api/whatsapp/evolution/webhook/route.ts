import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { verifyEvolutionWebhookAuth } from '@/lib/whatsapp/evolution-webhook-auth'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { resolveEvolutionProvider } from '@/integrations/registry'
import { attachAutoNewLeadTag } from '@/lib/contacts/auto-lead-tag'

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

type EvolutionWebhookEvent = {
  instanceId: string | null
  status: 'creating' | 'qrcode' | 'connected' | 'disconnected' | 'error'
  isConnectionEvent: boolean
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
  profilePicUrl: string | null
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document' | 'location'
  text: string | null
  mediaUrl: string | null
  timestampIso: string
}

const WHATSAPP_MEDIA_BUCKET = 'whatsapp-media'

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

function isInboundMediaType(contentType: ParsedInboundMessage['contentType']): boolean {
  return (
    contentType === 'image' ||
    contentType === 'video' ||
    contentType === 'audio' ||
    contentType === 'document'
  )
}

function extensionFromMime(mime: string | null, fallback: string): string {
  const normalized = String(mime || '').toLowerCase()
  if (normalized.includes('image/jpeg')) return 'jpg'
  if (normalized.includes('image/png')) return 'png'
  if (normalized.includes('image/webp')) return 'webp'
  if (normalized.includes('video/mp4')) return 'mp4'
  if (normalized.includes('video/3gpp')) return '3gp'
  if (normalized.includes('audio/ogg')) return 'ogg'
  if (normalized.includes('audio/mpeg')) return 'mp3'
  if (normalized.includes('audio/mp4')) return 'm4a'
  if (normalized.includes('application/pdf')) return 'pdf'
  return fallback
}

function fallbackMimeFromContentType(contentType: ParsedInboundMessage['contentType']): string {
  if (contentType === 'image') return 'image/jpeg'
  if (contentType === 'video') return 'video/mp4'
  if (contentType === 'audio') return 'audio/mp4'
  if (contentType === 'document') return 'application/octet-stream'
  return 'application/octet-stream'
}

async function enrichInboundMediaUrl(
  msg: ParsedInboundMessage,
  instanceId: string | null,
  accountId: string,
  logCtx: WebhookLogContext,
): Promise<ParsedInboundMessage> {
  if (!isInboundMediaType(msg.contentType)) return msg
  if (!instanceId) return { ...msg, mediaUrl: null }

  try {
    const evo = resolveEvolutionProvider()
    const media = await evo.getMediaBase64(instanceId, {
      messageId: msg.messageId,
      // Kept true for audio to improve browser playback compatibility.
      convertToMp4: msg.contentType === 'audio',
      timeoutMs: 8000,
    })

    const mime = media.mimetype || fallbackMimeFromContentType(msg.contentType)
    const ext = extensionFromMime(mime, msg.contentType === 'document' ? 'bin' : msg.contentType)
    const objectPath = `account-${accountId}/${msg.messageId}.${ext}`
    const bytes = Buffer.from(media.base64, 'base64')

    const { error: uploadErr } = await supabaseAdmin()
      .storage
      .from(WHATSAPP_MEDIA_BUCKET)
      .upload(objectPath, bytes, {
        upsert: true,
        contentType: mime,
        cacheControl: '31536000',
      })

    if (uploadErr) throw uploadErr

    const {
      data: { publicUrl },
    } = supabaseAdmin().storage.from(WHATSAPP_MEDIA_BUCKET).getPublicUrl(objectPath)

    return { ...msg, mediaUrl: publicUrl || null }
  } catch (error) {
    logStructured('warn', 'media.enrich_failed', {
      ...logCtx,
      messageId: msg.messageId,
      contentType: msg.contentType,
      ...sanitizeErrorContext(error),
    })
    return { ...msg, mediaUrl: null }
  }
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

function isGroupOrBroadcastMessage(raw: Record<string, unknown>, remoteJid: string | null): boolean {
  const key = asObject(raw.key)
  if (key.isGroup === true || raw.isGroup === true) return true
  if (!remoteJid) return false
  const jid = remoteJid.toLowerCase()
  return jid.endsWith('@g.us') || jid.includes('broadcast')
}

function extractProfilePicUrl(raw: Record<string, unknown>): string | null {
  const candidates = [
    raw,
    asObject(raw.contact),
    asObject(raw.sender),
    asObject(raw.pushNameData),
  ]

  for (const candidate of candidates) {
    const value =
      asString(candidate.profilePicUrl) ||
      asString(candidate.profilePictureUrl) ||
      asString(candidate.picture) ||
      asString(candidate.photo)
    if (value) return value
  }

  return null
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

  const eventName = String(asString(root.event) || '').toLowerCase()
  const stateRaw = asString(data.state) || asString(root.state) || ''
  const state = String(stateRaw || 'disconnected').toLowerCase()
  const isConnectionEvent =
    eventName.includes('connection') || eventName.includes('qrcode') || !!stateRaw

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
    isConnectionEvent,
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
  if (isGroupOrBroadcastMessage(raw, remoteJid)) return null
  const phone = phoneFromJid(remoteJid) || asString(raw.phone)
  if (!messageId || !phone) return null

  const msg = asObject(raw.message)
  const pushName = asString(raw.pushName) || asString(raw.notifyName) || phone
  const profilePicUrl = extractProfilePicUrl(raw)
  const timestampIso = parseTimestamp(raw.messageTimestamp || raw.timestamp)

  const textConversation = asString(msg.conversation)
  if (textConversation) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      profilePicUrl,
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
      profilePicUrl,
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
      profilePicUrl,
      contentType: 'image',
      text: asString(image.caption),
      mediaUrl: null,
      timestampIso,
    }
  }

  const video = asObject(msg.videoMessage)
  if (Object.keys(video).length > 0) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      profilePicUrl,
      contentType: 'video',
      text: asString(video.caption),
      mediaUrl: null,
      timestampIso,
    }
  }

  const document = asObject(msg.documentMessage)
  if (Object.keys(document).length > 0) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      profilePicUrl,
      contentType: 'document',
      text: asString(document.fileName),
      mediaUrl: null,
      timestampIso,
    }
  }

  const audio = asObject(msg.audioMessage)
  if (Object.keys(audio).length > 0) {
    return {
      messageId,
      phone: normalizePhone(phone),
      name: pushName,
      profilePicUrl,
      contentType: 'audio',
      text: null,
      mediaUrl: null,
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
      profilePicUrl,
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
    profilePicUrl,
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

async function findOrCreateContact(
  accountId: string,
  ownerUserId: string,
  phone: string,
  name: string,
  profilePicUrl: string | null,
) {
  const existing = await findExistingContact(supabaseAdmin(), accountId, phone)
  if (existing) {
    const updates: Record<string, unknown> = {}
    if (name && name !== existing.name) {
      updates.name = name
    }
    if (
      profilePicUrl &&
      profilePicUrl !== String(existing.avatar_url ?? '')
    ) {
      updates.avatar_url = profilePicUrl
    }

    if (Object.keys(updates).length > 0) {
      await supabaseAdmin()
        .from('contacts')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { contact: existing, wasCreated: false }
  }

  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: name || phone,
      avatar_url: profilePicUrl,
    })
    .select('id, phone, name')
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    return null
  }
  return { contact: data, wasCreated: true }
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
  const contactOutcome = await findOrCreateContact(
    accountId,
    ownerUserId,
    msg.phone,
    msg.name,
    msg.profilePicUrl,
  )
  if (!contactOutcome) return 'permanent_error' as ProcessingResult

  const contact = contactOutcome.contact
  if (contactOutcome.wasCreated) {
    try {
      await attachAutoNewLeadTag(supabaseAdmin(), {
        accountId,
        userId: ownerUserId,
        contactId: contact.id,
      })
    } catch (tagErr) {
      logStructured('warn', 'contact.auto_new_lead_tag_failed', {
        ...logCtx,
        contactId: contact.id,
        ...sanitizeErrorContext(tagErr),
      })
    }
  }

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

  if (msg.contentType === 'text' && (msg.text ?? '').trim()) {
    try {
      await dispatchInboundToAiReply({
        accountId,
        conversationId: conv.row.id,
        contactId: contact.id,
        configOwnerUserId: ownerUserId,
        channelProvider: 'evolution',
        inboundMessageId: msg.messageId,
      })
    } catch (aiErr) {
      logStructured('error', 'ai.autoreply_dispatch_failed', {
        ...logCtx,
        stage: 'ai.auto_reply',
        messageId: msg.messageId,
        ...sanitizeErrorContext(aiErr),
      })
    }
  }

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
    const channelPatch: Record<string, unknown> = {
      qr_code: parsed.qrCode,
      phone: parsed.phone,
      profile_name: parsed.profileName,
      last_error: parsed.lastError,
    }
    if (parsed.isConnectionEvent) {
      channelPatch.status = parsed.status
      channelPatch.connected_at = parsed.status === 'connected' ? now : null
      channelPatch.disconnected_at = parsed.status === 'connected' ? null : now
    }

    const { error } = await supabaseAdmin()
      .from('whatsapp_channels')
      .update(channelPatch)
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
      const enriched = await enrichInboundMediaUrl(msg, parsed.instanceId, accountId, logCtx)
      const result = await persistInboundMessage(accountId, ownerUserId, enriched, logCtx)
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
