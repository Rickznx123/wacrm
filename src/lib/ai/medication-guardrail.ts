const RECOMMENDATION_PATTERNS: RegExp[] = [
  /\bo\s+que\s+(?:posso\s+)?tomar\b/,
  /\bo\s+que\s+e\s+bom\s+para\b/,
  /\bpode\s+me\s+indicar\b/,
  /\bpode\s+indicar\b/,
  /\bqual\s+remedio\b/,
  /\bqual\s+medicamento\b/,
  /\bremedio\s+para\b/,
  /\bmedicamento\s+para\b/,
  /\bremedio\s+voces\s+indicam\b/,
]

const SYMPTOM_PATTERNS: RegExp[] = [
  /\bdor\s+de\s+cabeca\b/,
  /\bfebre\b/,
  /\bgripe\b/,
  /\bdor\s+de\s+garganta\b/,
  /\btoss(?:e|indo|ir|indo)\b/,
  /\benjoad[oa]\b/,
  /\bdor\s+nas\s+costas\b/,
  /\balergia\b/,
  /\bsinusite\b/,
  /\bdiarreia\b/,
]

const HEALTH_CONTEXT_PATTERNS: RegExp[] = [
  /\bestou\s+com\b/,
  /\bto\s+com\b/,
  /\btenho\b/,
  /\bmeu\s+filho\s+esta\b/,
  /\bmeu\s+filho\s+ta\b/,
]

const DIRECT_PRODUCT_QUERY_PATTERNS: RegExp[] = [
  /\btem\s+[a-z0-9][a-z0-9\s-]{2,}\?*$/,
  /\bvoces\s+tem\s+[a-z0-9][a-z0-9\s-]{2,}\?*$/,
  /\bqual\s+o\s+preco\s+de\s+[a-z0-9][a-z0-9\s-]{2,}\?*$/,
  /\bqual\s+o\s+valor\s+do?\s+[a-z0-9][a-z0-9\s-]{2,}\?*$/,
  /\bquanto\s+custa\s+[a-z0-9][a-z0-9\s-]{2,}\?*$/,
  /\bquero\s+[a-z0-9][a-z0-9\s-]{2,}\.?$/,
  /\bquero\s+comprar\s+[a-z0-9][a-z0-9\s-]{2,}\.?$/,
]

const SPECIFIC_MEDICATION_PATTERNS: RegExp[] = [
  /\bdipirona\b/,
  /\bparacetamol\b/,
  /\bdorflex\b/,
  /\bnimesulida\b/,
  /\bibuprofeno\b/,
  /\bbenegrip\b/,
  /\btorsilax\b/,
]

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

export function shouldHandoffMedicationRecommendation(query: string): boolean {
  const normalized = normalize(query)
  if (!normalized) return false

  if (matchesAny(normalized, SPECIFIC_MEDICATION_PATTERNS)) {
    return false
  }

  if (matchesAny(normalized, DIRECT_PRODUCT_QUERY_PATTERNS)) {
    return false
  }

  if (matchesAny(normalized, RECOMMENDATION_PATTERNS)) {
    return true
  }

  const hasSymptom = matchesAny(normalized, SYMPTOM_PATTERNS)
  const hasHealthContext = matchesAny(normalized, HEALTH_CONTEXT_PATTERNS)

  if (hasSymptom && hasHealthContext) {
    return true
  }

  return false
}
