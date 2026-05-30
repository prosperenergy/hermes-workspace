#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const STREAMS = {
  intents: 'prosper.os.intents',
  replies: 'prosper.os.replies',
  proof: 'prosper.os.proof',
  deadletter: 'prosper.os.deadletter',
}

const AGENT_ROLES = {
  sam: 'builder and executor for code, systems, local tooling, and fixes',
  hanna: 'lead engineer for architecture, operations, workflows, and judgment',
  burtha: 'infrastructure and repository operator for git, shell, and recovery',
  kayla: 'sales-support agent for lead follow-up drafts and customer-safe wording',
  maddi: 'creative and presentation agent for decks, social drafts, visuals, and packaging',
  oma: 'research and memory agent for synthesis, comparison, and knowledge capture',
}

const AGENT_TOKENS = {
  sam: 'prosper-sam-2026',
  hanna: 'prosper-hanna-2026',
  burtha: 'prosper-burtha-2026',
  kayla: 'prosper-kayla-2026',
  maddi: 'prosper-maddi-2026',
  oma: 'prosper-oma-2026',
}

const execArgs = new Set(process.argv.slice(2))
const once = execArgs.has('--once')
const maxArg = process.argv.find((arg) => arg.startsWith('--max='))
const maxToProcess = maxArg ? Number.parseInt(maxArg.slice(6), 10) : once ? 1 : Infinity

const GROUP = process.env.PROSPER_OS_WORKER_GROUP || 'prosper-os-worker'
const CONSUMER =
  process.env.PROSPER_OS_WORKER_CONSUMER ||
  `prosper-os-${os.hostname().replace(/[^a-zA-Z0-9_.-]/g, '-')}-${process.pid}`
const REDIS_HELPER =
  process.env.PROSPER_REDIS_HELPER || path.join(os.homedir(), 'bin', 'redis-prosper')
const CPAMC_BASE_URL = (
  process.env.CPAMC_BASE_URL ||
  process.env.CLI_PROXY_API_BASE_URL ||
  'http://127.0.0.1:8317/v1'
).replace(/\/+$/, '')
const AGENTS_PATH =
  process.env.PROSPER_AGENTS_PATH ||
  '/Volumes/Samgsung T9/PROSPER_AI/Hermes/prosper-agents.json'
const MAXLEN = Number.parseInt(process.env.REDIS_STREAM_MAXLEN || '50000', 10)
const WORKER_PORT = Number.parseInt(process.env.PROSPER_OS_WORKER_PORT || '8788', 10)
const CHAT_TIMEOUT_MS = Number.parseInt(process.env.PROSPER_OS_CHAT_TIMEOUT_MS || '90000', 10)
const MAX_REPLY_CHARS = Number.parseInt(process.env.PROSPER_OS_REPLY_CHARS || '2400', 10)

let processed = 0
let activeIntent = ''
let lastError = ''
let lastProof = 'booting'
let lastEventAt = ''
let shuttingDown = false

function now() {
  return new Date().toISOString()
}

function compact(value, limit = 900) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/\b(sk|pk|rk|ghp|gho|ghu|ghs|xai|glpat|pat)_[A-Za-z0-9_=-]{16,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{16,}@/g, '[redacted]@')
    .replace(/\b([A-Z0-9_]*(?:API|TOKEN|SECRET|PASSWORD|PRIVATE|KEY)[A-Z0-9_]*)\s*=\s*[^ \n]+/gi, '$1=[redacted]')
    .replace(/\p{Extended_Pictographic}/gu, '')
}

function readAgents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf8'))
    return Array.isArray(parsed.agents) ? parsed.agents : []
  } catch {
    return []
  }
}

function toFields(rawFields = []) {
  const fields = {}
  for (let index = 0; index < rawFields.length; index += 2) {
    fields[String(rawFields[index])] = String(rawFields[index + 1] ?? '')
  }
  return fields
}

function parseStreamRows(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return Object.entries(payload).flatMap(([stream, entries]) => {
      if (!Array.isArray(entries)) return []
      return entries.flatMap((entry) => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') return []
        return [{ stream, id: entry[0], fields: toFields(entry[1]) }]
      })
    })
  }
  if (!Array.isArray(payload)) return []
  const rows = []
  if (Array.isArray(payload[1]) && Array.isArray(payload[1][0])) {
    for (const entry of payload[1]) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      rows.push({ stream: STREAMS.intents, id: entry[0], fields: toFields(entry[1]) })
    }
    return rows
  }
  for (const streamRow of payload) {
    if (!Array.isArray(streamRow) || typeof streamRow[0] !== 'string') continue
    const stream = streamRow[0]
    const entries = Array.isArray(streamRow[1]) ? streamRow[1] : []
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      rows.push({ stream, id: entry[0], fields: toFields(entry[1]) })
    }
  }
  return rows
}

