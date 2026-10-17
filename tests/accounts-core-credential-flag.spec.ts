import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai'
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { liveUpstreamConfigured, MULTIPOOL_AUTH_SOURCE, type UpstreamAuthStatus } from '../src/multilogin.ts'

// The extension reads its credential store from the agent dir when the command
// runs, so the harness points Pi at a scratch directory before that store exists.
const agentDir = mkdtempSync(join(tmpdir(), 'pi-multiprovider-accounts-flag-'))
process.env.PI_CODING_AGENT_DIR = agentDir

const { MultiAuthStore } = await import('../src/index.ts')
const { default: multiprovider } = await import('../extensions/multiprovider.ts')

const FLAG = 'no live core /login credential'

const model: Model<'openai-completions'> = {
  id: 'probe-model',
  name: 'Probe Model',
  api: 'openai-completions',
  provider: 'example',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

const base = createProvider<'openai-completions'>({
  id: 'example',
  name: 'Example',
  auth: { apiKey: { name: 'Example API key', async resolve() { return undefined } } },
  models: [model],
  api: {
    stream() { throw new Error('not used') },
    streamSimple() { throw new Error('not used') },
  },
}) as Provider<'openai-completions'>

const store = new MultiAuthStore()
await store.addAccount('example', { label: 'Work', credential: { type: 'api_key', key: 'k-work' } })

const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: null,
  modelsStorePath: join(agentDir, 'models-cache'),
  allowModelNetwork: false,
  refreshOnCreate: false,
})
const registry = new ModelRegistry(runtime)
runtime.registerNativeProvider(base)

const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>()
const pi = {
  events: {
    emit() {},
    on() { return () => {} },
  },
  on() {},
  registerProvider(providerOrName: Provider | string, config?: Parameters<ModelRegistry['registerProvider']>[1]) {
    if (typeof providerOrName === 'string') {
      if (config === undefined) throw new Error('provider config required')
      registry.registerProvider(providerOrName, config)
      return
    }
    registry.registerProvider(providerOrName)
  },
  unregisterProvider(name: string) { registry.unregisterProvider(name) },
  getAllTools: () => [],
  registerCommand(name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
    commands.set(name, def)
  },
  appendEntry() {},
}
await multiprovider(pi as unknown as ExtensionAPI)

function contextFor(modelRegistry: ExtensionContext['modelRegistry']): ExtensionContext {
  return {
    ui: {
      notify() {},
      async select(_title: string, lines: string[]) { return lines[0] },
      async input() { return undefined },
      async confirm() { return false },
      async custom() { return undefined },
    },
    mode: 'tui',
    hasUI: true,
    cwd: agentDir,
    sessionManager: { getSessionId: () => 'session-1', getEntries: () => [] },
    modelRegistry,
    model,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => '',
  } as unknown as ExtensionContext
}

async function accountsLines(modelRegistry: ExtensionContext['modelRegistry'] = registry): Promise<string[]> {
  let selected: string[] = []
  const ctx = contextFor(modelRegistry)
  const original = ctx.ui.select.bind(ctx.ui)
  ctx.ui.select = async (title, options) => {
    if (Array.isArray(options) && options.every(option => typeof option === 'string')) selected = options
    return original(title, options)
  }
  const command = commands.get('accounts')
  if (command === undefined) throw new Error('/accounts is not registered')
  await command.handler('', ctx)
  return selected
}

function section(lines: string[], providerId: string): string[] {
  const start = lines.findIndex(line => line.includes(`(${providerId})`))
  if (start < 0) return []
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break
    body.push(line)
  }
  return body
}

function flagged(lines: string[], providerId: string): boolean {
  return section(lines, providerId).some(line => line.includes(FLAG))
}

async function settle(providerId: string, matches: (status: UpstreamAuthStatus) => boolean): Promise<UpstreamAuthStatus> {
  await runtime.refresh({ allowNetwork: false, providers: [providerId] })
  let status: UpstreamAuthStatus = runtime.getProviderAuthStatus(providerId)
  await vi.waitFor(() => {
    status = runtime.getProviderAuthStatus(providerId)
    expect(matches(status)).toBe(true)
  })
  return status
}

