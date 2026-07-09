import { evolutionProvider } from './evolution/client'
import { metaProvider } from './meta/provider'
import type { EvolutionProvider, WhatsAppProviderName } from './types'

export function resolveWhatsAppProvider(name: WhatsAppProviderName) {
  if (name === 'evolution') return evolutionProvider
  return metaProvider
}

export function resolveEvolutionProvider(): EvolutionProvider {
  return evolutionProvider
}
