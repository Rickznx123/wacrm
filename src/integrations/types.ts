export type WhatsAppProviderName = 'meta' | 'evolution'

export interface ChannelState {
  provider: WhatsAppProviderName
  status: 'creating' | 'qrcode' | 'connected' | 'disconnected' | 'error'
  instanceId?: string
  qrCode?: string | null
  phone?: string | null
  profileName?: string | null
  lastError?: string | null
}

export interface WhatsAppProvider {
  readonly name: WhatsAppProviderName
}

export interface EvolutionProvider extends WhatsAppProvider {
  createOrConnect(instanceId: string, webhookUrl: string): Promise<ChannelState>
  listContacts(instanceId: string): Promise<
    Array<{ phone: string; name: string | null; profilePicUrl?: string | null }>
  >
  readState(instanceId: string): Promise<ChannelState>
  disconnect(instanceId: string): Promise<void>
  sendText(instanceId: string, to: string, text: string): Promise<{ messageId: string }>
  sendMedia(
    instanceId: string,
    args: {
      to: string
      kind: 'image' | 'video' | 'document' | 'audio'
      link: string
      caption?: string
      filename?: string
    },
  ): Promise<{ messageId: string }>
  getMediaBase64(
    instanceId: string,
    args: {
      messageId: string
      convertToMp4?: boolean
      timeoutMs?: number
    },
  ): Promise<{
    mediaType: string | null
    fileName: string | null
    mimetype: string | null
    base64: string
    size: {
      fileLength: unknown
      height: number | null
      width: number | null
    } | null
  }>
}
