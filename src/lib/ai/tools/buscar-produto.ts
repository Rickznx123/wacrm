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
    'Busca produtos, preços e estoque em tempo real na farmácia. Use sempre que o cliente perguntar sobre disponibilidade, preço ou estoque.',
  parameters: {
    type: 'object',
    properties: {
      nome: {
        type: 'string',
        description:
          "Nome ou parte do nome do produto buscado, ex: 'dipirona'",
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

  async function consultar(busca: string) {
    const url = `${PONTE_URL}/produtos/buscar?nome=${encodeURIComponent(busca)}`

    console.log('[TOOLS] Consultando:', busca)

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

    return res.json()
  }

  // Primeira tentativa: busca exatamente o que a IA pediu
  let data = await consultar(nome)

  // Se não encontrou nada, faz uma segunda busca simplificada
  if (
    typeof data === 'object' &&
    data &&
    'total' in data &&
    Number((data as any).total) === 0
  ) {
    const buscaSimplificada = nome
      .replace(/\b\d+\s*(mg|ml|g)\b/gi, '')
      .replace(
        /\b(comprimido|comprimidos|capsula|cápsula|capsulas|cápsulas|gotas|xarope)\b/gi,
        '',
      )
      .trim()

    if (buscaSimplificada && buscaSimplificada !== nome) {
      console.log('[TOOLS] Tentando novamente com:', buscaSimplificada)
      data = await consultar(buscaSimplificada)
    }
  }

  console.log('[TOOLS] Resposta final:', JSON.stringify(data))

  return data
}