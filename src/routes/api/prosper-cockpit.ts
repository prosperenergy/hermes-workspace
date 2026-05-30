import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'

const execFileAsync = promisify(execFile)

const CPAMC_BASE_URL =
  process.env.CPAMC_BASE_URL?.trim() ||
  process.env.CLI_PROXY_API_BASE_URL?.trim() ||
  'http://127.0.0.1:8317/v1'
const CPAMC_API_KEY = process.env.CPAMC_API_KEY?.trim() || 'prosper-sam-2026'
const REDIS_HELPER =
  process.env.PROSPER_REDIS_HELPER?.trim() ||
  path.join(os.homedir(), 'bin', 'redis-prosper')
const BRIDGE_RECEIPT_DIR =
  process.env.PROSPER_OS_BRIDGE_RECEIPT_DIR?.trim() ||
  path.join(os.homedir(), 'ClaudeCodexBridge', 'prosper-os-intents')

const STREAMS = {
  intents: 'prosper.os.intents',
  replies: 'prosper.os.replies',
  proof: 'prosper.os.proof',
  deadletter: 'prosper.os.deadletter',
} as const

type ProsperAgentPin = {
  id: string
  provider: string
  modelId: string
  model: string
  fallbacks?: Array<{
    provider: string
    modelId: string
    model: string
  }>
}

type ProsperAgentsFile = {
  updatedAt?: string
  agents?: Array<ProsperAgentPin>
}

type RoutedIntent = {
  intentId: string
  agentId: string
  reason: string
  mode: 'execute' | 'draft' | 'diagnose' | 'research'
  modelId: string
  provider: string
  model: string
  fallbacks: NonNullable<ProsperAgentPin['fallbacks']>
  routedMessage: string
}

type RedisStreamEntry = {
  id: string
  fields: Record<string, string>
}

type StreamSnapshot = {
  ok: boolean
  stream: string
  entries: Array<RedisStreamEntry>
  error: string | null
}

type WorkerSnapshot = {
  ok: boolean
  fields: Record<string, string>
  error: string | null
}

