import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  ensureGatewayProbed,
  getGatewayCapabilities,
} from '../../server/claude-api'
import { BEARER_TOKEN, CLAUDE_API } from '../../server/gateway-capabilities'
import {
  ensureDiscovery,
  ensureProviderInConfig,
  getDiscoveredModels,
} from '../../server/local-provider-discovery'

const CLAUDE_HOME = process.env.HERMES_HOME ?? process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.hermes')
const MODELS_PATH = path.join(CLAUDE_HOME, 'models.json')
const CONFIG_PATH = path.join(CLAUDE_HOME, 'config.yaml')
const MODELS_CACHE_TTL_MS = 30_000
const CPAMC_BASE_URL =
  process.env.CPAMC_BASE_URL?.trim() ||
  process.env.CLI_PROXY_API_BASE_URL?.trim() ||
  'http://127.0.0.1:8317/v1'
const CPAMC_API_KEY =
  process.env.CPAMC_API_KEY?.trim() || 'prosper-sam-2026'

type ModelEntry = {
  provider?: string
  id?: string
  name?: string
  [key: string]: unknown
}

const UNSUPPORTED_CPAMC_MODEL_IDS = new Set([
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image-preview',
  'imagen-3.0-fast-generate-001',
  'imagen-3.0-generate-002',
  'imagen-4.0-fast-generate-001',
  'imagen-4.0-generate-001',
  'imagen-4.0-ultra-generate-001',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'qwen/qwen3-coder-480b-a35b-instruct',
  'vertex/gemini-3-pro-image-preview',
  'vertex/gemini-3.1-flash-image-preview',
  'vertex/imagen-3.0-fast-generate-001',
  'vertex/imagen-3.0-generate-002',
  'vertex/imagen-4.0-fast-generate-001',
  'vertex/imagen-4.0-generate-001',
  'vertex/imagen-4.0-ultra-generate-001',
])

let modelsResponseCache:
  | {
      expiresAt: number
      payload: Record<string, unknown>
    }
  | null = null

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
  return {}
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function shouldBypassModelsCache(request: Request): boolean {
  try {
    const url = new URL(request.url)
    return (
      url.searchParams.get('refresh') === '1' ||
      url.searchParams.get('cache') === '0'
    )
  } catch {
    return false
  }
}

function normalizeModel(entry: unknown): ModelEntry | null {
  if (typeof entry === 'string') {
    const id = entry.trim()
    if (!id) return null
    return {
      id,
      name: id,
      provider: id.includes('/') ? id.split('/')[0] : 'unknown',
    }
  }
  const record = asRecord(entry)
  const id =
    readString(record.id) || readString(record.name) || readString(record.model)
  if (!id) return null
  return {
    ...record,
    id,
    name:
      readString(record.name) ||
      readString(record.display_name) ||
      readString(record.label) ||
      id,
    provider:
      readString(record.provider) ||
      readString(record.owned_by) ||
      (id.includes('/') ? id.split('/')[0] : 'unknown'),
  }
}

export function mergeModelEntries(...sources: Array<Array<ModelEntry>>): Array<ModelEntry> {
  const merged: Array<ModelEntry> = []
  const seen = new Set<string>()

  for (const source of sources) {
    for (const model of source) {
      const normalized = normalizeModel(model)
      if (!normalized || seen.has(normalized.id)) continue
      merged.push(normalized)
      seen.add(normalized.id)
    }
  }

  return merged
}

/**
 * Read user-configured models from active profile's models.json.
 */
function readClaudeModelsJson(): Array<ModelEntry> {
  try {
    if (!fs.existsSync(MODELS_PATH)) return []
    const raw = fs.readFileSync(MODELS_PATH, 'utf-8')
    const entries = JSON.parse(raw)
    if (!Array.isArray(entries)) return []
    return entries
      .map((entry: unknown): ModelEntry | null => {
        const record = asRecord(entry)
        // models.json uses "model" field for the model ID
        const modelId = readString(record.model) || readString(record.id)
        if (!modelId) return null
        return {
          id: modelId,
          name: readString(record.name) || modelId,
          provider: readString(record.provider) || 'unknown',
        }
      })
      .filter((entry): entry is ModelEntry => entry !== null)
  } catch {
    return []
  }
}

const DEFAULT_ACCEPTED_TIMEOUT_S = 120
const DEFAULT_HANDOFF_TIMEOUT_S = 300

function readStreamTimeouts(): { streamAcceptedTimeoutMs: number; streamHandoffTimeoutMs: number } {
  let acceptedS = DEFAULT_ACCEPTED_TIMEOUT_S
  let handoffS = DEFAULT_HANDOFF_TIMEOUT_S
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      const ws =
        parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).workspace === 'object'
          ? ((parsed as Record<string, unknown>).workspace as Record<string, unknown>)
          : {}
      if (typeof ws.stream_accepted_timeout === 'number' && ws.stream_accepted_timeout > 0)
        acceptedS = ws.stream_accepted_timeout
      if (typeof ws.stream_handoff_timeout === 'number' && ws.stream_handoff_timeout > 0)
        handoffS = ws.stream_handoff_timeout
    }
  } catch {
    // fall through to defaults
  }
  const envAccepted = parseInt(process.env.STREAM_ACCEPTED_TIMEOUT_MS ?? '', 10)
  const envHandoff = parseInt(process.env.STREAM_HANDOFF_TIMEOUT_MS ?? '', 10)
  return {
    streamAcceptedTimeoutMs: Number.isFinite(envAccepted) && envAccepted > 0 ? envAccepted : acceptedS * 1000,
    streamHandoffTimeoutMs: Number.isFinite(envHandoff) && envHandoff > 0 ? envHandoff : handoffS * 1000,
  }
}

