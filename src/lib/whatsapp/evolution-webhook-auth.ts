import crypto from 'node:crypto'

type EvolutionWebhookAuthHeaders = {
  signature: string | null
  secret: string | null
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

function normalizeHexSignature(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('sha256=')) {
    return trimmed.slice('sha256='.length).toLowerCase()
  }

  return trimmed.toLowerCase()
}

export function getRequiredEvolutionWebhookSecret(): string {
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET?.trim()
  if (!secret) {
    throw new Error(
      'EVOLUTION_WEBHOOK_SECRET is required for Evolution webhook authentication.',
    )
  }
  return secret
}

/**
 * Evolution v2 deployments vary: some send an HMAC signature header,
 * others can only send a shared secret header. We enforce auth and
 * accept either mechanism as long as it validates against the same
 * required secret.
 */
export function verifyEvolutionWebhookAuth(
  rawBody: string,
  headers: EvolutionWebhookAuthHeaders,
): boolean {
  const secret = getRequiredEvolutionWebhookSecret()

  const signature = normalizeHexSignature(headers.signature)
  if (signature) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    if (timingSafeEqualString(signature, expected)) return true
  }

  if (!headers.secret) return false
  return timingSafeEqualString(headers.secret, secret)
}