function findAgentsPath(): string {
  const configured = process.env.PROSPER_AGENTS_PATH?.trim()
  if (configured) return configured

  const candidates = [
    path.join(
      os.homedir(),
      'PROSPER_AI',
      'Hermes',
      'prosper-agents.json',
    ),
    '/Volumes/Samgsung T9/PROSPER_AI/Hermes/prosper-agents.json',
  ]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

function readProsperAgents(): {
  updatedAt: string | null
  agents: Array<ProsperAgentPin>
} {
  const agentsPath = findAgentsPath()
  try {
    const raw = JSON.parse(fs.readFileSync(agentsPath, 'utf-8')) as ProsperAgentsFile
    return {
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      agents: Array.isArray(raw.agents) ? raw.agents : [],
    }
  } catch {
    return { updatedAt: null, agents: [] }
  }
}

async function fetchModelCount(): Promise<{
  ok: boolean
  count: number
  sample: Array<string>
  error: string | null
}> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (CPAMC_API_KEY) headers.Authorization = `Bearer ${CPAMC_API_KEY}`

  try {
    const response = await fetch(`${CPAMC_BASE_URL.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(6_000),
    })
    if (!response.ok) {
      return {
        ok: false,
        count: 0,
        sample: [],
        error: `CPAMC returned ${response.status}`,
      }
    }

    const payload = (await response.json()) as Record<string, unknown>
    const rawModels = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : []

    const sample = rawModels
      .slice(0, 8)
      .map((entry): string => {
        if (typeof entry === 'string') return entry
        if (!entry || typeof entry !== 'object') return ''
        const record = entry as Record<string, unknown>
        return String(record.id ?? record.name ?? record.model ?? '')
      })
      .filter(Boolean)

    return {
      ok: true,
      count: rawModels.length,
      sample,
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      count: 0,
      sample: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function includesAny(text: string, terms: Array<string>): boolean {
  return terms.some((term) => text.includes(term))
}

function pickAgent(intent: string, agents: Array<ProsperAgentPin>): {
  agent: ProsperAgentPin | null
  reason: string
  mode: RoutedIntent['mode']
} {
  const text = intent.toLowerCase()
  const byId = new Map(agents.map((agent) => [agent.id.toLowerCase(), agent]))

  if (
    includesAny(text, [
      'video',
      'post this',
      'facebook',
      'instagram',
      'creative',
      'ad ',
      'caption',
      'social',
      'deck',
      'slides',
      'presentation',
    ])
  ) {
    return {
      agent: byId.get('maddi') ?? byId.get('sam') ?? null,
      reason: 'creative, social, or presentation work',
      mode: includesAny(text, ['post', 'facebook', 'instagram', 'social'])
        ? 'draft'
        : 'execute',
    }
  }

  if (
    includesAny(text, [
      'repo',
      'github',
      'terminal',
      'shell',
      'duplicate',
      'duplicates',
      'media storage',
      'file',
      'files',
      'scan',
      'check system',
    ])
  ) {
    return {
      agent: byId.get('burtha') ?? byId.get('sam') ?? null,
      reason: 'repo, filesystem, terminal, or system inspection',
      mode: 'diagnose',
    }
  }

  if (
    includesAny(text, [
      'plan',
      'meeting',
      'hanna',
      'ops',
      'workflow',
      'monday',
      'ghl',
      'gohighlevel',
      'crm',
      'pipeline',
      'customer communication',
    ])
  ) {
    return {
      agent: byId.get('hanna') ?? byId.get('sam') ?? null,
      reason: 'operations, planning, CRM, or workflow work',
      mode: includesAny(text, ['build', 'fix', 'wire', 'make it'])
        ? 'execute'
        : 'research',
    }
  }

  if (
    includesAny(text, [
      'lead',
      'follow up',
      'follow-up',
      'sales',
      'nepq',
      'reply',
      'customer text',
      'customer message',
    ])
  ) {
    return {
      agent: byId.get('kayla') ?? byId.get('hanna') ?? byId.get('sam') ?? null,
      reason: 'sales or customer follow-up work',
      mode: 'draft',
    }
  }

  if (
    includesAny(text, [
      'research',
      'learn',
      'compare',
      'summarize',
      'scrub',
      'youtube',
      'social media',
    ])
  ) {
    return {
      agent: byId.get('oma') ?? byId.get('sam') ?? null,
      reason: 'research and synthesis',
      mode: 'research',
    }
  }

  return {
    agent: byId.get('sam') ?? (agents.length > 0 ? agents[0] : null),
    reason: 'default builder/executor lane',
    mode: 'execute',
  }
}

function buildToolInheritanceBlock(): string {
  return [
    'Tool inheritance available in Prosper OS:',
    '- MCP/connectors: Gmail, Box, Notion, Monday, GHL, Supabase, ElevenLabs, Higgsfield, Telnyx, SignNow, PDF tools, iMessage, Computer Use, browser/Chrome, Firecrawl/Exa, Redis where configured.',
    '- Skills: Prosper, sales, operations, engineering, research, document, deck, spreadsheet, PDF, design, and Craig-mode skill roots where available.',
    '- CLI: gam, codex, claude, hermes, gh, bun, op, redis-cli, prosper-ai-gateway-health, plus scripts in ~/bin and ~/.local/bin with Prosper env loaded when needed.',
    '- Files/auth: ClaudeCodexBridge, Projects, T9, and .config/prosper. Never print secrets.',
  ].join('\n')
}

function routeIntent(
  intent: string,
  agents: Array<ProsperAgentPin>,
  intentId = randomUUID(),
): RoutedIntent {
  const { agent, reason, mode } = pickAgent(intent, agents)
  const agentName = agent?.id ?? 'sam'
  const modelId = agent?.modelId ?? 'default'
  const provider = agent?.provider ?? 'default'
  const model = agent?.model ?? 'current Prosper OS default'
  const fallbackPins = agent?.fallbacks ?? []
  const primary = agent
    ? `${agent.model} (${agent.modelId}) via ${agent.provider}`
    : 'current Prosper OS default'
  const fallbacks =
    fallbackPins.map((fallback) => `${fallback.model} (${fallback.modelId})`).join(' -> ') ||
    'configured gateway fallback'

  const routedMessage = [
    `PROSPER OS ROUTED INTENT`,
    `Intent ID: ${intentId}`,
    `Agent: ${agentName}`,
    `Reason: ${reason}`,
    `Mode: ${mode}`,
    `Primary model pin: ${primary}`,
    `Fallbacks: ${fallbacks}`,
    '',
    buildToolInheritanceBlock(),
    '',
    'Execution rule:',
    'Act like this Prosper OS front door is the command surface. Verify live state first, choose the needed tools, execute the work, test/read back the result, and report only what changed plus any blocker.',
    mode === 'draft'
      ? 'Do not send/post/publish anything externally unless Craig explicitly says go.'
      : '',
    '',
    'Craig intent:',
    intent,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    intentId,
    agentId: agentName,
    reason,
    mode,
    modelId,
    provider,
    model,
    fallbacks: fallbackPins,
    routedMessage,
  }
}

async function redisJson(args: Array<string>): Promise<unknown> {
  const { stdout } = await execFileAsync(REDIS_HELPER, ['--json', ...args], {
    timeout: 8_000,
    maxBuffer: 1024 * 1024,
  })
  const text = stdout.trim()
  if (!text) return null
  return JSON.parse(text) as unknown
}

async function redisRaw(args: Array<string>): Promise<string> {
  const { stdout } = await execFileAsync(REDIS_HELPER, ['--raw', ...args], {
    timeout: 8_000,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

function parseStreamEntries(payload: unknown): Array<RedisStreamEntry> {
  if (!Array.isArray(payload)) return []
  return payload.flatMap((entry): Array<RedisStreamEntry> => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') return []
    const rawFields = entry[1]
    const fields: Record<string, string> = {}
    if (Array.isArray(rawFields)) {
      for (let index = 0; index < rawFields.length; index += 2) {
        const key = rawFields[index]
        if (typeof key !== 'string') continue
        const value = rawFields[index + 1]
        fields[key] = typeof value === 'string' ? value : JSON.stringify(value)
      }
    }
    return [{ id: entry[0], fields }]
  })
}

async function readStream(
  stream: string,
  count = 12,
): Promise<StreamSnapshot> {
  try {
    const payload = await redisJson([
      'XREVRANGE',
      stream,
      '+',
      '-',
      'COUNT',
      String(count),
    ])
    return {
      ok: true,
      stream,
      entries: parseStreamEntries(payload),
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      stream,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function readWorkerStatus(): Promise<WorkerSnapshot> {
  try {
    const payload = await redisJson(['HGETALL', 'prosper:os-worker:status'])
    const fields: Record<string, string> = {}
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      for (const [key, value] of Object.entries(payload)) {
        fields[key] = typeof value === 'string' ? value : JSON.stringify(value)
      }
    }
    return { ok: fields.status === 'online', fields, error: null }
  } catch (error) {
    return {
      ok: false,
      fields: {},
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function writeIntentToRedis(
  intent: string,
  routed: RoutedIntent,
): Promise<{ ok: true; redisId: string } | { ok: false; error: string }> {
  const createdAt = new Date().toISOString()
  const fallbacksJson = JSON.stringify(routed.fallbacks)
  try {
    const redisId = await redisRaw([
      'XADD',
      STREAMS.intents,
      '*',
      'intent_id',
      routed.intentId,
      'agent_id',
      routed.agentId,
      'mode',
      routed.mode,
      'intent',
      intent,
      'routed_message',
      routed.routedMessage,
      'model_id',
      routed.modelId,
      'provider',
      routed.provider,
      'fallbacks_json',
      fallbacksJson,
      'created_at',
      createdAt,
      'status',
      'queued',
    ])
    await redisRaw([
      'XADD',
      STREAMS.proof,
      '*',
      'intent_id',
      routed.intentId,
      'agent_id',
      routed.agentId,
      'status',
      'queued',
      'source',
      'hermes-prosper-os',
      'created_at',
      createdAt,
      'message',
      `Queued ${routed.agentId} through Redis Streams`,
    ])
    return { ok: true, redisId }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function writeBridgeReceipt(payload: Record<string, unknown>): {
  ok: boolean
  path: string | null
  error: string | null
} {
  try {
    fs.mkdirSync(BRIDGE_RECEIPT_DIR, { recursive: true })
    const safeId = String(payload.intent_id ?? randomUUID()).replace(
      /[^a-zA-Z0-9_.-]/g,
      '_',
    )
    const receiptPath = path.join(BRIDGE_RECEIPT_DIR, `${safeId}.json`)
    fs.writeFileSync(receiptPath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    })
    return { ok: true, path: receiptPath, error: null }
  } catch (error) {
    return {
      ok: false,
      path: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const Route = createFileRoute('/api/prosper-cockpit')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const [models, agents, intents, replies, proof, deadletter, worker] = await Promise.all([
          fetchModelCount(),
          Promise.resolve(readProsperAgents()),
          readStream(STREAMS.intents),
          readStream(STREAMS.replies),
          readStream(STREAMS.proof),
          readStream(STREAMS.deadletter),
          readWorkerStatus(),
        ])

        return json({
          ok: true,
          generatedAt: new Date().toISOString(),
          models,
          agents,
          streams: {
            names: STREAMS,
            intents,
            replies,
            proof,
            deadletter,
          },
          worker,
          actions: [
            {
              id: 'sam-build',
              label: 'Ask Sam to build or fix something',
              prompt:
                'Sam, do this end to end. First verify the current state, then make the needed changes, test it, and tell me what changed:',
            },
            {
              id: 'hanna-plan',
              label: 'Ask Hanna to turn notes into a plan',
              prompt:
                'Hanna, turn this into a clear Prosper operating plan with owners, next steps, and blockers:',
            },
            {
              id: 'burtha-check',
              label: 'Ask Burtha to check repo/system state',
              prompt:
                'Burtha, inspect the repo/system state, find what is broken, and give Sam the concrete fix path:',
            },
            {
              id: 'kayla-sales',
              label: 'Ask Kayla for a sales follow-up draft',
              prompt:
                'Kayla, draft a clean sales follow-up for this lead. Do not send it. Keep it human and useful:',
            },
          ],
        })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const intent =
          typeof body.intent === 'string' ? body.intent.trim() : ''
        if (!intent) {
          return json({ ok: false, error: 'intent required' }, { status: 400 })
        }

        const agents = readProsperAgents()
        const routed = routeIntent(intent, agents.agents)
        const bus = await writeIntentToRedis(intent, routed)
        const receipt = writeBridgeReceipt({
          intent_id: routed.intentId,
          intent,
          routed,
          redis: bus,
          created_at: new Date().toISOString(),
          note: bus.ok
            ? 'Backup receipt only. Redis Streams is the primary bus.'
            : 'Redis failed. This file is emergency fallback/audit only.',
        })

        if (!bus.ok) {
          return json(
            {
              ok: false,
              error: 'Redis Streams write failed',
              routed,
              agents,
              redis: bus,
              bridgeReceipt: receipt,
            },
            { status: 503 },
          )
        }

        return json({
          ok: true,
          routed,
          agents,
          redis: bus,
          bridgeReceipt: receipt,
        })
      },
    },
  },
})
