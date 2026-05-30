import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'

import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'

import { isAuthenticated } from './auth-middleware'
import {
  ensureGatewayProbed,
  getCapabilities,
} from './gateway-capabilities'
import { normalizeHermesConfigState } from './hermes-config-migration'
import {
  applyHermesConfigPatch,
  parseEnvFile,
  readHermesConfigFiles,
  resolveHermesConfigPaths,
  stringifyEnv,
} from './hermes-config-store'
import {
  ensureDiscovery,
  getDiscoveredModels,
  getDiscoveryStatus,
} from './local-provider-discovery'

type AuthResult = Response | true

const ACTION_MESSAGES: Record<string, string> = {
  'set-default-model': 'Default model updated.',
  'set-api-key': 'API key saved.',
  'remove-api-key': 'API key removed.',
  'set-custom-provider': 'Custom provider saved.',
  'remove-custom-provider': 'Custom provider removed.',
}

const LEGACY_SAVE_MESSAGE = 'Saved.'

const PatchActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set-default-model'),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  }),
  z.object({
    action: z.literal('set-api-key'),
    envKey: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    action: z.literal('remove-api-key'),
    envKey: z.string().min(1),
  }),
  z.object({
    action: z.literal('set-custom-provider'),
    provider: z.object({
      name: z.string().min(1),
      baseUrl: z.string().min(1),
      apiKeyEnv: z.string().optional(),
      apiMode: z.string().optional(),
    }),
  }),
  z.object({
    action: z.literal('remove-custom-provider'),
    name: z.string().min(1),
  }),
])

const LegacyPatchSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
})

async function authorize(request: Request): Promise<AuthResult> {
  const result = isAuthenticated(request) as AuthResult
  if (result !== true) return result
  await ensureGatewayProbed()
  return true
}

function unavailablePayload(extra: Record<string, unknown> = {}): Response {
  return Response.json({
    ...createCapabilityUnavailablePayload('config'),
    config: {},
    providers: [],
    customProviders: [],
    activeProvider: '',
    activeModel: '',
    ...extra,
  })
}

type ProsperManagedProvider = {
  id: string
  name: string
  envKey: string
  marker: string
  match: (modelId: string) => boolean
}

const CPAMC_BASE_URL =
  process.env.CPAMC_BASE_URL?.trim() ||
  process.env.CLI_PROXY_API_BASE_URL?.trim() ||
  'http://127.0.0.1:8317/v1'
const CPAMC_API_KEY = process.env.CPAMC_API_KEY?.trim() || 'prosper-sam-2026'

const PROSPER_MANAGED_PROVIDERS: Array<ProsperManagedProvider> = [
  {
    id: 'anthropic',
    name: 'Anthropic / Claude Max',
    envKey: 'CPAMC_CLAUDE_OAUTH',
    marker: 'CPAMC OAuth',
    match: (modelId) => modelId.includes('claude-'),
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex / ChatGPT',
    envKey: 'CPAMC_CODEX_OAUTH',
    marker: 'CPAMC OAuth',
    match: (modelId) => modelId.startsWith('gpt-') || modelId.includes('codex'),
  },
  {
    id: 'xai',
    name: 'xAI / Grok',
    envKey: 'CPAMC_XAI_OAUTH',
    marker: 'CPAMC OAuth',
    match: (modelId) => modelId.startsWith('grok-'),
  },
  {
    id: 'gemini-api',
    name: 'Google Gemini API',
    envKey: 'GEMINI_API_KEY',
    marker: 'CPAMC API key',
    match: (modelId) => modelId.startsWith('gemini-') || modelId.startsWith('gemini-api-'),
  },
  {
    id: 'vertex',
    name: 'Google Vertex',
    envKey: 'VERTEX_SERVICE_ACCOUNT',
    marker: 'CPAMC service account',
    match: (modelId) => modelId.startsWith('vertex/'),
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    envKey: 'NVIDIA_API_KEY',
    marker: 'CPAMC API key',
    match: (modelId) =>
      modelId.startsWith('llama-') ||
      modelId.startsWith('nemotron-') ||
      modelId.startsWith('nvidia/'),
  },
  {
    id: 'kimi-web',
    name: 'Kimi WebBridge',
    envKey: 'KIMI_WEBBRIDGE',
    marker: 'local web bridge',
    match: (modelId) => modelId.startsWith('kimi-web-'),
  },
]

function readCpamcModelIds(payload: unknown): Array<string> {
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

async function getCpamcModelIds(): Promise<Array<string>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (CPAMC_API_KEY) headers.Authorization = `Bearer ${CPAMC_API_KEY}`
  const response = await fetch(`${CPAMC_BASE_URL.replace(/\/+$/, '')}/models`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) return []
  return readCpamcModelIds(await response.json())
}

