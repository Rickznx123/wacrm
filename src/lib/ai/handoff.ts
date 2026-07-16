import type { ChatMessage } from './types'
import { DELIVERY_FEES, extractNeighborhood } from '@/lib/delivery-fees'

export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
  contactPhone?: string | null
}): string {
  const { messages, replyCount, contactPhone } = args

  const userMessages = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.trim())
    .filter(Boolean)

  const name = extractCustomerName(userMessages)
  const phoneFromConversation = extractPhone(userMessages)
  const phone = phoneFromConversation ?? normalizePhone(contactPhone)

  const address = extractAddress(userMessages)
  const neighborhood = extractDeliveryNeighborhood(userMessages)
  const reference = extractReference(userMessages)
  const fee = neighborhood ? DELIVERY_FEES[neighborhood] ?? null : null

  const products = extractProducts(userMessages)
  const observations = extractObservations(userMessages, replyCount)

  const lines: string[] = [
    '==================================================',
    '',
    '🛒 NOVO PEDIDO',
    '',
    '👤 Cliente:',
    `- ${name ?? 'Não informado'}`,
    '',
    '📞 Telefone:',
    `- ${phone ?? 'Não informado'}`,
    '',
    '📍 Entrega:',
    `- Endereço: ${address ?? 'Não informado'}`,
    `- Bairro: ${neighborhood ?? 'Não informado'}`,
    `- Referência: ${reference ?? 'Não informada'}`,
    '',
    '🚚 Taxa de entrega:',
    `- ${fee == null ? 'Não encontrada na DELIVERY_FEES' : formatBrl(fee)}`,
    '',
    '🛍 Produtos solicitados:',
  ]

  if (products.length === 0) {
    lines.push('- Não identificado')
  } else {
    for (const item of products) lines.push(`• ${item}`)
  }

  lines.push('', '💬 Observações:')

  if (observations.length === 0) {
    lines.push('- Sem observações relevantes.')
  } else {
    for (const note of observations) lines.push(`- ${note}`)
  }

  lines.push('', '==================================================')

  return lines.join('\n')
}

function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact || null
}

function extractCustomerName(userMessages: string[]): string | null {
  const explicit = findByRegex(userMessages, /^\s*(?:nome)\s*[:\-]?\s*(.+)$/i)
  if (explicit) return explicit

  const latest = userMessages[userMessages.length - 1] ?? ''
  const firstLine = latest.split(/\r?\n/)[0]?.trim() ?? ''
  if (!firstLine) return null
  if (/\d/.test(firstLine)) return null
  if (firstLine.split(/\s+/).length > 5) return null
  if (/\b(?:rua|avenida|av\.?|endere[cç]o|bairro|telefone|celular|frete|taxa)\b/i.test(firstLine)) {
    return null
  }
  return toTitleCase(firstLine)
}

function extractPhone(userMessages: string[]): string | null {
  const phoneRe = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9?\d{4}[\s-]?\d{4})/g
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const msg = userMessages[i]
    const matches = msg.match(phoneRe)
    if (!matches || matches.length === 0) continue
    const raw = matches[matches.length - 1].replace(/\s+/g, ' ').trim()
    if (raw) return raw
  }
  return null
}

function extractAddress(userMessages: string[]): string | null {
  const explicit = findByRegex(userMessages, /\b(?:endere[cç]o)\s*[:\-]?\s*(.+)$/i)
  if (explicit) return explicit

  for (let i = userMessages.length - 1; i >= 0; i--) {
    const line = pickLine(userMessages[i], /\b(?:rua|avenida|av\.?|travessa|alameda|estr\.?|rodovia|vicinal)\b/i)
    if (line) return line
  }
  return null
}

function extractDeliveryNeighborhood(userMessages: string[]): string | null {
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const neighborhood = extractNeighborhood(userMessages[i])
    if (neighborhood) return neighborhood
  }
  return null
}

