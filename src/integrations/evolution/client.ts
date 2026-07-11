import type { ChannelState, EvolutionProvider } from '../types'
import { getRequiredEvolutionWebhookSecret } from '@/lib/whatsapp/evolution-webhook-auth'

interface EvolutionConfig {
  baseUrl: string
  apiKey: string
}

interface EvolutionFetchOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000

interface EvolutionSendResult {
  key?: {
    id?: string
  }
  message?: {
    key?: {
      id?: string
    }
  }
  data?: {
    key?: {
      id?: string
    }
    id?: string
    messageId?: string
  }
  id?: string
  messageId?: string
}

function getConfig(): EvolutionConfig {
  const baseUrl = process.env.EVOLUTION_API_BASE_URL?.trim()
  const apiKey = process.env.EVOLUTION_API_KEY?.trim()

  if (!baseUrl || !apiKey) {
    throw new Error(
      'Evolution API is not configured. Set EVOLUTION_API_BASE_URL and EVOLUTION_API_KEY.',
    )
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
  }
}

function getTimeoutMs(): number {
  const raw = Number(process.env.EVOLUTION_API_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(raw), MAX_TIMEOUT_MS)
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = 'name' in err ? String((err as { name?: unknown }).name ?? '') : ''
  return name === 'AbortError' || name === 'TimeoutError'
}

function sanitizeUpstreamErrorMessage(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return ''

  const redacted = compact
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(sb_(publishable|secret)_[A-Za-z0-9._-]+)\b/g, '[redacted]')

  return redacted.slice(0, 240)
}

