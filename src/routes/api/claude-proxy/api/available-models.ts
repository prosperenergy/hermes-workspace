import { createFileRoute } from '@tanstack/react-router'

import { isAuthenticated } from '../../../../server/auth-middleware'

const CPAMC_BASE_URL =
  process.env.CPAMC_BASE_URL?.trim() ||
  process.env.CLI_PROXY_API_BASE_URL?.trim() ||
  'http://127.0.0.1:8317/v1'
const CPAMC_API_KEY = process.env.CPAMC_API_KEY?.trim() || 'prosper-sam-2026'

function providerMatches(provider: string, modelId: string): boolean {
  const wanted = provider.toLowerCase()
  if (!wanted) return true
  if (wanted === 'openai') return modelId.startsWith('gpt-') || modelId.includes('codex')
  if (wanted === 'anthropic') return modelId.includes('claude-')
  if (wanted === 'xai') return modelId.startsWith('grok-')
  if (wanted === 'gemini') return modelId.startsWith('gemini-') || modelId.startsWith('gemini-api-')
  if (wanted === 'vertex') return modelId.startsWith('vertex/')
  if (wanted === 'nvidia') {
    return modelId.startsWith('llama-') || modelId.startsWith('nemotron-') || modelId.startsWith('nvidia/')
  }
  if (wanted === 'kimi') return modelId.startsWith('kimi-web-')
  return modelId.includes(`${wanted}/`) || modelId.startsWith(`${wanted}-`)
}

function readModelIds(payload: unknown): Array<string> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const record = payload as Record<string, unknown>
  const raw = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  return raw.flatMap((entry) => {
    if (typeof entry === 'string') return [entry.trim()].filter(Boolean)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const id = (entry as Record<string, unknown>).id
    return typeof id === 'string' && id.trim() ? [id.trim()] : []
  })
}

async function availableModels(request: Request): Promise<Response> {
  if (!isAuthenticated(request)) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const provider = new URL(request.url).searchParams.get('provider') || ''
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (CPAMC_API_KEY) headers.Authorization = `Bearer ${CPAMC_API_KEY}`
    const response = await fetch(`${CPAMC_BASE_URL.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return Response.json({ models: [] })
    const ids = readModelIds(await response.json()).filter((id) =>
      providerMatches(provider, id),
    )
    return Response.json({ models: ids.map((id) => ({ id })) })
  } catch {
    return Response.json({ models: [] })
  }
}

export const Route = createFileRoute('/api/claude-proxy/api/available-models')({
  server: {
    handlers: {
      GET: async ({ request }) => availableModels(request),
    },
  },
})