function extractReference(userMessages: string[]): string | null {
  const explicit = findByRegex(userMessages, /\b(?:refer[eê]ncia|ponto\s+de\s+refer[eê]ncia)\s*[:\-]?\s*(.+)$/i)
  if (explicit) return explicit

  for (let i = userMessages.length - 1; i >= 0; i--) {
    const line = pickLine(
      userMessages[i],
      /\b(?:esquina|port[aã]o|pr[oó]ximo|fundos|lado\s+de|ao\s+lado|perto\s+de|bloco|apto|apartamento)\b/i,
    )
    if (line) return line
  }
  return null
}

function extractProducts(userMessages: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  for (const msg of userMessages) {
    const lines = msg.split(/\r?\n/)

    for (const rawLine of lines) {
      const line = rawLine.replace(/^[-*•]\s*/, '').trim()
      if (!line) continue

      const qtyLine = line.match(/^(\d+)\s*x\s+(.+)$/i)
      if (qtyLine) {
        const item = normalizeProductName(qtyLine[2])
        if (item) pushUnique(out, seen, `${qtyLine[1]}x ${item}`)
      }

      const qtyInline = /(\d+)\s*x\s*([\p{L}0-9][\p{L}0-9\s./%-]{2,80}?)(?=(?:,|;|$))/giu
      for (const m of line.matchAll(qtyInline)) {
        const item = normalizeProductName(m[2] ?? '')
        if (item) pushUnique(out, seen, `${m[1]}x ${item}`)
      }
    }

    const intentRe = /\b(?:quero|preciso|gostaria\s+de|vou\s+levar|pode\s+separar|manda|me\s+v[eê]|me\s+ve)\s+([^.!?\n]+)/gi
    for (const m of msg.matchAll(intentRe)) {
      const chunk = (m[1] ?? '').trim()
      if (!chunk) continue
      const parts = chunk.split(/\s+e\s+/i)
      for (const part of parts) {
        const item = normalizeProductName(part)
        if (item) pushUnique(out, seen, item)
      }
    }
  }

  return out
}

function extractObservations(userMessages: string[], replyCount: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const obsRe =
    /\b(?:hoje|amanh[ãa]|agora|urgente|pix|dinheiro|cart[aã]o|cr[eé]dito|d[eé]bito|troco|sem\s+troco|retirar|buscar|entregar|entrega|hor[aá]rio)\b/i

  for (const msg of userMessages) {
    for (const rawLine of msg.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      if (!obsRe.test(line)) continue
      pushUnique(out, seen, collapseWhitespace(line))
    }
  }

  const handoffTrace =
    replyCount === 0
      ? 'IA fez handoff sem responder nesta etapa.'
      : `IA fez handoff após ${replyCount} ${replyCount === 1 ? 'resposta' : 'respostas'}.`
  pushUnique(out, seen, handoffTrace)

  return out
}

function findByRegex(messages: string[], re: RegExp): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i].match(re)
    const value = m?.[1]?.trim()
    if (value) return collapseWhitespace(value)
  }
  return null
}

function pickLine(message: string, re: RegExp): string | null {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    if (re.test(line)) return collapseWhitespace(line)
  }
  return null
}

function normalizeProductName(value: string): string | null {
  const cleaned = collapseWhitespace(
    value
      .replace(/^[,;:.\-\s]+/, '')
      .replace(/[?!.;,]+$/g, ''),
  )
  if (!cleaned) return null
  if (cleaned.length < 2) return null
  if (/\b(?:taxa|frete|entrega|endere[cç]o|refer[eê]ncia|telefone|bairro)\b/i.test(cleaned)) {
    return null
  }
  return cleaned
}

function pushUnique(out: string[], seen: Set<string>, value: string): void {
  const v = collapseWhitespace(value)
  if (!v) return
  const key = v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  out.push(v)
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function formatBrl(value: number): string {
  return `R$ ${value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|\s)([\p{L}])/gu, (_m, p1: string, p2: string) => `${p1}${p2.toUpperCase()}`)
}
