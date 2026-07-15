const DELIVERY_TOPIC_RE =
  /\b(entrega|delivery|frete|taxa(?:\s+de\s+entrega)?|bairro|setor|setores|quil[oô]metro|km)\b/i

const LOCATION_MARKERS_RE =
  /\b(?:bairro|setor|setores|na|no|em|para|pro|pra|do|da)\s+([\p{L}0-9][\p{L}0-9\s\-]{1,60})/giu

const MONEY_RE = /R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}/i

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isLikelyLocation(value: string): boolean {
  const v = normalize(value)
  if (!v) return false
  if (v.length < 3) return false
  const blacklist = new Set([
    'entrega',
    'delivery',
    'frete',
    'taxa',
    'de',
    'a',
    'o',
    'e',
    'por',
    'qual',
    'quanto',
    'calcular',
    'calculo',
    'valor',
  ])
  return !blacklist.has(v)
}

function extractLocationHints(query: string): string[] {
  const out: string[] = []
  for (const m of query.matchAll(LOCATION_MARKERS_RE)) {
    const raw = (m[1] ?? '').trim().replace(/[?!.;,]+$/g, '')
    if (!raw) continue
    // Keep only the leading chunk (e.g. "setor bueno hoje" -> "setor bueno").
    const compact = raw.split(/\b(?:hoje|amanha|agora|por favor|pfv|me|valor|taxa)\b/i)[0].trim()
    if (!compact) continue
    if (isLikelyLocation(compact)) out.push(compact)
  }

  // Dedup by normalized form, preserve order.
  const seen = new Set<string>()
  return out.filter((item) => {
    const key = normalize(item)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type DeliveryFeeRow = {
  location: string
  locationNorm: string
  fee: string
}

function parseFeeRows(knowledge: string[]): DeliveryFeeRow[] {
  const rows: DeliveryFeeRow[] = []

  for (const excerpt of knowledge) {
    for (const line of excerpt.split(/\r?\n/)) {
      const feeMatch = line.match(MONEY_RE)
      if (!feeMatch || !feeMatch[0]) continue
      const fee = feeMatch[0].replace(/\s+/g, ' ').trim()

      const left = line.slice(0, feeMatch.index ?? 0).trim()
      if (!left) continue

      // Clean common table/list prefixes and delimiters.
      const location = left
        .replace(/^[-*|\d.()\s]+/, '')
        .replace(/\b(taxa\s*de\s*entrega|taxa|entrega)\b/gi, ' ')
        .replace(/[:|\-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()

      if (!location || !isLikelyLocation(location)) continue

      const locationNorm = normalize(location)
      if (!locationNorm) continue

      rows.push({ location, locationNorm, fee })
    }
  }

  return rows
}

function findFeeMatch(hints: string[], rows: DeliveryFeeRow[]): DeliveryFeeRow | null {
  if (hints.length === 0 || rows.length === 0) return null
  for (const hint of hints) {
    const hintNorm = normalize(hint)
    if (!hintNorm) continue

    // Prefer full-token containment, then fallback to substring match.
    const tokenRe = new RegExp(`\\b${hintNorm.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i')

    const tokenHit = rows.find((r) => tokenRe.test(r.locationNorm))
    if (tokenHit) return tokenHit

    const fuzzyHit = rows.find(
      (r) => r.locationNorm.includes(hintNorm) || hintNorm.includes(r.locationNorm),
    )
    if (fuzzyHit) return fuzzyHit
  }
  return null
}

export function isDeliveryTopic(query: string): boolean {
  return DELIVERY_TOPIC_RE.test(query)
}

/**
 * Delivery-specific guardrails appended to the system prompt only when
 * the current customer query is about delivery.
 */
export function buildDeliveryPolicySection(
  customerQuery: string,
  knowledge: string[] | undefined,
): string | null {
  const query = customerQuery.trim()
  if (!query || !isDeliveryTopic(query)) return null

  const hints = extractLocationHints(query)
  const rows = parseFeeRows(knowledge ?? [])
  const match = findFeeMatch(hints, rows)

  const lines: string[] = [
    'Delivery policy (must follow):',
    '- This question is about delivery. Consult the knowledge-base excerpts first.',
    '- Never invent delivery fees.',
    '- Never answer with a fee that is not present in the retrieved knowledge excerpts.',
  ]

  if (hints.length === 0) {
    lines.push(
      '- The customer did not provide a neighborhood/sector. Ask for the neighborhood or sector before giving any delivery fee.',
    )
  } else if (match) {
    lines.push(
      `- Matched location in knowledge: "${match.location}". Use exactly this delivery fee: ${match.fee}.`,
    )
  } else {
    lines.push(
      '- No matching neighborhood/sector was found in the retrieved knowledge excerpts.',
      '- Inform that delivery will be calculated at R$ 1,50 per km (round trip), according to company policy.',
    )
  }

  return lines.join('\n')
}
