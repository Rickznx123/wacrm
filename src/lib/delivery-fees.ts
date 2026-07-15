export const DELIVERY_FEES: Record<string, number> = {
  ARARAS: 5,
  'PARQUE DOS LAGOS': 6,
  'PARQUE DOS OITIS': 6,
  UNIVERSITÁRIO: 6,
  'JARDIM TROPICAL': 6,
  CENTRO: 8,
  'SETORES (B,C,D,E,F,G,H)': 8,
  'SETORES (FH,DF,BD,EG,GS)': 8,
  'SETOR J': 8,
  AMARILES: 8,
  'JARDIM DAS BEGONIAS': 8,
  'JARDIM DOS YPES': 8,
  'JARDIM DAS CAMÉLIAS': 8,
  'ROSA DOS VENTOS': 8,
  'TERMINAL RODOVIÁRIO': 8,
  'SETOR CRAVO': 8,
  'ALMEIDA PRADO': 8,
  'BOA NOVA 1/2/3': 8,
  'JARDIM POR DO SOL': 8,
  'JARDIM SANTA CECÍLIA': 8,
  'CHÁCARA ESTEIO (INTERNO)': 8,
  'AV. PERIMETRAL ROGÉRIO SILVA': 8,
  'BAIRROS DO BURITIS': 8,
  'EMPRESAS DE UM TREVO AO OUTRO': 8,
  'MIRANTE DOS LAGOS': 8,
  'MOTEL AQUARIOS': 8,
  'JARDIM OLIVEIRA': 8,
  'GREEN VILLE': 8,
  'HOTEL VITALITI': 8,
  PRIMAVERA: 8,
  RENASCER: 8,
  PANORAMA: 8,
  'VICINAL PRIMEIRA LESTE (PERIMETRO URBANO)': 8,
  'HOTEL MIRAGEM': 8,
  'HOTEL ESPLANADA': 8,
  'HOTEL ESTORIL': 8,
  'HOTEL MANDINO': 8,
  'HOTEL ITAMARATY': 8,
  'HOTEL AVENIDA': 8,
  'HOTEL LUZ DIVINA': 8,
  'HOTEL VENEZA': 8,
  'HOTEL MATO GROSSO': 8,
  'HOTEL LISBOA PALACE': 8,
  'HOTEL MINAS': 8,
  'HOTEL LONDRES': 8,
  'HOTEL CALECHE PARK': 8,
  'SETOR INDUSTRIAL / RI (H INDUSTRIAL)': 10,
  'JARDIM NOVO HORIZONTE': 10,
  'JARDIM PERIMETRAL': 10,
  'JARDIM SOL NASCENTE': 10,
  'IFMT CAMPUS ALF': 10,
  'AQUARELA HAMOA (BAIRRO ABERTO)': 10,
  'SETOR A': 10,
  'RECANTO DA AMAZÔNIA': 10,
  'BOATES CHALÉ E LUXURY': 10,
  'RESIDENCIAL DAS MAGUEIRAS': 10,
  'AEROPORTO OSVALDO MARQUES DIAS': 12,
  'HOTEL FLORESTA AMAZÔNICA': 12,
  'BOM JESUS': 12,
  'JARDIM SANTA MARIA': 12,
  'JARDIM VILA VERDE': 12,
  'NOVA FLORESTA': 12,
  'RECANTO DOS PÁSSAROS': 12,
  'RESIDENCIAL TELES PIRES': 12,
  'SÃO JOSÉ OPERÁRIO': 12,
  'JARDIM FLAMBOYANT': 12,
  'BOA VISTA': 12,
  'AVENIDA AMAZONAS': 15,
  'NORTE 2': 15,
  'NORTE 3': 15,
  'CIDADE BELA': 15,
  'JARDIM IMPERIAL': 15,
  'BOM PASTOR': 15,
  'JARDIM DAS FLORES': 15,
  'HAMOA (BAIRRO FECHADO)': 15,
  'J. PLANALTO': 15,
  'JARDIM EUROPA': 8,
  'JARDIM IPIRANGA': 8,
  'JARDIM ELDORADO': 8,
  'LATICINIO LACTIVITI': 15,
  'GRUPO BRASIL NORTE (GBN)': 15,
  'MOTEL OASIS': 15,
  'MOTEL MIRAGEM': 15,
  'GUARANÁ 1': 18,
  'GUARANÁ 2': 18,
  'BOA ESPERANÇA': 18,
  'PARQUE DAS NAÇÕES': 18,
  'BOM JARDIM': 18,
  'VILA NOVA': 18,
  'VILA RICA': 18,
  'VICINAL PRIMEIRA OESTE (PERIMETRO URBANO)': 18,
  'VICINAL PRIMEIRA NORTE (PERIMETRO URBANO)': 18,
  'FLORAIS DO VALE': 18,
  'JARDIM TANGARA': 18,
  'DISTRITO INDUSTRIAL MADEIREIRAS': 20,
  'TROPICAL PISOS': 20,
  'FRIGORIFICO JBS': 20,
  'ARMAZÉM MARIANA': 20,
  'VILA RURAL LINHAS 1 & 2': 25,
  'ESTR. GUERINO ANTÔNIO ZAURA': 25,
  'ESTR. SÃO JOÃO': 25,
  'ESTR. SÃO PEDRO': 25,
  'COMUNIDADE GETSEMANI': 25,
  'FRIGORIFICO ALVORADA': 25,
  'FRIGORIFICO FAZ CARNE': 25,
  'SECADOR TRÊS TENTOS': 25,
  'CHÁCARAS BOA VISTA': 25,
  'COMUNIDADE CENTRAL & ALTO ALEGRE': 25,
  'ESPAÇO GRÃOS': 35,
  'ARMAZÉM BERLANDA': 35,
  PEDÁGIO: 35,
  'SECADOR GS (APÓS O PEDÁGIO)': 50,
  'CARLINDA - MT': 100,
}

