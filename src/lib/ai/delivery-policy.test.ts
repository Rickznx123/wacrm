import { describe, expect, it } from 'vitest'
import {
  buildDeliveryPolicySection,
  isDeliveryTopic,
} from './delivery-policy'

const TABLE_EXCERPT = `
Tabela de Taxas de Entrega
Bairro Centro - R$ 8,00
Setor Bueno - R$ 12,50
`

describe('delivery policy guardrails', () => {
  it('detects delivery topic queries', () => {
    expect(isDeliveryTopic('qual a taxa de entrega no centro?')).toBe(true)
    expect(isDeliveryTopic('quero saber o frete para o setor bueno')).toBe(true)
    expect(isDeliveryTopic('qual o horario de funcionamento?')).toBe(false)
  })

  it('uses the exact fee from knowledge for an existing neighborhood', () => {
    const section = buildDeliveryPolicySection(
      'Qual a taxa de entrega no bairro Centro?',
      [TABLE_EXCERPT],
    )

    expect(section).toContain('Matched location in knowledge')
    expect(section).toContain('R$ 8,00')
    expect(section).toContain('Never invent delivery fees')
  })

  it('uses the exact fee from knowledge for an existing sector', () => {
    const section = buildDeliveryPolicySection(
      'Quanto fica a entrega para o setor Bueno?',
      [TABLE_EXCERPT],
    )

    expect(section).toContain('Matched location in knowledge')
    expect(section).toContain('R$ 12,50')
  })

  it('falls back to km policy when neighborhood is not found', () => {
    const section = buildDeliveryPolicySection(
      'Qual a taxa de entrega no bairro Jardim Atlântico?',
      [TABLE_EXCERPT],
    )

    expect(section).toContain('No matching neighborhood/sector was found')
    expect(section).toContain('R$ 1,50 per km (round trip)')
  })

  it('asks for neighborhood/sector when customer asks delivery fee without location', () => {
    const section = buildDeliveryPolicySection(
      'Qual a taxa de entrega?',
      [TABLE_EXCERPT],
    )

    expect(section).toContain('Ask for the neighborhood or sector before giving any delivery fee')
  })
})
