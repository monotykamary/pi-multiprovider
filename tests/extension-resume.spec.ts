import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, normalizeContext, type Model, type Provider } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

// The extension reads its credential store and the session manager at load and
// session start, so the harness points Pi's agent dir at a scratch directory
// before anything constructs a store.
const agentDir = mkdtempSync(join(tmpdir(), 'pi-multiprovider-resume-'))
process.env.PI_CODING_AGENT_DIR = agentDir

const { MULTIPROVIDER_SERVICE_EVENT } = await import('../src/types.ts')
const { MultiAuthStore, SESSION_PIN_ENTRY_TYPE } = await import('../src/index.ts')
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

const base = createProvider<'probe-api'>({
  id: 'example',
  name: 'Example',
  auth: { apiKey: { name: 'Example API key', async resolve() { return undefined } } },
  models: [model],
  api: {
    stream() { throw new Error('not used') },
    streamSimple() { throw new Error('not used') },
  },
}) as Provider<'probe-api'>

const store = new MultiAuthStore()
await store.addAccount('example', { label: 'Work', credential: { type: 'api_key', key: 'k-work' } })
await store.addAccount('example', { label: 'Personal', credential: { type: 'api_key', key: 'k-personal' } })
const seeded = (await store.getPool('example'))!.accounts.map(account => ({
  id: account.id,
  label: account.label,
}))
const personal = seeded.find(account => account.label === 'Personal')!

interface AccountChangedEvent {
  providerId: string
  account: unknown
  ctx: ExtensionContext
}

interface Announcement {
  getActiveAccount(providerId: string, ctx: ExtensionContext): Promise<unknown>
  onActiveAccountChanged(
    providerId: string,
    callback: (event: AccountChangedEvent) => void,
  ): () => void
}

interface ExtensionHarness {
  entries: unknown[]
  notifications: string[]
  providers: Provider<'probe-api'>[]
  accountChanges: AccountChangedEvent[]
  ctx: ExtensionContext & { model?: Model<'probe-api'> }
  active(poolId: string): Promise<unknown>
  start(): Promise<void>
  stop(): Promise<void>
  switchAccount(args: string): Promise<void>
}

// Boots the real bundled extension against duck-typed Pi APIs: provider
// registration, the event bus, session entries, and the TUI context surface
// that /switch-account and session_start touch.
// `registry` stands in for Pi's provider registry; sessions of one process,
// subagents included, share it.
async function launch(
  initialEntries: readonly unknown[],
  registry = new Map<string, Provider<'probe-api'>>([[base.id, base]]),
): Promise<ExtensionHarness> {
  const entries: unknown[] = [...initialEntries]
  const notifications: string[] = []
  const providers: Provider<'probe-api'>[] = []
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]>()
  const bus = new Map<string, Set<(value: unknown) => void>>()
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
  const accountChanges: AccountChangedEvent[] = []
  let announcement: Announcement | undefined
  let unsubscribeAccountChanges: (() => void) | undefined

  const ctx = {
    ui: {
      notify(message: string) { notifications.push(message) },
      async select() { return undefined },
      async input() { return undefined },
      async confirm() { return false },
      async custom() { return undefined },
    },
    mode: 'tui',
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => 'session-1', getEntries: () => entries },
    modelRegistry: {
      getProvider: (id: string) => registry.get(id),
      getAll: () => [model],
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
    model: undefined as Model<'probe-api'> | undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => '',
  } as unknown as ExtensionHarness['ctx']

  const pi = {
    events: {
      emit(name: string, value: unknown) { for (const callback of bus.get(name) ?? []) callback(value) },
      on(name: string, callback: (value: unknown) => void) {
        const listeners = bus.get(name) ?? new Set<(value: unknown) => void>()
        listeners.add(callback)
        bus.set(name, listeners)
        return () => listeners.delete(callback)
      },
    },
    on(name: string, handler: () => Promise<void> | void) {
      const list = handlers.get(name) ?? []
      list.push(handler as (event: unknown, ctx: unknown) => Promise<void> | void)
      handlers.set(name, list)
    },
    registerProvider(provider: Provider<'probe-api'>) {
      providers.push(provider)
      registry.set(provider.id, provider)
    },
    unregisterProvider(id: string) { registry.delete(id) },
    getAllTools: () => [],
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def)
    },
    // Mirrors pi: appendEntry writes a custom entry into the session file.
    appendEntry(customType: string, data?: unknown) {
      entries.push({
        type: 'custom',
        customType,
        data,
        id: 'entry-' + (entries.length + 1),
        parentId: null,
        timestamp: new Date().toISOString(),
      })
    },
  }

  // Mirrors pi-better-openai: the service event re-fires with the same stable
  // object, so the identity check keeps the change subscription attached once.
  bus.set(MULTIPROVIDER_SERVICE_EVENT, new Set([(value: unknown) => {
    const service = value as Announcement
    if (service === announcement || typeof service?.onActiveAccountChanged !== 'function') return
    unsubscribeAccountChanges?.()
    announcement = service
    unsubscribeAccountChanges = service.onActiveAccountChanged('example', event => {
      accountChanges.push(event)
    })
  }]))
  await multiprovider(pi as unknown as ExtensionAPI)
  if (announcement === undefined) throw new Error('extension did not announce its service')

  return {
    entries,
    providers,
    notifications,
    accountChanges,
    ctx,
    active: poolId => announcement!.getActiveAccount(poolId, ctx),
    async start() {
      ctx.model = model
      for (const handler of handlers.get('session_start') ?? []) {
        await handler({ type: 'session_start', reason: 'startup' }, ctx)
      }
    },
    async stop() {
      for (const handler of handlers.get('session_shutdown') ?? []) {
        await handler({ type: 'session_shutdown', reason: 'quit' }, ctx)
      }
    },
    async switchAccount(args) {
      const command = commands.get('switch-account')
      if (command === undefined) throw new Error('/switch-account is not registered')
      await command.handler(args, ctx)
    },
  }
}

