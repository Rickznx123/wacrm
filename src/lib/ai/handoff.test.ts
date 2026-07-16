import { describe, it, expect } from 'vitest'
import { buildHandoffSummary } from './handoff'

describe('buildHandoffSummary', () => {
  it('builds a structured handoff summary for a checkout conversation', () => {
    const summary = buildHandoffSummary({
      messages: [
        {
          role: 'user',
          content:
            'Quero 2x Aptamil 1 800g e 1x Mamadeira Lillo 240ml. Entregar hoje, pagamento via PIX.',
        },
        {
          role: 'assistant',
          content: 'Perfeito! Para fechar o pedido, me passe nome, endereço, referência e telefone.',
        },
        {
          role: 'user',
          content: 'Rickelmi\nRua A19\nBairro Jardim Europa\nCasa de esquina\n66992402445',
        },
      ],
      replyCount: 2,
      contactPhone: '+55 66 99999-8888',
    })

    expect(summary).toContain('🛒 NOVO PEDIDO')
    expect(summary).toContain('👤 Cliente:')
    expect(summary).toContain('- Rickelmi')
    expect(summary).toContain('📞 Telefone:')
    expect(summary).toContain('- 66992402445')
    expect(summary).toContain('📍 Entrega:')
    expect(summary).toContain('Rua A19')
    expect(summary).toContain('Bairro: JARDIM EUROPA')
    expect(summary).toContain('Referência: Casa de esquina')
    expect(summary).toContain('🚚 Taxa de entrega:')
    expect(summary).toContain('R$ 8,00')
    expect(summary).toContain('🛍 Produtos solicitados:')
    expect(summary).toContain('• 2x Aptamil 1 800g')
    expect(summary).toContain('• 1x Mamadeira Lillo 240ml')
    expect(summary).toContain('💬 Observações:')
    expect(summary).toContain('pagamento via PIX')
  })

  it('uses contact phone fallback when the customer did not type a phone', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'Nome: Joana\nEndereço: Rua Central, 25' }],
      replyCount: 1,
      contactPhone: '+55 66 91234-5678',
    })
    expect(summary).toContain('+55 66 91234-5678')
  })

  it('marks missing fields when data is unavailable', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'Olá!' }],
      replyCount: 0,
    })
    expect(summary).toContain('Não informado')
    expect(summary).toContain('Não identific')
  })
})