describe('liveUpstreamConfigured', () => {
  it('rejects a missing credential, a placeholder key, and the pool reporting itself', () => {
    expect(liveUpstreamConfigured(undefined)).toBe(false)
    expect(liveUpstreamConfigured({ configured: false })).toBe(false)
    expect(liveUpstreamConfigured({ configured: true, source: 'fallback' })).toBe(false)
    expect(liveUpstreamConfigured({
      configured: true,
      source: 'environment',
      label: MULTIPOOL_AUTH_SOURCE,
    })).toBe(false)
  })

  it('accepts stored, runtime, env, and env-reference keys', () => {
    expect(liveUpstreamConfigured({ configured: true, source: 'stored' })).toBe(true)
    expect(liveUpstreamConfigured({ configured: true, source: 'runtime' })).toBe(true)
    expect(liveUpstreamConfigured({
      configured: true,
      source: 'environment',
      label: 'PI_MP_ACCOUNTS_FLAG_KEY',
    })).toBe(true)
    // Once pooled, Pi reports an env-referenced extension key and a static
    // extension key with the same check source. The env key is a real
    // credential, so this source stays live.
    expect(liveUpstreamConfigured({
      configured: true,
      source: 'environment',
      label: 'configured API key',
    })).toBe(true)
  })
})

describe('/accounts core-credential flag on Pi 1.1.0', () => {
  it('flags a pooled provider whose only auth is the pool itself', async () => {
    await accountsLines()
    const status = await settle('example', candidate =>
      candidate.source === 'environment' && candidate.label === MULTIPOOL_AUTH_SOURCE)
    const lines = await accountsLines()
    expect(status).toEqual({ configured: true, source: 'environment', label: MULTIPOOL_AUTH_SOURCE })
    expect(flagged(lines, 'example')).toBe(true)
    expect(section(lines, 'example').some(line => line.includes('/multilogout'))).toBe(true)
    expect(runtime.getProviderAuthStatus('example')).toEqual(status)
  })

  it('does not flag while a runtime API key is the core credential', async () => {
    await runtime.setRuntimeApiKey('example', 'sk-live')
    const lines = await accountsLines()
    expect(runtime.getProviderAuthStatus('example')).toEqual({ configured: true, source: 'runtime' })
    expect(flagged(lines, 'example')).toBe(false)
  })

  it('flags again after that runtime key is removed', async () => {
    await runtime.removeRuntimeApiKey('example')
    await settle('example', candidate => candidate.label === MULTIPOOL_AUTH_SOURCE)
    const lines = await accountsLines()
    expect(flagged(lines, 'example')).toBe(true)
  })

  it('does not flag an extension key that comes from an environment reference', async () => {
    process.env.PI_MP_ACCOUNTS_FLAG_KEY = 'live-env-key'
    await store.addAccount('envish', { label: 'Env', credential: { type: 'api_key', key: 'k-env' } })
    runtime.registerProvider('envish', {
      name: 'Envish',
      apiKey: '$PI_MP_ACCOUNTS_FLAG_KEY',
      baseUrl: 'https://example.invalid',
      api: 'openai-completions',
      models: [{
        id: 'env-model',
        name: 'Env Model',
        api: 'openai-completions',
        baseUrl: 'https://example.invalid',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 100,
      }],
    })
    await accountsLines()
    const status = await settle('envish', candidate => liveUpstreamConfigured(candidate))
    const lines = await accountsLines()
    expect(liveUpstreamConfigured(status)).toBe(true)
    expect(flagged(lines, 'envish')).toBe(false)
    expect(flagged(lines, 'example')).toBe(true)
    delete process.env.PI_MP_ACCOUNTS_FLAG_KEY
  })

  it('flags a status Pi still reports as an embedded fallback key', async () => {
    const blind = {
      getProvider: (id: string) => registry.getProvider(id),
      getAll: () => registry.getAll(),
      runtime: {
        getProviders: () => runtime.getProviders(),
        getProviderAuthStatus: () => ({ configured: true, source: 'fallback' }),
        isUsingOAuth: () => false,
      },
    } as unknown as ExtensionContext['modelRegistry']
    const lines = await accountsLines(blind)
    expect(flagged(lines, 'example')).toBe(true)
  })

  it('does not flag when the auth-status API is unavailable', async () => {
    const blind = {
      getProvider: (id: string) => registry.getProvider(id),
      getAll: () => registry.getAll(),
    } as unknown as ExtensionContext['modelRegistry']
    const lines = await accountsLines(blind)
    expect(flagged(lines, 'example')).toBe(false)
  })
})