function journal(entries: readonly unknown[]): unknown[] {
  return entries
    .filter((entry): entry is { customType: string; data: unknown } =>
      typeof entry === 'object'
      && entry !== null
      && (entry as { customType?: string }).customType === SESSION_PIN_ENTRY_TYPE)
    .map(entry => entry.data)
}

describe('/switch-account survival across resume', () => {
  it('journals a switch in the session and restores it when a fresh runtime resumes', async () => {
    const live = await launch([])
    await live.start()
    expect(await live.active('example')).toBeUndefined()
    await live.switchAccount('personal')
    expect(journal(live.entries)).toEqual([
      { pool: 'example', key: 'session-1', accountId: personal.id, label: 'Personal' },
    ])
    expect(await live.active('example')).toEqual({
      id: personal.id, label: 'Personal', authKind: 'api-key',
    })
    expect(live.accountChanges.map(event => event.account)).toEqual([
      { id: personal.id, label: 'Personal', authKind: 'api-key' },
    ])
    const sessionFile = structuredClone(live.entries)

    // Resuming spawns a new extension runtime and scheduler; only the session
    // journal carries the switch across.
    const resumed = await launch(sessionFile)
    await resumed.start()
    expect(await resumed.active('example')).toEqual({
      id: personal.id, label: 'Personal', authKind: 'api-key',
    })
    // The replay reaches followers of the active account, so a usage widget
    // repaints from the resumed account without waiting for its own poll.
    expect(resumed.accountChanges.map(event => [event.providerId, event.account])).toEqual([
      ['example', { id: personal.id, label: 'Personal', authKind: 'api-key' }],
    ])
    expect(resumed.accountChanges[0]!.ctx).toBe(resumed.ctx)
    expect(resumed.notifications.filter(message => message.includes('could not be restored'))).toEqual([])
  })

  it('stays automatic without a journal and does not resurrect a cleared pin', async () => {
    const plain = await launch([])
    await plain.start()
    expect(await plain.active('example')).toBeUndefined()

    const live = await launch([])
    await live.start()
    await live.switchAccount('personal')
    await live.switchAccount('auto')
    expect(await live.active('example')).toBeUndefined()

    const afterClear = await launch(live.entries)
    await afterClear.start()
    expect(await afterClear.active('example')).toBeUndefined()
    // A cleared decision replays as "automatic", so followers drop the account
    // the session used before instead of keeping it on screen.
    expect(afterClear.accountChanges.map(event => event.account)).toEqual([undefined])
  })

  it('falls back to automatic and warns when the pinned account is gone', async () => {
    const removed = new MultiAuthStore(join(agentDir, 'multiprovider-auth.json'))
    const pinned = await launch([{
      type: 'custom',
      customType: SESSION_PIN_ENTRY_TYPE,
      data: { pool: 'example', key: 'session-1', accountId: 'deleted-account', label: 'Deleted' },
      id: 'entry-1',
      parentId: null,
      timestamp: new Date().toISOString(),
    }])
    await pinned.start()
    expect(await pinned.active('example')).toBeUndefined()
    expect(pinned.notifications.filter(message => message.includes('"Deleted" could not be restored'))).toHaveLength(1)
    expect(pinned.accountChanges).toEqual([])
    expect(await removed.listProviderIds()).toContain('example')
  })

  it('rebinds PI_MULTIPROVIDER_SESSION_PINS onto the child session when no journal exists', async () => {
    const previous = process.env.PI_MULTIPROVIDER_SESSION_PINS
    process.env.PI_MULTIPROVIDER_SESSION_PINS = JSON.stringify([
      { pool: 'example', accountId: personal.id, label: 'Personal' },
    ])
    try {
      const child = await launch([])
      child.ctx.sessionManager.getSessionId = () => 'child-session'
      await child.start()
      expect(await child.active('example')).toEqual({
        id: personal.id, label: 'Personal', authKind: 'api-key',
      })
      expect(journal(child.entries)).toEqual([
        { pool: 'example', key: 'child-session', accountId: personal.id, label: 'Personal' },
      ])
    } finally {
      if (previous === undefined) delete process.env.PI_MULTIPROVIDER_SESSION_PINS
      else process.env.PI_MULTIPROVIDER_SESSION_PINS = previous
    }
  })

  it('lets the child session journal win over inherited env pins', async () => {
    const previous = process.env.PI_MULTIPROVIDER_SESSION_PINS
    process.env.PI_MULTIPROVIDER_SESSION_PINS = JSON.stringify([
      { pool: 'example', accountId: personal.id, label: 'Personal' },
    ])
    try {
      const child = await launch([{
        type: 'custom',
        customType: SESSION_PIN_ENTRY_TYPE,
        data: { pool: 'example', key: 'child-session' },
        id: 'entry-1',
        parentId: null,
        timestamp: new Date().toISOString(),
      }])
      await child.start()
      expect(await child.active('example')).toBeUndefined()
      expect(journal(child.entries)).toEqual([{ pool: 'example', key: 'child-session' }])
    } finally {
      if (previous === undefined) delete process.env.PI_MULTIPROVIDER_SESSION_PINS
      else process.env.PI_MULTIPROVIDER_SESSION_PINS = previous
    }
  })

  it('hands the registry to the newest live lift in whatever order sessions end', async () => {
    // Earlier tests leave their sessions running; start from a clean process.
    (globalThis as unknown as Record<symbol, Map<string, unknown>>)[
      Symbol.for('pi-multiprovider.live-providers')
    ]?.delete(base.id)
    const registry = new Map<string, Provider<'probe-api'>>([[base.id, base]])
    const parent = await launch([], registry)
    await parent.start()
    const first = await launch([], registry)
    await first.start()
    const second = await launch([], registry)
    await second.start()
    const request = async () =>
      (await registry.get(base.id)!.streamSimple(model, normalizeContext({ messages: [] })).result()).errorMessage

    // Pi-subagents disposes finished subagents on a timer, oldest first.
    await first.stop()
    expect(await request()).not.toMatch(/unknown provider|stale/)
    await second.stop()
    expect(registry.get(base.id)).toBe(parent.providers.at(-1))
    expect(await request()).not.toMatch(/unknown provider|stale/)
  })

  it('keeps the parent virtual provider registered when a subagent session ends', async () => {
    await store.saveVirtualProvider({
      id: 'pooled',
      label: 'Pooled',
      models: [{ id: 'ultra', backends: [{ providerId: base.id, modelId: model.id }] }],
    })
    try {
      const registry = new Map<string, Provider<'probe-api'>>([[base.id, base]])
      const parent = await launch([], registry)
      await parent.start()
      const child = await launch([], registry)
      await child.start()

      await child.stop()
      expect(registry.get('pooled')).toBe(parent.providers.findLast(provider => provider.id === 'pooled'))
      await parent.stop()
      expect(registry.has('pooled')).toBe(false)
    } finally {
      await store.removeVirtualProvider('pooled')
    }
  })
})

describe('provider callbacks after the session context goes stale', () => {
  // A Pi subagent loads the extension into a child session that shares the
  // parent's provider registry. Once pi disposes that session, every getter on
  // its context throws, but the provider it lifted can still serve requests.
  it('keeps the lifted provider usable', async () => {
    const live = await launch([])
    await live.start()
    const lifted = live.providers.findLast(provider => provider.id === base.id && provider !== base)
    expect(lifted).toBeDefined()
    for (const key of ['sessionManager', 'modelRegistry'] as const) {
      Object.defineProperty(live.ctx, key, {
        get() { throw new Error('This extension ctx is stale') },
      })
    }

    const result = await lifted!.streamSimple(model, normalizeContext({ messages: [] })).result()
    expect(result.errorMessage).not.toMatch(/stale/)
  })
})
