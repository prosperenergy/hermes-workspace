import { useMemo, useState } from 'react'
import type { NavigateOptions, RegisteredRouter } from '@tanstack/react-router'

type NavigateFn = (options: NavigateOptions<RegisteredRouter>) => void

type ProsperCockpitResponse = {
  ok: boolean
  models?: {
    ok: boolean
    count: number
    sample: Array<string>
    error: string | null
  }
  agents?: {
    updatedAt: string | null
    agents: Array<{
      id: string
      provider: string
      modelId: string
      model: string
      fallbacks?: Array<{ model: string; modelId: string; provider: string }>
    }>
  }
  actions?: Array<{
    id: string
    label: string
    prompt: string
  }>
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function writeNewChatDraft(message: string) {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem('claude-draft-new', message)
}

function createOptimisticUserMessage(message: string) {
  const clientId = crypto.randomUUID()
  const timestamp = Date.now()
  return {
    role: 'user',
    content: [{ type: 'text', text: message }],
    __optimisticId: `opt-${clientId}`,
    __createdAt: timestamp,
    clientId,
    client_id: clientId,
    status: 'sending',
    timestamp,
  }
}

function writePendingMainSend(message: string) {
  if (typeof window === 'undefined') return
  const optimisticMessage = createOptimisticUserMessage(message)
  window.localStorage.setItem(
    'claude_pending_msg_main',
    JSON.stringify({
      sessionKey: 'main',
      friendlyId: 'main',
      message,
      attachments: [],
      optimisticMessage,
      storedAt: Date.now(),
    }),
  )
}

function routeToChat(navigate: NavigateFn, message: string) {
  writeNewChatDraft(message)
  navigate({ to: '/chat/$sessionKey', params: { sessionKey: 'new' } })
}

async function routeIntent(message: string): Promise<string> {
  const response = await fetch('/api/prosper-cockpit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: message }),
  })
  if (!response.ok) {
    throw new Error(`Router failed (${response.status})`)
  }
  const payload = (await response.json()) as {
    routed?: { routedMessage?: string }
  }
  return payload.routed?.routedMessage || message
}

function modelLabel(modelId: string, model: string): string {
  if (model && model !== modelId) return `${model} (${modelId})`
  return modelId || model
}