const LOCATION_MARKERS_RE =
  /\b(?:bairro|setor|setores|regiao|regiao de|regiao do|regiao da|na|no|em|para|pro|pra)\s+([\p{L}0-9][\p{L}0-9\s\-]{1,60})/giu

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function trimCandidate(value: string): string {
  return value
    .split(/\b(?:hoje|amanha|agora|por favor|pfv|valor|taxa|entrega|delivery|frete)\b/i)[0]
    .trim()
}

function cleanupNeighborhoodCandidate(value: string): string {
  return value
    .replace(/^["'`´\s]+|["'`´\s]+$/g, '')
    .replace(/^(?:o|a|os|as|um|uma)\s+/i, '')
    .replace(/^(?:bairro|setor|setores|regiao(?:\s+de|\s+do|\s+da)?)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isLikelyNeighborhood(value: string): boolean {
  const v = normalize(value)
  if (!v) return false
  if (v.length < 3) return false

  const blacklist = new Set([
    'entrega',
    'delivery',
    'frete',
    'taxa',
    'valor',
    'qual',
    'quanto',
    'moro',
    'preciso',
    'de',
    'do',
    'da',
    'no',
    'na',
    'em',
    'para',
    'pro',
    'pra',
    'o',
    'a',
  ])

  return !blacklist.has(v)
}

const NEIGHBORHOOD_INDEX = Object.keys(DELIVERY_FEES)
  .map((name) => ({
    canonical: name,
    normalized: normalize(name),
  }))
  .sort((a, b) => b.normalized.length - a.normalized.length)

function matchNeighborhood(candidate: string): string | null {
  const normalizedCandidate = normalize(candidate)
  if (!normalizedCandidate) return null

  const exact = NEIGHBORHOOD_INDEX.find((item) => item.normalized === normalizedCandidate)
  if (exact) return exact.canonical

  const partial = NEIGHBORHOOD_INDEX.find(
    (item) =>
      normalizedCandidate.includes(item.normalized) || item.normalized.includes(normalizedCandidate),
  )
  if (partial) return partial.canonical

  return null
}

export function extractNeighborhood(text: string): string | null {
  const query = text.trim()
  if (!query) return null

  for (const match of query.matchAll(LOCATION_MARKERS_RE)) {
    const raw = (match[1] ?? '').trim().replace(/[?!.;,]+$/g, '')
    if (!raw) continue
    const candidate = cleanupNeighborhoodCandidate(trimCandidate(raw))
    if (!candidate || !isLikelyNeighborhood(candidate)) continue
    const mapped = matchNeighborhood(candidate)
    if (mapped) return mapped

    return candidate.toLocaleUpperCase('pt-BR')
  }

  const normalizedQuery = normalize(query)
  const direct = NEIGHBORHOOD_INDEX.find((item) => normalizedQuery.includes(item.normalized))
  return direct?.canonical ?? null
}

export function getDeliveryFeeResponse(message: string): string | null {
  const neighborhood = extractNeighborhood(message)
  if (!neighborhood) return null

  const fee = DELIVERY_FEES[neighborhood]
  if (fee == null) return null

  const feeFormatted = fee.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

  return `A taxa de entrega para ${neighborhood} é R$ ${feeFormatted}.`
}