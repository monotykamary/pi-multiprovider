import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

const agentDir = mkdtempSync(join(tmpdir(), 'pi-multiprovider-composed-'))
process.env.PI_CODING_AGENT_DIR = agentDir

const { MultiAuthStore } = await import('../src/index.ts')
const { default: multiprovider } = await import('../extensions/multiprovider.ts')

const model: Model<'probe-api'> = {
  id: 'probe-model',
  name: 'Probe Model',
  api: 'probe-api',
  provider: 'example',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

const done: AssistantMessage = {
  role: 'assistant',
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 0,
}

// The API keys the real base provider was called with, in order.
const served: (string | undefined)[] = []
const stream = (_model: unknown, _context: unknown, options?: SimpleStreamOptions) => {
  served.push(options?.apiKey)
  const events = createAssistantMessageEventStream()
  queueMicrotask(() => {
    events.push({ type: 'done', reason: 'stop', message: done })
    events.end(done)
  })
  return events
}

// A plain provider (not createProvider) so the stream sees exactly the API key
// the lift chose instead of re-resolving its own.
const base = {
  id: 'example',
  name: 'Example',
  auth: {
    apiKey: {
      name: 'Example API key',
      async resolve(input: { credential?: { key?: string } }) {
        return { auth: { apiKey: input.credential?.key ?? 'k-default' } }
      },
    },
  },
  getModels: () => [model],
  stream,
  streamSimple: stream,
} as unknown as Provider<'probe-api'>

await new MultiAuthStore().addAccount('example', { label: 'Work', credential: { type: 'api_key', key: 'k-work' } })

// Mirrors Pi's model runtime when models.json (or another extension) overlays
// the provider: registerProvider stores the native provider, and getProvider
// returns a freshly composed object that delegates to it and shares only its
// headers by reference.
function composedRegistry() {
  let native: Provider<'probe-api'> = base
  const compose = (provider: Provider<'probe-api'>): Provider<'probe-api'> => ({
    id: provider.id,
    name: provider.name,
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    auth: provider.auth,
    getModels: () => provider.getModels(),
    stream: (m, c, o) => provider.stream(m, c, o),
    streamSimple: (m, c, o) => provider.streamSimple(m, c, o),
  })
  let current = compose(native)
  return {
    registrations: 0,
    register(provider: Provider<'probe-api'>) {
      this.registrations += 1
      native = provider
      current = compose(native)
    },
    get: (id: string) => (id === base.id ? current : undefined),
  }
}

describe('provider composition', () => {
  it('lifts the base once when the registry returns a composed wrapper', async () => {
    const registry = composedRegistry()
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]>()
    const ctx = {
      ui: { notify() {} },
      mode: 'print',
      hasUI: false,
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => 'session-1', getEntries: () => [] },
      modelRegistry: { getProvider: registry.get, getAll: () => [model] },
      model,
      isIdle: () => true,
    } as unknown as ExtensionContext
    const pi = {
      events: { emit() {}, on: () => () => {} },
      on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])
      },
      registerProvider: (provider: Provider<'probe-api'>) => registry.register(provider),
      unregisterProvider() {},
      getAllTools: () => [],
      registerCommand() {},
      appendEntry() {},
    }
    await multiprovider(pi as unknown as ExtensionAPI)
    for (const name of ['session_start', 'before_agent_start', 'before_agent_start']) {
      for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx)
    }

    expect(registry.registrations).toBe(1)

    // Resolve auth the way Pi does, then stream through the registry's provider.
    const provider = registry.get('example')!
    const resolved = await provider.auth.apiKey!.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal: new AbortController().signal,
    } as never)
    await provider.streamSimple(model, normalizeContext({ messages: [] }), {
      apiKey: resolved!.auth.apiKey!,
      headers: resolved!.auth.headers!,
    }).result()

    // A second lift would strip the upstream marker and skip Pi's own
    // credential in favour of the stored account.
    expect(served).toEqual(['k-default'])
  })
})
