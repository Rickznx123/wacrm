import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  getRequiredEvolutionWebhookSecret,
  verifyEvolutionWebhookAuth,
} from './evolution-webhook-auth'

describe('verifyEvolutionWebhookAuth', () => {
  const rawBody = JSON.stringify({ hello: 'world' })

  function sign(body: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex')
  }

  it('accepts a valid HMAC signature', () => {
    process.env.EVOLUTION_WEBHOOK_SECRET = 'test-secret'

    expect(
      verifyEvolutionWebhookAuth(rawBody, {
        signature: `sha256=${sign(rawBody, 'test-secret')}`,
        secret: null,
      }),
    ).toBe(true)
  })

  it('accepts a valid shared secret header fallback', () => {
    process.env.EVOLUTION_WEBHOOK_SECRET = 'test-secret'

    expect(
      verifyEvolutionWebhookAuth(rawBody, {
        signature: null,
        secret: 'test-secret',
      }),
    ).toBe(true)
  })

  it('rejects when authentication headers are invalid', () => {
    process.env.EVOLUTION_WEBHOOK_SECRET = 'test-secret'

    expect(
      verifyEvolutionWebhookAuth(rawBody, {
        signature: `sha256=${sign(rawBody, 'wrong-secret')}`,
        secret: 'wrong-secret',
      }),
    ).toBe(false)
  })
})

describe('getRequiredEvolutionWebhookSecret', () => {
  it('throws when EVOLUTION_WEBHOOK_SECRET is missing', () => {
    const original = process.env.EVOLUTION_WEBHOOK_SECRET

    delete process.env.EVOLUTION_WEBHOOK_SECRET
    expect(() => getRequiredEvolutionWebhookSecret()).toThrow(
      'EVOLUTION_WEBHOOK_SECRET is required for Evolution webhook authentication.',
    )

    if (original === undefined) {
      delete process.env.EVOLUTION_WEBHOOK_SECRET
    } else {
      process.env.EVOLUTION_WEBHOOK_SECRET = original
    }
  })
})
