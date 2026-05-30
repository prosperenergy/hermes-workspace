import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { usePageTitle } from '@/hooks/use-page-title'
import { cn } from '@/lib/utils'

type AgentPin = {
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

type StreamEntry = {
  id: string
  fields: Record<string, string>
}

type StreamSnapshot = {
  ok: boolean
  stream: string
  entries: Array<StreamEntry>
  error: string | null
}

type ProsperCockpitStatus = {
  ok: boolean
  generatedAt?: string
  models?: {
    ok: boolean
    count: number
    sample: Array<string>
    error: string | null
  }
  agents?: {
    updatedAt: string | null
    agents: Array<AgentPin>
  }
  streams?: {
    intents: StreamSnapshot
    replies: StreamSnapshot
    proof: StreamSnapshot
    deadletter: StreamSnapshot
  }
  worker?: {
    ok: boolean
    fields: Record<string, string>
    error: string | null
  }
  actions?: Array<{
    id: string
    label: string
    prompt: string
  }>
  error?: string
}

type RouteResponse = {
  ok: boolean
  routed?: {
    intentId: string
    agentId: string
    reason: string
    mode: string
    modelId: string
    provider: string
    model: string
  }
  redis?: {
    ok: boolean
    redisId?: string
    error?: string
  }
  bridgeReceipt?: {
    ok: boolean
    path: string | null
    error: string | null
  }
  error?: string
}

const QUICK_TESTS = [
  'pull all unread emails about Cardiff',
  'post this video to FB and IG',
  'find duplicates in Media Storage',
  'deck me on Q1 numbers',
]

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusLabel(
  entry: StreamEntry,
  proofByIntent: Map<string, StreamEntry>,
  replyByIntent: Map<string, StreamEntry>,
): string {
  const intentId = entry.fields.intent_id
  const reply = intentId ? replyByIntent.get(intentId) : null
  if (reply?.fields.status) return reply.fields.status
  const proof = intentId ? proofByIntent.get(intentId) : null
  return proof?.fields.status || entry.fields.status || entry.fields.mode || 'queued'
}

function shortId(value: string | undefined): string {
  if (!value) return 'pending'
  if (value.length <= 14) return value
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function Panel({
  title,
  children,
  className,
}: {
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn('rounded-xl border p-4', className)}
      style={{
        background: 'var(--theme-card)',
        borderColor: 'var(--theme-border)',
      }}
    >
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
        {title}
      </h2>
      {children}
    </section>
  )
}

export function ProsperScreen() {
  usePageTitle('Prosper OS')

  const [status, setStatus] = useState<ProsperCockpitStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [intent, setIntent] = useState('')
  const [routeResult, setRouteResult] = useState<RouteResponse | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/prosper-cockpit', {
        cache: 'no-store',
      })
      const payload = (await response.json()) as ProsperCockpitStatus
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `Status failed: ${response.status}`)
      }
      setStatus(payload)
      setStatusError(null)
    } catch (error) {
      setStatusError(asErrorMessage(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 8_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const agents = status?.agents?.agents ?? []
  const recentIntents = status?.streams?.intents.entries ?? []
  const recentProof = status?.streams?.proof.entries ?? []
  const recentReplies = status?.streams?.replies.entries ?? []
  const latestProof = recentProof.length > 0 ? recentProof[0] : null
  const latestReply = recentReplies.length > 0 ? recentReplies[0] : null
  const modelsCount = status?.models?.count ?? 0
  const redisOk =
    status?.streams?.intents.ok !== false &&
    status?.streams?.proof.ok !== false
  const workerOk = status?.worker?.ok === true
  const proofByIntent = useMemo(() => {
    const next = new Map<string, StreamEntry>()
    for (const entry of recentProof) {
      const intentId = entry.fields.intent_id
      if (intentId && !next.has(intentId)) next.set(intentId, entry)
    }
    return next
  }, [recentProof])
  const replyByIntent = useMemo(() => {
    const next = new Map<string, StreamEntry>()
    for (const entry of recentReplies) {
      const intentId = entry.fields.intent_id
      if (intentId && !next.has(intentId)) next.set(intentId, entry)
    }
    return next
  }, [recentReplies])

  const canSubmit = useMemo(
    () => intent.trim().length > 0 && !submitting,
    [intent, submitting],
  )

  async function submitIntent(nextIntent = intent) {
    const trimmed = nextIntent.trim()
    if (!trimmed) return
    setSubmitting(true)
    setRouteResult(null)
    try {
      const response = await fetch('/api/prosper-cockpit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: trimmed }),
      })
      const payload = (await response.json()) as RouteResponse
      setRouteResult(payload)
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `Route failed: ${response.status}`)
      }
      setIntent('')
      await refresh()
    } catch (error) {
      setRouteResult((current) => ({
        ...(current ?? {}),
        ok: false,
        error: asErrorMessage(error),
      }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-full px-4 py-5 md:px-6 md:py-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              Command cockpit
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal text-[var(--theme-text)]">
              Prosper OS
            </h1>
          </div>
          <div className="grid grid-cols-4 gap-2 text-right">
            <div className="rounded-lg border border-[var(--theme-border)] px-3 py-2">
              <div className="text-lg font-semibold">{modelsCount}</div>
              <div className="text-[11px] text-muted">models</div>
            </div>
            <div className="rounded-lg border border-[var(--theme-border)] px-3 py-2">
              <div className="text-lg font-semibold">{agents.length}</div>
              <div className="text-[11px] text-muted">agents</div>
            </div>
            <div className="rounded-lg border border-[var(--theme-border)] px-3 py-2">
              <div
                className={cn(
                  'text-lg font-semibold',
                  redisOk ? 'text-emerald-400' : 'text-red-400',
                )}
              >
                {redisOk ? 'live' : 'check'}
              </div>
              <div className="text-[11px] text-muted">redis</div>
            </div>
            <div className="rounded-lg border border-[var(--theme-border)] px-3 py-2">
              <div
                className={cn(
                  'text-lg font-semibold',
                  workerOk ? 'text-emerald-400' : 'text-amber-300',
                )}
              >
                {workerOk ? 'live' : 'idle'}
              </div>
              <div className="text-[11px] text-muted">worker</div>
            </div>
          </div>
        </header>

        <Panel title="Intent Router">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submitIntent()
            }}
          >
            <textarea
              value={intent}
              onChange={(event) => setIntent(event.currentTarget.value)}
              placeholder="Type what needs to happen. Prosper OS routes it to the right agent and writes Redis first."
              className="min-h-32 w-full resize-y rounded-xl border bg-[var(--theme-card2)] px-4 py-3 text-sm outline-none transition focus:border-[var(--theme-accent)]"
              style={{
                borderColor: 'var(--theme-border)',
                color: 'var(--theme-text)',
              }}
            />
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex flex-wrap gap-2">
                {QUICK_TESTS.map((test) => (
                  <button
                    key={test}
                    type="button"
                    onClick={() => {
                      setIntent(test)
                      void submitIntent(test)
                    }}
                    className="rounded-lg border border-[var(--theme-border)] px-3 py-2 text-xs text-muted transition hover:text-[var(--theme-text)]"
                    disabled={submitting}
                  >
                    {test}
                  </button>
                ))}
              </div>
              <button
                type="submit"
                disabled={!canSubmit}
                className="rounded-lg bg-[var(--theme-accent)] px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Routing...' : 'Route Intent'}
              </button>
            </div>
          </form>
          {routeResult ? (
            <div
              className="mt-4 rounded-lg border px-3 py-3 text-sm"
              style={{
                borderColor: routeResult.ok
                  ? 'color-mix(in srgb, #22c55e 45%, var(--theme-border))'
                  : 'color-mix(in srgb, #ef4444 45%, var(--theme-border))',
                background: 'var(--theme-card2)',
              }}
            >
              {routeResult.ok && routeResult.routed ? (
                <div className="flex flex-col gap-1">
                  <span className="font-semibold">
                    Queued {routeResult.routed.agentId} through Redis
                  </span>
                  <span className="text-muted">
                    {shortId(routeResult.routed.intentId)} ·{' '}
                    {routeResult.routed.model} · Redis ID{' '}
                    {shortId(routeResult.redis?.redisId)}
                  </span>
                </div>
              ) : (
                <span className="text-red-300">
                  {routeResult.error || 'Routing failed'}
                </span>
              )}
            </div>
          ) : null}
        </Panel>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Panel title="Recent Routed Jobs">
            {recentIntents.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-[var(--theme-border)]">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--theme-card2)] text-xs uppercase tracking-[0.12em] text-muted">
                    <tr>
                      <th className="px-3 py-2">Intent</th>
                      <th className="px-3 py-2">Agent</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentIntents.map((entry) => (
                      <tr
                        key={entry.id}
                        className="border-t border-[var(--theme-border)]"
                      >
                        <td className="max-w-[420px] truncate px-3 py-2">
                          {entry.fields.intent}
                        </td>
                        <td className="px-3 py-2">
                          {entry.fields.agent_id || 'sam'}
                        </td>
                        <td className="px-3 py-2">
                          {statusLabel(entry, proofByIntent, replyByIntent)}
                        </td>
                        <td className="px-3 py-2 text-muted">
                          {shortId(entry.fields.intent_id)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted">
                No Redis intent rows yet. Send a test command to create one.
              </p>
            )}
          </Panel>

          <div className="flex flex-col gap-5">
            <Panel title="Latest Reply / Proof">
              {latestReply ? (
                <div className="space-y-2 text-sm">
                  <div className="font-semibold">
                    {latestReply.fields.agent_id || 'agent'} ·{' '}
                    {latestReply.fields.status || 'complete'}
                  </div>
                  <p className="line-clamp-5 text-muted">
                    {latestReply.fields.reply}
                  </p>
                  <p className="text-xs text-muted">
                    {shortId(latestReply.fields.intent_id)} ·{' '}
                    {latestReply.fields.model_id}
                  </p>
                </div>
              ) : latestProof ? (
                <div className="space-y-2 text-sm">
                  <div className="font-semibold">
                    {latestProof.fields.status || 'proof'}
                  </div>
                  <p className="text-muted">
                    {latestProof.fields.message || latestProof.fields.intent_id}
                  </p>
                  <p className="text-xs text-muted">
                    {shortId(latestProof.fields.intent_id)}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  Proof stream is waiting for the first routed command.
                </p>
              )}
            </Panel>

            <Panel title="Agent Pins">
              <div className="space-y-3">
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card2)] px-3 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold capitalize">{agent.id}</div>
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">
                        {agent.provider}
                      </div>
                    </div>
                    <div className="mt-1 text-sm text-muted">{agent.model}</div>
                    <div className="mt-1 text-xs text-muted">
                      {agent.modelId}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>

        {statusError ? (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {statusError}
          </div>
        ) : null}
      </div>
    </div>
  )
}
