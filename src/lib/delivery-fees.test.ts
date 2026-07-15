import { describe, expect, it } from 'vitest'
import { extractNeighborhood, getDeliveryFeeResponse } from './delivery-fees'

describe('delivery fee neighborhood extraction', () => {
  it('extracts neighborhood from full delivery phrases', () => {
    expect(extractNeighborhood('qual o valor da taxa para o jardim europa?')).toBe('JARDIM EUROPA')
    expect(extractNeighborhood('entrega no jardim europa')).toBe('JARDIM EUROPA')
    expect(extractNeighborhood('moro no jardim europa')).toBe('JARDIM EUROPA')
    expect(extractNeighborhood('preciso de entrega no jardim europa')).toBe('JARDIM EUROPA')
  })

  it('returns local fee response when neighborhood exists in table', () => {
    expect(getDeliveryFeeResponse('qual o valor da taxa para o centro?')).toBe(
      'A taxa de entrega para CENTRO é R$ 8,00.',
    )
  })

  it('returns local fee response for jardim europa', () => {
    expect(getDeliveryFeeResponse('qual o valor da taxa para o jardim europa?')).toBe(
      'A taxa de entrega para JARDIM EUROPA é R$ 8,00.',
    )
  })
})
