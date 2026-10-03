import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAssistantMessageEventStream, createProvider, normalizeContext,
  type AssistantMessage, type Model, type Provider, type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterAll, describe, expect, it, vi } from 'vitest'

const previousAgentDir = process.env.PI_CODING_AGENT_DIR
const agentDir = mkdtempSync(join(tmpdir(), 'pi-multiprovider-failover-'))
process.env.PI_CODING_AGENT_DIR = agentDir
const { MultiAuthStore } = await import('../src/index.ts')
const { default: multiprovider } = await import('../extensions/multiprovider.ts')
const model: Model<'probe-api'> = {
  id: 'probe', name: 'Probe', api: 'probe-api', provider: 'failover-probe',
  baseUrl: 'https://probe.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100,
}
const store = new MultiAuthStore()
for (const [index, label] of ['udt', 'sc', 'zee'].entries()) {
  await store.addAccount(model.provider, {
    label, credential: { type: 'api_key', key: label }, priority: index + 1,
    pool: { policy: 'priority', includeUpstream: false },
  })
}
await store.updateSchedulerSettings({ errorsBeforeSwitch: 1 })
afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  rmSync(agentDir, { recursive: true, force: true })
})

function message(errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: errorMessage === undefined ? 'stop' : 'error',
    ...(errorMessage === undefined ? {} : { errorMessage }),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
}

async function launch({
  error = 'Codex error: The usage limit has been reached', exhausted = ['udt', 'sc'],
  fabric = true, visible = false, aborted = false,
} = {}) {
  const attempts: string[] = []
  const compact = vi.fn()
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>()
  const bus = new Map<string, Set<(value: unknown) => void>>()
  const stream = (_model: Model<'probe-api'>, _context: unknown, options?: SimpleStreamOptions) => {
    const account = options?.apiKey ?? 'upstream'
    attempts.push(account)
    const result = message(exhausted.includes(account) ? error : undefined)
    const events = createAssistantMessageEventStream()
    events.push({ type: 'start', partial: result })
    if (visible) events.push({ type: 'text_delta', contentIndex: 0, delta: 'visible', partial: result })
    if (aborted) {
      result.stopReason = 'aborted'
      events.push({ type: 'error', reason: 'aborted', error: result })
    } else if (result.stopReason === 'error') events.push({ type: 'error', reason: 'error', error: result })
    else events.push({ type: 'done', reason: 'stop', message: result })
    events.end(result)
    return events
  }
  let provider = createProvider<'probe-api'>({
    id: model.provider, name: 'Failover Probe', models: [model],
    auth: { apiKey: { name: 'Probe key', async resolve({ credential }) {
      return credential?.key !== undefined ? { auth: { apiKey: credential.key }, source: 'test' } : undefined
    } } },
    api: { stream, streamSimple: stream },
  }) as Provider<'probe-api'>
  const ctx = {
    cwd: agentDir, model, mode: 'tui', hasUI: true, isIdle: () => true, compact,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => 'probe-session', getEntries: () => [] },
    modelRegistry: {
      getProvider: () => provider, getAll: () => [model],
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
  } as unknown as ExtensionContext
  const pi = {
    events: {
      emit(name: string, value: unknown) { for (const fn of bus.get(name) ?? []) fn(value) },
      on(name: string, fn: (value: unknown) => void) {
        const listeners = bus.get(name) ?? new Set()
        listeners.add(fn); bus.set(name, listeners)
        return () => listeners.delete(fn)
      },
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { handlers.set(name, handler) },
    registerProvider(value: Provider<'probe-api'>) { provider = value },
    unregisterProvider() {}, registerCommand() {}, appendEntry() {},
    getAllTools: () => fabric ? [{ name: 'fabric_exec' }] : [],
  } as unknown as ExtensionAPI
  await multiprovider(pi)
  await handlers.get('session_start')!({}, ctx)
  const events = []
  for await (const event of provider.streamSimple(model, normalizeContext({ messages: [] }))) events.push(event)
  return { attempts, compact, events }
}

describe('Fabric account failover handoff', () => {
  it('continues the same request through two quota-exhausted accounts to the third', async () => {
    const run = await launch()
    expect(run.attempts).toEqual(['udt', 'sc', 'zee'])
    expect(run.events.map(event => event.type)).toEqual(['start', 'done'])
    expect(run.compact).not.toHaveBeenCalled()
  })

  it('rotates inline for authentication failures that Pi will not retry', async () => {
    const run = await launch({ error: 'HTTP 401: invalid token' })
    expect(run.attempts).toEqual(['udt', 'sc', 'zee'])
    expect(run.events.at(-1)?.type).toBe('done')
    expect(run.compact).not.toHaveBeenCalled()
  })

  it('preserves existing inline failover when Fabric is unavailable', async () => {
    const run = await launch({ fabric: false })
    expect(run.attempts).toEqual(['udt', 'sc', 'zee'])
    expect(run.events.at(-1)?.type).toBe('done')
  })

  it('still surfaces transient errors for host retry and compaction', async () => {
    const run = await launch({ error: 'HTTP 429: too many requests' })
    expect(run.attempts).toEqual(['udt'])
    expect(run.events.at(-1)?.type).toBe('error')
    await vi.waitFor(() => expect(run.compact).toHaveBeenCalledOnce())
  })

  it('stops after trying every exhausted account once', async () => {
    const run = await launch({ exhausted: ['udt', 'sc', 'zee'] })
    expect(run.attempts).toEqual(['udt', 'sc', 'zee'])
    expect(run.events.at(-1)?.type).toBe('error')
    expect(run.compact).not.toHaveBeenCalled()
  })

  it.each([{ visible: true }, { aborted: true }])('does not replay visible or aborted output: %j', async options => {
    const run = await launch(options)
    expect(run.attempts).toEqual(['udt'])
    expect(run.events.at(-1)?.type).toBe('error')
    expect(run.compact).not.toHaveBeenCalled()
  })
})
