import { describe, expect, it } from 'vitest'
import { shouldHandoffMedicationRecommendation } from './medication-guardrail'

describe('shouldHandoffMedicationRecommendation', () => {
  it('returns true for symptom/recommendation intents without specific medicine names', () => {
    expect(shouldHandoffMedicationRecommendation('Estou com dor de cabeça')).toBe(true)
    expect(shouldHandoffMedicationRecommendation('Estou com febre')).toBe(true)
    expect(shouldHandoffMedicationRecommendation('O que posso tomar para gripe?')).toBe(true)
    expect(shouldHandoffMedicationRecommendation('Pode indicar um remédio?')).toBe(true)
    expect(shouldHandoffMedicationRecommendation('Meu filho está tossindo')).toBe(true)
    expect(shouldHandoffMedicationRecommendation('O que é bom para alergia?')).toBe(true)
    expect(shouldHandoffMedicationRecommendation('Qual remédio vocês indicam?')).toBe(true)
    expect(shouldHandoffMedicationRecommendation('O que posso tomar para dor nas costas?')).toBe(true)
  })

  it('returns false for specific medicine product-intent messages', () => {
    expect(shouldHandoffMedicationRecommendation('Tem Dipirona?')).toBe(false)
    expect(shouldHandoffMedicationRecommendation('Quero Dipirona.')).toBe(false)
    expect(shouldHandoffMedicationRecommendation('Quanto custa Dipirona?')).toBe(false)
    expect(shouldHandoffMedicationRecommendation('Tem Paracetamol?')).toBe(false)
    expect(shouldHandoffMedicationRecommendation('Quero comprar Dorflex.')).toBe(false)
    expect(shouldHandoffMedicationRecommendation('Tem Nimesulida?')).toBe(false)
    expect(shouldHandoffMedicationRecommendation('Qual o preço do Ibuprofeno?')).toBe(false)
    expect(
      shouldHandoffMedicationRecommendation('Minha mãe está com dor de cabeça, vocês têm Dipirona?'),
    ).toBe(false)
    expect(shouldHandoffMedicationRecommendation('Estou gripado e quero Benegrip.')).toBe(false)
    expect(shouldHandoffMedicationRecommendation('Estou com febre, vocês têm Paracetamol?')).toBe(false)
  })
})
