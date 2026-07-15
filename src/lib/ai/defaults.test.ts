import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt delivery integration', () => {
  it('injects delivery guardrails for delivery queries', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge: ['Bairro Centro - R$ 8,00'],
      customerQuery: 'Qual a taxa de entrega no bairro Centro?',
    })

    expect(prompt).toContain('Delivery policy (must follow):')
    expect(prompt).toContain('Matched location in knowledge')
    expect(prompt).toContain('R$ 8,00')
  })

  it('does not inject delivery guardrails for non-delivery queries', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Be concise.',
      mode: 'draft',
      knowledge: ['Catalog policy'],
      customerQuery: 'Vocês vendem pizza grande?',
    })

    expect(prompt).not.toContain('Delivery policy (must follow):')
    expect(prompt).toContain('Be concise.')
  })
})
