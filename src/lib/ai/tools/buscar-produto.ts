export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const PONTE_URL = process.env.PONTE_URL
const PONTE_API_KEY = process.env.PONTE_API_KEY

export const buscarProdutoTool: ToolDefinition = {
  name: 'buscar_produto',
  description:
    'Busca produtos, preços e estoque em tempo real na farmácia. Use sempre que o cliente perguntar se um produto ou medicamento está disponível, qual o preço ou informações de estoque.',
  parameters: {
    type: 'object',
    properties: {
      nome: {
        type: 'string',
        description: "Nome ou parte do nome do produto buscado, ex: 'dipirona'",
      },
    },
    required: ['nome'],
  },
}

export function pharmacyToolsAvailable(): boolean {
  console.log('[TOOLS] PONTE_URL =', PONTE_URL)
  console.log('[TOOLS] PONTE_API_KEY existe =', !!PONTE_API_KEY)

  return Boolean(PONTE_URL && PONTE_API_KEY)
}

export async function executePharmacyTool(
  name: string,
  argsJson: string,
): Promise<unknown> {
  console.log('[TOOLS] Chamando ferramenta:', name)
  console.log('[TOOLS] Argumentos:', argsJson)

  if (name !== 'buscar_produto') {
    throw new Error(`unknown tool: ${name}`)
  }

  const { nome } = JSON.parse(argsJson) as { nome: string }

  const url = `${PONTE_URL}/produtos/buscar?nome=${encodeURIComponent(nome)}`
  console.log('[TOOLS] URL:', url)

  const res = await fetch(url, {
    headers: {
      'x-api-key': PONTE_API_KEY as string,
    },
    signal: AbortSignal.timeout(8000),
  })

  console.log('[TOOLS] Status:', res.status)

  if (!res.ok) {
    return { erro: `ponte respondeu ${res.status}` }
  }

  const data = await res.json()

  console.log('[TOOLS] Resposta:', JSON.stringify(data))

  return data
}