async function redisJson(args, timeout = 10000) {
  const { stdout } = await execFileAsync(REDIS_HELPER, ['--json', ...args], {
    timeout,
    maxBuffer: 1024 * 1024 * 4,
  })
  const text = stdout.trim()
  if (!text) return null
  return JSON.parse(text)
}

async function redisRaw(args, timeout = 10000) {
  const { stdout } = await execFileAsync(REDIS_HELPER, ['--raw', ...args], {
    timeout,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

async function xadd(stream, fields) {
  const args = ['XADD', stream]
  if (Number.isFinite(MAXLEN) && MAXLEN > 0) args.push('MAXLEN', '~', String(MAXLEN))
  args.push('*')
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    args.push(key, String(value))
  }
  return redisRaw(args)
}

async function hsetStatus(extra = {}) {
  const fields = {
    status: 'online',
    worker: 'prosper-os-redis-worker',
    group: GROUP,
    consumer: CONSUMER,
    processed: String(processed),
    active_intent: activeIntent,
    last_proof: lastProof,
    last_error: lastError,
    ts: now(),
    ...extra,
  }
  await redisRaw(['HSET', 'prosper:os-worker:status', ...Object.entries(fields).flatMap(([k, v]) => [k, String(v)])])
}

async function ensureGroup() {
  try {
    await redisRaw(['XGROUP', 'CREATE', STREAMS.intents, GROUP, '0', 'MKSTREAM'])
  } catch (error) {
    if (!String(error?.message || error).includes('BUSYGROUP')) throw error
  }
}

function candidateModels(fields) {
  const candidates = []
  const add = (value) => {
    const model = String(value || '').trim()
    if (model && model !== 'default' && !candidates.includes(model)) candidates.push(model)
  }

  add(fields.model_id)

  try {
    const fallbacks = JSON.parse(fields.fallbacks_json || '[]')
    if (Array.isArray(fallbacks)) {
      for (const fallback of fallbacks) add(fallback?.modelId || fallback?.model)
    }
  } catch {
    // Bad fallback JSON should not block the primary route.
  }

  const aliases = {
    'nemotron-120b': ['nemotron-120b', 'nemotron-49b', 'llama-3.3-70b'],
    'llama-3.3-70b': ['llama-3.3-70b'],
    'gemini-3.1-pro-preview': ['gemini-3.1-pro-low', 'gemini-2.5-pro'],
    'gemini-3.1-pro': ['gemini-3.1-pro-low', 'gemini-2.5-pro'],
    'gemini-3.5-flash': ['gemini-3.5-flash', 'gemini-3.5-flash-low', 'gemini-2.5-flash'],
  }

  for (const model of [...candidates]) {
    for (const alias of aliases[model] || []) add(alias)
  }

  if (candidates.length === 0) add('gpt-5.5')
  return candidates
}

function agentName(agentId) {
  return agentId.charAt(0).toUpperCase() + agentId.slice(1)
}

function buildMessages(fields, modelId) {
  const agentId = (fields.agent_id || 'sam').toLowerCase()
  const role = AGENT_ROLES[agentId] || AGENT_ROLES.sam
  const mode = fields.mode || 'execute'
  const externalGuard =
    mode === 'draft'
      ? 'This is draft-only. Do not claim you sent, posted, emailed, called, or texted anything.'
      : 'Do not send SMS, calls, emails, social posts, payments, credential changes, deletes, or customer-facing actions.'

  const system = [
    `You are ${agentName(agentId)} inside Prosper OS.`,
    `Your role: ${role}.`,
    `Current model lane: ${modelId}. Agent identity stays ${agentName(agentId)} even if the model falls back.`,
    `The worker has verified this routing metadata: agent_id=${agentId}, model_id=${modelId}, intent_id=${fields.intent_id || 'unknown'}. You may state this metadata as routing proof.`,
    `Treat ${agentName(agentId)} as the Prosper OS application seat name. Do not deny the seat label because of the underlying provider or model identity.`,
    'Craig wants useful execution, not dashboard theater.',
    'If the direct worker cannot access a required external tool or file, say exactly what adapter/tool is missing and what proof should come back. Do not pretend external work happened.',
    externalGuard,
    'No emoji.',
    'Give a direct result for Craig. Keep it concise, concrete, and action-oriented.',
  ].join(' ')

  const user = [
    fields.routed_message || '',
    '',
    'Worker execution context:',
    `Redis source id: ${fields._redis_id || 'unknown'}`,
    `Intent id: ${fields.intent_id || 'unknown'}`,
    `Mode: ${mode}`,
    '',
    'Return:',
    '- what you did or can safely do now',
    '- result or draft',
    '- any exact blocker, if real',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function isIdentityRefusal(reply, agentId) {
  const text = String(reply || '').toLowerCase()
  return (
    text.includes(`not "${agentId}"`) ||
    text.includes(`not ${agentId}`) ||
    text.includes("can't truthfully claim") ||
    text.includes('cannot truthfully claim') ||
    text.includes('cannot verify or assert') ||
    text.includes('i have no access to that routing layer')
  )
}

function buildWorkerProofReply(fields, modelId, attempts) {
  const agentId = (fields.agent_id || 'sam').toLowerCase()
  return [
    `${agentName(agentId)} proof: Prosper OS routed intent ${fields.intent_id || 'unknown'} to agent=${agentId} on model=${modelId}.`,
    `Redis source: ${fields._redis_id || 'unknown'}.`,
    'The model completed, but the provider identity layer refused to personally attest the app-seat name, so this proof is issued by the worker instead of pretending the model can see the router.',
    `Attempts: ${attempts.map((attempt) => `${attempt.modelId}:${attempt.ok ? 'ok' : 'failed'}`).join(', ')}.`,
  ].join(' ')
}

async function callModel(agentId, modelId, fields) {
  const token = AGENT_TOKENS[agentId] || AGENT_TOKENS.sam
  const response = await fetch(`${CPAMC_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: buildMessages(fields, modelId),
      max_tokens: 900,
      stream: false,
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  })

  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { raw: text }
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      payload?.raw ||
      `CPAMC HTTP ${response.status}`
    throw new Error(String(message))
  }

  const reply = payload?.choices?.[0]?.message?.content
  if (!reply) throw new Error(`No completion text returned for ${modelId}`)
  const cleanReply = redactSecrets(String(reply)).slice(0, MAX_REPLY_CHARS)
  if (isIdentityRefusal(cleanReply, agentId)) {
    const error = new Error(`Provider identity refusal for ${agentId} on ${modelId}`)
    error.code = 'IDENTITY_REFUSAL'
    throw error
  }
  return cleanReply
}

async function runWithFallbacks(fields) {
  const agentId = (fields.agent_id || 'sam').toLowerCase()
  const attempts = []
  for (const modelId of candidateModels(fields)) {
    const started = Date.now()
    try {
      const reply = await callModel(agentId, modelId, fields)
      attempts.push({ modelId, ok: true, durationMs: Date.now() - started })
      return { reply, modelId, attempts }
    } catch (error) {
      const attempt = {
        modelId,
        ok: false,
        durationMs: Date.now() - started,
        error: compact(error?.message || error, 220),
        code: error?.code || '',
      }
      attempts.push(attempt)
      if (attempt.code === 'IDENTITY_REFUSAL' && modelId === fields.model_id) {
        return {
          reply: buildWorkerProofReply(fields, modelId, attempts),
          modelId,
          attempts,
        }
      }
    }
  }
  const identityRefusal = attempts.find((attempt) => attempt.code === 'IDENTITY_REFUSAL')
  if (identityRefusal) {
    return {
      reply: buildWorkerProofReply(fields, fields.model_id || identityRefusal.modelId, attempts),
      modelId: fields.model_id || identityRefusal.modelId,
      attempts,
    }
  }
  throw new Error(`All model attempts failed: ${JSON.stringify(attempts)}`)
}

async function processIntent(row) {
  const fields = { ...row.fields, _redis_id: row.id }
  const intentId = fields.intent_id || row.id
  const agentId = (fields.agent_id || 'sam').toLowerCase()
  const startedAt = Date.now()
  activeIntent = intentId
  await hsetStatus({ last_stream: row.stream, last_id: row.id })

  await xadd(STREAMS.proof, {
    intent_id: intentId,
    agent_id: agentId,
    status: 'running',
    source: 'prosper-os-redis-worker',
    source_redis_id: row.id,
    created_at: now(),
    message: `Worker picked up ${agentId}`,
  })

  try {
    const result = await runWithFallbacks(fields)
    const durationMs = Date.now() - startedAt
    const replyId = await xadd(STREAMS.replies, {
      intent_id: intentId,
      agent_id: agentId,
      status: 'complete',
      reply: result.reply,
      model_id: result.modelId,
      provider: fields.provider || '',
      source: 'prosper-os-redis-worker',
      source_redis_id: row.id,
      attempts_json: JSON.stringify(result.attempts),
      duration_ms: String(durationMs),
      created_at: now(),
    })

    await xadd(STREAMS.proof, {
      intent_id: intentId,
      agent_id: agentId,
      status: 'complete',
      source: 'prosper-os-redis-worker',
      source_redis_id: row.id,
      reply_redis_id: replyId,
      model_id: result.modelId,
      duration_ms: String(durationMs),
      created_at: now(),
      message: `Completed ${agentId} with ${result.modelId}`,
    })

    lastProof = `${row.stream}:${row.id} -> ${STREAMS.replies}:${replyId}`
    lastEventAt = now()
    processed += 1
    activeIntent = ''
    await redisRaw(['XACK', row.stream, GROUP, row.id])
    await hsetStatus({ last_stream: row.stream, last_id: row.id })
    return true
  } catch (error) {
    const message = compact(error?.message || error, 1000)
    lastError = message
    await xadd(STREAMS.deadletter, {
      intent_id: intentId,
      agent_id: agentId,
      status: 'failed',
      error: message,
      source: 'prosper-os-redis-worker',
      source_redis_id: row.id,
      created_at: now(),
    })
    await xadd(STREAMS.proof, {
      intent_id: intentId,
      agent_id: agentId,
      status: 'failed',
      source: 'prosper-os-redis-worker',
      source_redis_id: row.id,
      created_at: now(),
      message,
    })
    await redisRaw(['XACK', row.stream, GROUP, row.id]).catch(() => undefined)
    activeIntent = ''
    await hsetStatus({ last_stream: row.stream, last_id: row.id })
    return false
  }
}

async function readRows(blockMs = 1000) {
  const claimed = await redisJson(
    [
      'XAUTOCLAIM',
      STREAMS.intents,
      GROUP,
      CONSUMER,
      '1000',
      '0-0',
      'COUNT',
      '2',
    ],
    10000,
  )
  const claimedRows = parseStreamRows(claimed)
  if (claimedRows.length > 0) return claimedRows

  const payload = await redisJson(
    [
      'XREADGROUP',
      'GROUP',
      GROUP,
      CONSUMER,
      'COUNT',
      '2',
      'BLOCK',
      String(blockMs),
      'STREAMS',
      STREAMS.intents,
      '>',
    ],
    blockMs + 5000,
  )
  return parseStreamRows(payload)
}

function serveHealth() {
  http
    .createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: true,
          worker: 'prosper-os-redis-worker',
          group: GROUP,
          consumer: CONSUMER,
          stream: STREAMS.intents,
          processed,
          activeIntent,
          lastProof,
          lastError,
          lastEventAt,
          smsFrozen: true,
        }),
      )
    })
    .listen(WORKER_PORT, '127.0.0.1')
}

async function markOffline(reason) {
  try {
    await redisRaw([
      'HSET',
      'prosper:os-worker:status',
      'status',
      'offline',
      'worker',
      'prosper-os-redis-worker',
      'group',
      GROUP,
      'consumer',
      CONSUMER,
      'processed',
      String(processed),
      'last_proof',
      lastProof,
      'last_error',
      reason || lastError,
      'ts',
      now(),
    ])
  } catch {
    // Best effort on shutdown.
  }
}

function installShutdownHandlers() {
  const shutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    void markOffline(signal).finally(() => process.exit(0))
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

async function main() {
  installShutdownHandlers()
  serveHealth()
  await ensureGroup()
  await redisRaw(['HDEL', 'prosper:os-worker:status', 'once']).catch(() => undefined)
  await hsetStatus()
  setInterval(() => {
    void hsetStatus().catch((error) => {
      lastError = compact(error?.message || error, 500)
    })
  }, 30000)

  let handled = 0
  while (!shuttingDown && handled < maxToProcess) {
    try {
      const rows = await readRows(once ? 1000 : 5000)
      if (rows.length === 0) {
        if (once) break
        continue
      }
      for (const row of rows) {
        await processIntent(row)
        handled += 1
        if (handled >= maxToProcess) break
      }
    } catch (error) {
      lastError = compact(error?.message || error, 500)
      await hsetStatus().catch(() => undefined)
      if (once) throw error
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }

  if (once) {
    await hsetStatus({ once: 'complete' }).catch(() => undefined)
    process.exit(0)
  }
}

main().catch((error) => {
  const message = compact(error?.message || error, 500)
  console.error(message)
  void markOffline(message).finally(() => process.exit(1))
})
