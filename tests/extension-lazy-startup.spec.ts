import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

// Interactive UI modules must stay off the idle startup path: they load at the
// first /multilogin or /vprovider, never at import, factory or session_start.
const loaded = vi.hoisted(() => new Set<string>())
vi.mock('../extensions/pool-manager.ts', async importOriginal => {
  loaded.add('pool-manager')
  return await importOriginal()
})
vi.mock('../extensions/settings-ui.ts', async importOriginal => {
  loaded.add('settings-ui')
  return await importOriginal()
})
vi.mock('../extensions/virtual-editor.ts', async importOriginal => {
  loaded.add('virtual-editor')
  return await importOriginal()
})
vi.mock('../src/multilogin.ts', async importOriginal => {
  loaded.add('multilogin')
  return await importOriginal()
})

const agentDir = mkdtempSync(join(tmpdir(), 'pi-multiprovider-lazy-'))
process.env.PI_CODING_AGENT_DIR = agentDir

const { MultiAuthStore } = await import('../src/auth-store.ts')

const catalog: Model<'probe-api'>[] = ['alpha', 'beta', 'gamma'].map(id => ({
  id,
  name: id,
  api: 'probe-api',
  provider: 'example',
  baseUrl: 'https://example.invalid',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4_000,
  maxTokens: 400,
}))

let catalogReads = 0
const raw = createProvider<'probe-api'>({
  id: 'example',
  name: 'Example',
  auth: { apiKey: { name: 'Example API key', async resolve() { return undefined } } },
  models: catalog,
  api: {
    stream() { throw new Error('not used') },
    streamSimple() { throw new Error('not used') },
  },
}) as Provider<'probe-api'>
const base: Provider<'probe-api'> = {
  ...raw,
  getModels() {
    catalogReads += 1
    return raw.getModels()
  },
}

const store = new MultiAuthStore()
await store.addAccount('example', { label: 'Work', credential: { type: 'api_key', key: 'k-work' } })
// A virtual provider persisted with no templates: its models must still be
// registered at factory time, resolved from the live backing catalog.
await store.saveVirtualProvider({
  id: 'pooled',
  label: 'Pooled',
  models: catalog.map(model => ({ id: `v-${model.id}`, backends: [{ providerId: 'example', modelId: model.id }] })),
})

interface Harness {
  registry: Map<string, Provider<'probe-api'>>
  ctx: ExtensionContext
  customs: unknown[]
  customResults: unknown[]
  notifications: string[]
  start(): Promise<void>
  stop(): Promise<void>
  command(name: string, args: string): Promise<void>
}

const theme = new Proxy({}, {
  get: (_target, key) => key === 'then' ? undefined : (...args: unknown[]) => String(args.at(-1) ?? ''),
})

async function launch(): Promise<Harness> {
  const registry = new Map<string, Provider<'probe-api'>>([[base.id, base]])
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]>()
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
  const customs: unknown[] = []
  const customResults: unknown[] = []
  const notifications: string[] = []
  const ctx = {
    ui: {
      notify(message: string) { notifications.push(message) },
      async select() { return undefined },
      async input() { return undefined },
      async confirm() { return false },
      async custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown) {
        const component = factory({ requestRender() {} }, theme, {}, () => {})
        customs.push(component)
        return customResults.shift()
      },
    },
    mode: 'tui',
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => 'session-lazy', getEntries: () => [] },
    modelRegistry: {
      getProvider: (id: string) => registry.get(id),
      getAll: () => [...registry.values()].flatMap(provider => provider.getModels()),
      getApiKeyAndHeaders: async () => ({ ok: true }),
      getProviderAuthStatus: () => ({ configured: true }),
    },
    model: undefined,
    isIdle: () => true,
  } as unknown as ExtensionContext
  const pi = {
    events: { emit() {}, on() { return () => {} } },
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerProvider(provider: Provider<'probe-api'>) { registry.set(provider.id, provider) },
    unregisterProvider(id: string) { registry.delete(id) },
    getAllTools: () => [],
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def)
    },
    appendEntry() {},
  }
  const { default: multiprovider } = await import('../extensions/multiprovider.ts')
  await multiprovider(pi as unknown as ExtensionAPI)
  return {
    registry,
    ctx,
    customs,
    customResults,
    notifications,
    async start() {
      for (const handler of handlers.get('session_start') ?? []) await handler({ type: 'session_start', reason: 'startup' }, ctx)
    },
    async stop() {
      for (const handler of handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx)
    },
    async command(name, args) {
      const command = commands.get(name)
      if (command === undefined) throw new Error(`/${name} is not registered`)
      await command.handler(args, ctx)
    },
  }
}

describe('idle startup', () => {
  it('registers restored models before readiness without loading interactive UI', async () => {
    await import('../extensions/multiprovider.ts')
    expect([...loaded]).toEqual([])

    const metadata = (harness: Harness) => harness.registry.get('pooled')?.getModels()
      .map(model => [model.id, model.contextWindow, model.reasoning])

    const first = await launch()
    // Factory registration alone exposes the restored virtual models before
    // session_start; with no persisted template the metadata is the default.
    expect(metadata(first)?.map(([id]) => id)).toEqual(['v-alpha', 'v-beta', 'v-gamma'])

    await first.start()
    // session_start installs the pooled lift for the stored provider, heals
    // the templates from the live catalog, and keeps the models registered.
    const lifted = first.registry.get('example')
    expect(lifted).toBeDefined()
    expect(lifted).not.toBe(base)
    expect(metadata(first)).toEqual([
      ['v-alpha', 4_000, true],
      ['v-beta', 4_000, true],
      ['v-gamma', 4_000, true],
    ])
    const persisted = await store.getVirtualProvider('pooled')
    expect(persisted?.models.every(model => model.backends[0]?.template?.contextWindow === 4_000)).toBe(true)
    await first.stop()

    // The next load restores the healed metadata at factory time, before
    // session_start and before the backing provider is lifted.
    const second = await launch()
    expect(metadata(second)).toEqual([
      ['v-alpha', 4_000, true],
      ['v-beta', 4_000, true],
      ['v-gamma', 4_000, true],
    ])
    await second.start()
    await second.stop()
    expect([...loaded]).toEqual([])
    expect(first.notifications).toEqual([])
    expect(second.notifications).toEqual([])
  })

  it('reads each backing catalog once per virtual catalog read', async () => {
    const harness = await launch()
    await harness.start()
    const virtual = harness.registry.get('pooled')!
    catalogReads = 0
    expect(virtual.getModels()).toHaveLength(3)
    expect(catalogReads).toBe(1)
    await harness.stop()
  })
})

describe('interactive commands load their UI at first use', () => {
  it('/multilogin opens the pool manager', async () => {
    const harness = await launch()
    await harness.start()
    harness.customResults.push({ type: 'closed' })
    await harness.command('multilogin', 'example')
    expect(loaded.has('multilogin')).toBe(true)
    expect(loaded.has('pool-manager')).toBe(true)
    expect(harness.customs).toHaveLength(1)
    const component = harness.customs[0] as { render(width: number): string[] }
    expect(component.render(80).join('\n')).toContain('1 stored account')
    await harness.stop()
  })

  it('/vprovider opens the virtual provider editor', async () => {
    const harness = await launch()
    await harness.start()
    harness.customResults.push({ kind: 'dismissed' })
    await harness.command('vprovider', '')
    expect(loaded.has('virtual-editor')).toBe(true)
    expect(harness.customs).toHaveLength(1)
    const component = harness.customs[0] as { render(width: number): string[] }
    expect(component.render(80).join('\n')).toContain('pooled')
    await harness.stop()
  })
})
