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
    'Busca produtos, preços e estoque em tempo real na farmácia. Use sempre que o cliente perguntar se um produto/medicamento está disponível ou qual o preço.',
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
  return Boolean(PONTE_URL && PONTE_API_KEY)
}

export async function executePharmacyTool(
  name: string,
  argsJson: string,
): Promise<unknown> {
  if (name !== 'buscar_produto') {
    throw new Error(`unknown tool: ${name}`)
  }
  const { nome } = JSON.parse(argsJson) as { nome: string }
  const res = await fetch(
    `${PONTE_URL}/produtos/buscar?nome=${encodeURIComponent(nome)}`,
    {
      headers: { 'x-api-key': PONTE_API_KEY as string },
      signal: AbortSignal.timeout(8000),
    },
  )
  if (!res.ok) {
    return { erro: `ponte respondeu ${res.status}` }
  }
  return res.json()
}