async function evolutionFetch(path: string, options: EvolutionFetchOptions = {}) {
  const cfg = getConfig()
  const timeoutMs = getTimeoutMs()

  let response: Response
  try {
    response = await fetch(`${cfg.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        apikey: cfg.apiKey,
        'Content-Type': 'application/json',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (isAbortLikeError(err)) {
      throw new Error('Evolution API request timed out')
    }
    throw new Error('Evolution API request failed')
  }

  const raw = await response.text()
  const data = raw ? safeJson(raw) : null

 if (!response.ok) {

  const upstream =
    (data as { message?: string } | null)?.message ||
    raw ||
    ''

  const safeMessage = sanitizeUpstreamErrorMessage(upstream)
  const message = safeMessage || `Evolution API error ${response.status}`

  throw new Error(message)
}

  return data
}

async function evolutionFetchFirst(paths: string[], options: EvolutionFetchOptions): Promise<unknown> {
  let lastError: unknown = null
  for (const path of paths) {
    try {
      return await evolutionFetch(path, options)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Evolution API request failed')
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function mapState(instanceId: string, payload: unknown): ChannelState {
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const instance = readObject(root, 'instance')

  const statusRaw = String(
    readString(instance, 'state') ||
      readString(root, 'state') ||
      readString(root, 'status') ||
      'disconnected',
  ).toLowerCase()

  const qrCodeObj = readObject(root, 'qrcode')
  const qrCode =
    readString(qrCodeObj, 'base64') ||
    readString(root, 'qrcode') ||
    readString(root, 'qr') ||
    readString(root, 'base64')

  const status: ChannelState['status'] =
    statusRaw.includes('open') || statusRaw.includes('connected')
      ? 'connected'
      : qrCode
        ? 'qrcode'
        : statusRaw.includes('creating')
          ? 'creating'
          : statusRaw.includes('error')
            ? 'error'
            : 'disconnected'

  return {
    provider: 'evolution',
    status,
    instanceId,
    qrCode: qrCode ?? null,
    phone:
      readString(instance, 'wuid') ||
      readString(instance, 'number') ||
      readString(root, 'number') ||
      null,
    profileName:
      readString(instance, 'profileName') ||
      readString(instance, 'name') ||
      readString(root, 'name') ||
      null,
    lastError: readString(root, 'error') || null,
  }
}

function extractMessageId(payload: unknown): string {
  const root = payload && typeof payload === 'object' ? (payload as EvolutionSendResult) : {}
  return (
    root?.messageId ||
    root?.id ||
    root?.data?.messageId ||
    root?.data?.id ||
    root?.key?.id ||
    root?.message?.key?.id ||
    root?.data?.key?.id ||
    `evo-${Date.now()}`
  )
}

export const evolutionProvider: EvolutionProvider = {
  name: 'evolution',

  async createOrConnect(instanceId, webhookUrl) {
    try {
      const existing = await evolutionFetch(`/instance/connectionState/${instanceId}`)
      const currentState = mapState(instanceId, existing)

      if (currentState.status !== 'connected') {
        const qrPayload = await evolutionFetch(`/instance/connect/${instanceId}`)
        return mapState(instanceId, qrPayload)
      }

      return currentState
    } catch (err) {
      const payload = await evolutionFetch('/instance/create', {
        method: 'POST',
        body: {
          instanceName: instanceId,
          integration: 'WHATSAPP-BAILEYS',
          qrcode: true,
          webhook: {
            enabled: true,
            url: webhookUrl,
            headers: {
              'x-evolution-secret': getRequiredEvolutionWebhookSecret(),
            },
            byEvents: false,
            base64: false,
            events: [
              'QRCODE_UPDATED',
              'CONNECTION_UPDATE',
              'MESSAGES_UPSERT',
            ],
          },
        },
      })
      return mapState(instanceId, payload)
    }
  },

  async listContacts(instanceId) {
    const payload = await evolutionFetch(`/chat/findContacts/${instanceId}`, {
      method: 'POST',
      body: {},
    })
    const list = Array.isArray(payload) ? payload : []

    const contacts: Array<{ phone: string; name: string | null; profilePicUrl?: string | null }> = []

    for (const item of list) {
      const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      // The phone JID lives in `remoteJid` (e.g. "5599...@s.whatsapp.net");
      // `id` is an internal cuid, not a number. Groups are flagged with
      // `isGroup: true` rather than a "@g.us" suffix on the id.
      const jid = typeof obj.remoteJid === 'string' ? obj.remoteJid : ''
      if (!jid || obj.isGroup === true || jid.endsWith('@g.us') || jid.includes('broadcast')) {
        continue
      }

      const digits = jid.split('@')[0]
      if (!digits || !/^\d+$/.test(digits)) continue

      const name =
        (typeof obj.pushName === 'string' && obj.pushName) ||
        (typeof obj.name === 'string' && obj.name) ||
        null

      const profilePicUrl =
        (typeof obj.profilePicUrl === 'string' && obj.profilePicUrl) ||
        (typeof obj.profilePictureUrl === 'string' && obj.profilePictureUrl) ||
        (typeof obj.picture === 'string' && obj.picture) ||
        (typeof obj.photo === 'string' && obj.photo) ||
        null

      contacts.push({ phone: `+${digits}`, name, profilePicUrl })
    }

    return contacts
  },

  async readState(instanceId) {
    const payload = await evolutionFetch(`/instance/connectionState/${instanceId}`)
    return mapState(instanceId, payload)
  },

  async disconnect(instanceId) {
    await evolutionFetch(`/instance/logout/${instanceId}`, {
      method: 'DELETE',
    })
  },

  async sendText(instanceId, to, text) {
    const payload = await evolutionFetchFirst(
      [
        `/message/sendText/${instanceId}`,
        `/message/sendtext/${instanceId}`,
      ],
      {
        method: 'POST',
        body: {
          number: to,
          text,
        },
      },
    )
    return { messageId: extractMessageId(payload) }
  },

  async sendMedia(instanceId, args) {
    const payload = await evolutionFetchFirst(
      [
        `/message/sendMedia/${instanceId}`,
        `/message/sendmedia/${instanceId}`,
      ],
      {
        method: 'POST',
        body: {
          number: args.to,
          mediatype: args.kind,
          media: args.link,
          fileName: args.filename,
          caption: args.caption,
        },
      },
    )
    return { messageId: extractMessageId(payload) }
  },
}
