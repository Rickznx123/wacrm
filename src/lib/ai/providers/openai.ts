import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import type { ToolDefinition } from '../tools/buscar-produto'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface OpenAiResponse {
  choices?: {
    message?: {
      content?: string | null
      tool_calls?: OpenAiToolCall[]
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export interface OpenAiCallArgs extends ProviderArgs {
  tools?: ToolDefinition[]
  toolExecutor?: (name: string, argsJson: string) => Promise<unknown>
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * When `tools` + `toolExecutor` are provided and the model asks to call
 * one, executes it and makes a second call with the result before
 * returning — callers only ever see the final text.
 */
export async function generateOpenAi(args: OpenAiCallArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, toolExecutor } = args

  const baseMessages: Record<string, unknown>[] = [
    { role: 'system', content: systemPrompt },
    ...mergeConsecutive(messages),
  ]

  const first = await callOpenAi({ apiKey, model, timeoutMs, messages: baseMessages, tools })
  const firstMsg = first.choices?.[0]?.message

  if (firstMsg?.tool_calls?.length && toolExecutor) {
    const followUp = [...baseMessages, {
      role: 'assistant',
      content: firstMsg.content ?? null,
      tool_calls: firstMsg.tool_calls,
    }]

    for (const call of firstMsg.tool_calls) {
      let result: unknown
      try {
        result = await toolExecutor(call.function.name, call.function.arguments)
      } catch (err) {
        result = { erro: err instanceof Error ? err.message : 'tool execution failed' }
      }
      followUp.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      })
    }

    const second = await callOpenAi({ apiKey, model, timeoutMs, messages: followUp, tools })
    return finalizeResult(second, {
      prompt: (first.usage?.prompt_tokens ?? 0) + (second.usage?.prompt_tokens ?? 0),
      completion: (first.usage?.completion_tokens ?? 0) + (second.usage?.completion_tokens ?? 0),
      total: (first.usage?.total_tokens ?? 0) + (second.usage?.total_tokens ?? 0),
    })
  }

  return finalizeResult(first)
}

async function callOpenAi(opts: {
  apiKey: string
  model: string
  timeoutMs: number
  messages: Record<string, unknown>[]
  tools?: ToolDefinition[]
}): Promise<OpenAiResponse> {
  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        ...(opts.tools?.length
          ? {
              tools: opts.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }
  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  if (!data) {
    throw new AiError('OpenAI returned an unparseable response.', { code: 'empty_response' })
  }
  return data
}

function finalizeResult(
  data: OpenAiResponse,
  usageOverride?: { prompt: number; completion: number; total: number },
): ProviderResult {
  const text = data.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', { code: 'empty_response' })
  }
  const usage = normalizeUsage(
    usageOverride ?? {
      prompt: data.usage?.prompt_tokens,
      completion: data.usage?.completion_tokens,
      total: data.usage?.total_tokens,
    },
  )
  return { text, usage }
}