async function getKimiWebBridgeConnected(): Promise<boolean> {
  const response = await fetch('http://127.0.0.1:10086/status', {
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) return false
  const payload = await response.json()
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).extension_connected === true,
  )
}

export async function handleHermesConfigGet({
  request,
}: {
  request: Request
}): Promise<Response> {
  const auth = await authorize(request)
  if (auth !== true) return auth

  const paths = resolveHermesConfigPaths()
  if (!getCapabilities().config) {
    return unavailablePayload({ paths, claudeHome: paths.hermesHome })
  }

  await ensureDiscovery()
  const files = readHermesConfigFiles(paths)
  const state = normalizeHermesConfigState({
    paths,
    config: files.config,
    env: files.env,
    authProfiles: files.authProfiles,
    localProviders: getDiscoveryStatus(),
    localModels: getDiscoveredModels(),
  })

  const cpamcModelIds = await getCpamcModelIds().catch(() => [])
  const kimiConnected = await getKimiWebBridgeConnected().catch(() => false)
  const managedProviders = PROSPER_MANAGED_PROVIDERS.map((provider) => {
    const models = cpamcModelIds.filter((modelId) => provider.match(modelId))
    const configured = models.length > 0
    const available =
      provider.id === 'kimi-web' ? configured && kimiConnected : configured
    const marker =
      provider.id === 'kimi-web' && configured && !kimiConnected
        ? 'extension disconnected'
        : provider.marker
    return {
      id: provider.id,
      name: provider.name,
      kind: 'api_key',
      configured,
      authenticated: configured,
      available,
      isDefault: state.activeProvider === provider.id,
      authSource: configured ? 'config' : 'none',
      envKeys: [provider.envKey],
      maskedCredentials: {
        [provider.envKey]: configured ? marker : '',
      },
      maskedKeys: {
        [provider.envKey]: configured ? marker : '',
      },
      models: models.map((id) => ({ id, name: id })),
      warnings: configured ? [] : ['No matching CPAMC model is visible right now.'],
      prosperManaged: true,
    }
  })

  // Legacy /api/claude-config consumers read provider.maskedKeys; alias it.
  const providers = state.providers.map((p) => ({
    ...p,
    maskedKeys: p.maskedCredentials,
  }))

  return Response.json({
    ...state,
    providers: [
      ...managedProviders,
      ...providers.filter(
        (provider) =>
          !PROSPER_MANAGED_PROVIDERS.some((managed) => managed.id === provider.id),
      ),
    ],
    claudeHome: paths.hermesHome,
  })
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      deepMerge(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      target[key] = value
    }
  }
}

function applyLegacyConfigBody(
  configPath: string,
  updates: Record<string, unknown>,
): void {
  let current: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = YAML.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>
    }
  } catch {}

  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      delete current[key]
      delete updates[key]
    }
  }
  deepMerge(current, updates)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, YAML.stringify(current), 'utf-8')
}

function applyLegacyEnvBody(
  envPath: string,
  envUpdates: Record<string, string | null>,
): void {
  let current: Record<string, string> = {}
  try {
    current = parseEnvFile(fs.readFileSync(envPath, 'utf-8'))
  } catch {}

  for (const [key, value] of Object.entries(envUpdates)) {
    if (value === '' || value === null) delete current[key]
    else current[key] = value
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  fs.writeFileSync(envPath, stringifyEnv(current), 'utf-8')
}

export async function handleHermesConfigPatch({
  request,
}: {
  request: Request
}): Promise<Response> {
  const auth = await authorize(request)
  if (auth !== true) return auth

  if (!getCapabilities().config) {
    return new Response(
      JSON.stringify(
        createCapabilityUnavailablePayload('config', {
          error: 'Configuration updates are unavailable on this backend.',
        }),
      ),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const paths = resolveHermesConfigPaths()
  const hasAction =
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { action?: unknown }).action === 'string'

  if (hasAction) {
    const parsed = PatchActionSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'Invalid patch action body', issues: parsed.error.issues },
        { status: 400 },
      )
    }
    const result = applyHermesConfigPatch(paths, parsed.data)
    return Response.json({ ...result, message: ACTION_MESSAGES[parsed.data.action] })
  }

  const legacy = LegacyPatchSchema.safeParse(body)
  if (!legacy.success) {
    return Response.json(
      { ok: false, error: 'Invalid request body', issues: legacy.error.issues },
      { status: 400 },
    )
  }

  if (legacy.data.config) applyLegacyConfigBody(paths.configPath, legacy.data.config)
  if (legacy.data.env) applyLegacyEnvBody(paths.envPath, legacy.data.env)

  return Response.json({ ok: true, message: LEGACY_SAVE_MESSAGE })
}