/**
 * Read the default model from active profile's config.yaml using a proper YAML parser.
 */
function readClaudeDefaultModel(): ModelEntry | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = YAML.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const config = parsed as Record<string, unknown>
    let modelId = ''
    let provider = ''
    const modelField = config.model
    if (typeof modelField === 'string') {
      modelId = modelField
      provider = (config.provider as string) || 'unknown'
    } else if (modelField && typeof modelField === 'object') {
      const modelObj = modelField as Record<string, unknown>
      modelId = (modelObj.default as string) || ''
      provider =
        (modelObj.provider as string) ||
        (config.provider as string) ||
        'unknown'
    }
    if (!modelId) return null
    return { id: modelId, name: modelId, provider }
  } catch {
    return null
  }
}

/**
 * Fallback: fetch models from the hermes-agent /v1/models endpoint.
 */
async function fetchClaudeModels(): Promise<Array<ModelEntry>> {
  const headers: Record<string, string> = {}
  if (BEARER_TOKEN) headers['Authorization'] = `Bearer ${BEARER_TOKEN}`
  const response = await fetch(`${CLAUDE_API}/v1/models`, { headers })
  if (!response.ok)
    throw new Error(`Hermes models request failed (${response.status})`)
  const payload = asRecord(await response.json())
  const rawModels = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : []
  return rawModels
    .map(normalizeModel)
    .filter((e): e is ModelEntry => e !== null)
}

async function fetchCpamcModels(): Promise<Array<ModelEntry>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (CPAMC_API_KEY) headers.Authorization = `Bearer ${CPAMC_API_KEY}`
  const response = await fetch(`${CPAMC_BASE_URL.replace(/\/+$/, '')}/models`, {
    headers,
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok)
    throw new Error(`CPAMC models request failed (${response.status})`)
  const payload = asRecord(await response.json())
  const rawModels = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : []
  return rawModels
    .map(normalizeModel)
    .filter((entry): entry is ModelEntry => entry !== null)
}

export const Route = createFileRoute('/api/models')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const bypassCache = shouldBypassModelsCache(request)
        if (
          !bypassCache &&
          modelsResponseCache &&
          Date.now() < modelsResponseCache.expiresAt
        ) {
          return json({
            ...modelsResponseCache.payload,
            cached: true,
            cacheTtlMs: MODELS_CACHE_TTL_MS,
          })
        }

        await ensureGatewayProbed()

        try {
          // Primary: read user-configured models from ~/.hermes/models.json
          let models = readClaudeModelsJson()
          let source = 'models.json'

          // Ensure the default model from config.yaml is always first
          const defaultModel = readClaudeDefaultModel()
          if (defaultModel) {
            models = models.filter((m) => m.id !== defaultModel.id)
            models.unshift(defaultModel)
          }

          // Merge the authoritative Hermes model catalog whenever it is
          // available. Previously, a non-empty models.json stopped here, so the
          // Operations picker only showed the local Workspace subset and drifted
          // from the CLI/backend model universe.
          if (getGatewayCapabilities().models) {
            try {
              const hermesModels = await fetchClaudeModels()
              models = mergeModelEntries(models, hermesModels)
              source =
                source === 'models.json'
                  ? 'models.json+hermes-agent'
                  : 'hermes-agent'
            } catch {
              // Hermes Agent can be gated after a desktop reboot or token expiry.
              // Keep the CPAMC and local model catalog available.
            }
          }

          try {
            const cpamcModels = await fetchCpamcModels()
            if (cpamcModels.length > 0) {
              models = mergeModelEntries(models, cpamcModels)
              source = `${source}+cpamc`
            }
          } catch {
            // Keep profile/local models visible if CPAMC is temporarily down.
          }

          // Merge auto-discovered local models (Ollama, Atomic Chat, etc.)
          await ensureDiscovery()
          const localModels = getDiscoveredModels()
          models = mergeModelEntries(models, localModels)
          for (const m of localModels) {
            ensureProviderInConfig(m.provider)
          }

          const configuredProviders = Array.from(
            new Set(
              models
                .map((model) =>
                  typeof model.provider === 'string' ? model.provider : '',
                )
                .filter(Boolean),
            ),
          )

          const streamTimeouts = readStreamTimeouts()
          const unsupportedModels = models.filter((model) =>
            UNSUPPORTED_CPAMC_MODEL_IDS.has(readString(model.id)),
          )
          models = models.filter(
            (model) => !UNSUPPORTED_CPAMC_MODEL_IDS.has(readString(model.id)),
          )

          const payload = {
            ok: true,
            object: 'list',
            data: models,
            models,
            unsupportedModels,
            configuredProviders,
            source,
            ...streamTimeouts,
          }
          modelsResponseCache = {
            expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
            payload,
          }

          return json({
            ...payload,
            cached: false,
            cacheTtlMs: MODELS_CACHE_TTL_MS,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 503 },
          )
        }
      },
    },
  },
})