export function ProsperCommandCard({
  data,
  navigate,
}: {
  data: ProsperCockpitResponse | null
  navigate: NavigateFn
}) {
  const [command, setCommand] = useState('')
  const [routerError, setRouterError] = useState('')
  const [isRouting, setIsRouting] = useState(false)
  const agents = data?.agents?.agents ?? []
  const actions = data?.actions ?? []
  const modelStatus = data?.models

  const defaultPrompt = useMemo(() => {
    return (
      actions[0]?.prompt ??
      'Sam, do this end to end. Verify first, make the change, test it, and report back:'
    )
  }, [actions])

  const canOpen = command.trim().length > 0

  async function executeCommand() {
    const intent = command.trim()
    if (!intent || isRouting) return
    setRouterError('')
    setIsRouting(true)
    try {
      const routedMessage = await routeIntent(intent)
      writePendingMainSend(routedMessage)
      navigate({ to: '/chat/$sessionKey', params: { sessionKey: 'main' } })
    } catch (error) {
      setRouterError(error instanceof Error ? error.message : String(error))
      routeToChat(navigate, intent)
    } finally {
      setIsRouting(false)
    }
  }

  return (
    <section
      className="grid grid-cols-1 gap-3 rounded-xl border p-4 lg:grid-cols-12"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--theme-card) 92%, transparent), color-mix(in srgb, var(--theme-accent) 6%, var(--theme-card)))',
        borderColor: 'var(--theme-border)',
      }}
    >
      <div className="lg:col-span-7">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold" style={{ color: 'var(--theme-text)' }}>
              PROSPER OS Command
            </h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>
              Type the job here. Prosper OS picks the agent, adds that agent's
              model pin and tool context, then sends it into the execution lane.
            </p>
          </div>
          <div
            className="rounded-lg border px-3 py-2 text-right"
            style={{
              borderColor: 'var(--theme-border)',
              background: 'color-mix(in srgb, var(--theme-card2) 70%, transparent)',
            }}
          >
            <div
              className="text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{ color: 'var(--theme-muted)' }}
            >
              Gateway
            </div>
            <div
              className="font-mono text-lg font-bold leading-none"
              style={{ color: modelStatus?.ok ? 'var(--theme-success)' : 'var(--theme-danger)' }}
            >
              {modelStatus?.ok ? `${modelStatus.count} models` : 'offline'}
            </div>
          </div>
        </div>

        <textarea
          value={command}
          onChange={(event) => setCommand(event.currentTarget.value)}
          placeholder={`${defaultPrompt}\n\nExample: Build the GHL solar lead flow from new lead to install handoff.`}
          className="min-h-[132px] w-full resize-y rounded-lg border px-3 py-3 text-sm outline-none transition-colors focus:border-[var(--theme-accent)]"
          style={{
            borderColor: 'var(--theme-border)',
            background: 'var(--theme-bg)',
            color: 'var(--theme-text)',
          }}
        />

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canOpen || isRouting}
            onClick={() => void executeCommand()}
            className="rounded-lg px-4 py-2 text-sm font-semibold uppercase tracking-[0.05em] transition-all disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background:
                'linear-gradient(135deg, var(--theme-accent), var(--theme-accent-secondary))',
              color: 'var(--theme-on-accent, white)',
            }}
          >
            {isRouting ? 'Routing...' : 'Run Intent'}
          </button>
          <button
            type="button"
            onClick={() => navigate({ to: '/terminal' })}
            className="rounded-lg border px-4 py-2 text-sm font-semibold uppercase tracking-[0.05em]"
            style={{
              borderColor: 'var(--theme-border)',
              color: 'var(--theme-text)',
              background: 'var(--theme-card)',
            }}
          >
            Terminal
          </button>
          <button
            type="button"
            onClick={() => navigate({ to: '/settings', search: {} })}
            className="rounded-lg border px-4 py-2 text-sm font-semibold uppercase tracking-[0.05em]"
            style={{
              borderColor: 'var(--theme-border)',
              color: 'var(--theme-text)',
              background: 'var(--theme-card)',
            }}
          >
            Settings
          </button>
        </div>

        {routerError ? (
          <p className="mt-2 text-xs" style={{ color: 'var(--theme-warning)' }}>
            Router fallback used: {routerError}
          </p>
        ) : null}

        {actions.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() =>
                  setCommand((current) =>
                    current.trim()
                      ? `${action.prompt}\n\n${current.trim()}`
                      : `${action.prompt}\n\n`,
                  )
                }
                className="rounded-full border px-3 py-1.5 text-xs font-medium"
                style={{
                  borderColor: 'var(--theme-border)',
                  color: 'var(--theme-muted)',
                  background: 'color-mix(in srgb, var(--theme-card2) 75%, transparent)',
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="lg:col-span-5">
        <div
          className="h-full rounded-lg border p-3"
          style={{
            borderColor: 'var(--theme-border)',
            background: 'color-mix(in srgb, var(--theme-bg) 78%, transparent)',
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3
              className="text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{ color: 'var(--theme-muted)' }}
            >
              Agent Pins
            </h3>
            <span
              className="font-mono text-[10px]"
              style={{ color: 'var(--theme-muted)' }}
            >
              {agents.length || 0} active
            </span>
          </div>
          <div className="space-y-2">
            {agents.slice(0, 6).map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => {
                  const prompt = `${titleCase(agent.id)}, ${defaultPrompt}\n\n`
                  setCommand(prompt)
                }}
                className="block w-full rounded-lg border px-3 py-2 text-left transition-colors hover:border-[var(--theme-accent)]"
                style={{
                  borderColor: 'var(--theme-border)',
                  background: 'var(--theme-card)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-sm font-semibold"
                    style={{ color: 'var(--theme-text)' }}
                  >
                    {titleCase(agent.id)}
                  </span>
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.1em]"
                    style={{
                      background:
                        'color-mix(in srgb, var(--theme-accent) 12%, transparent)',
                      color: 'var(--theme-accent)',
                    }}
                  >
                    {agent.provider}
                  </span>
                </div>
                <div
                  className="mt-1 truncate text-xs"
                  style={{ color: 'var(--theme-muted)' }}
                >
                  {modelLabel(agent.modelId, agent.model)}
                </div>
              </button>
            ))}
          </div>
          {modelStatus?.error ? (
            <p className="mt-3 text-xs" style={{ color: 'var(--theme-danger)' }}>
              {modelStatus.error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
