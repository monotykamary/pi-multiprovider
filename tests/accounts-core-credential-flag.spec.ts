import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

// Same scratch-agent-dir discipline as extension-resume.spec.ts: the extension
// reads its credential store from the agent dir at load.
const agentDir = mkdtempSync(join(tmpdir(), 'pi-multiprovider-accounts-flag-'))
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

async function accountsLines(status: { configured: boolean; source?: string } | undefined): Promise<string[]> {
  let selected: string[] = []
  const ctx = {
    ui: {
      notify() {},
      async select(_title: string, lines: string[]) { selected = lines },
      async input() { return undefined },
      async confirm() { return false },
      async custom() { return undefined },
    },
    mode: 'tui',
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => 'session-1', getEntries: () => [] },
    modelRegistry: {
      getProvider: (id: string) => (id === base.id ? base : undefined),
      getAll: () => [model],
      getApiKeyAndHeaders: async () => ({ ok: true }),
      ...(status === undefined ? {} : {
        runtime: {
          getProviders: () => [base],
          getProviderAuthStatus: () => status,
          isUsingOAuth: () => false,
        },
      }),
    },
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

  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
  const pi = {
    events: {
      emit() {},
      on() { return () => {} },
    },
    on() {},
    registerProvider() {},
    unregisterProvider() {},
    getAllTools: () => [],
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def)
    },
    appendEntry() {},
  }
  await multiprovider(pi as unknown as ExtensionAPI)
  const command = commands.get('accounts')
  if (command === undefined) throw new Error('/accounts is not registered')
  await command.handler('', ctx)
  return selected
}

describe('/accounts core-credential flag', () => {
  it('flags a pooled provider whose core /login credential is gone', async () => {
    const lines = await accountsLines({ configured: false })
    expect(lines.some(line => line.includes('no live core /login credential'))).toBe(true)
    expect(lines.some(line => line.includes('/multilogout'))).toBe(true)
  })

  it('flags an extension-embedded placeholder key as no live credential', async () => {
    const lines = await accountsLines({ configured: true, source: 'fallback' })
    expect(lines.some(line => line.includes('no live core /login credential'))).toBe(true)
  })

  it('does not flag a pooled provider with its core credential intact', async () => {
    const lines = await accountsLines({ configured: true, source: 'stored' })
    expect(lines.some(line => line.includes('no live core /login credential'))).toBe(false)
  })

  it('does not flag when the auth-status API is unavailable', async () => {
    const lines = await accountsLines(undefined)
    expect(lines.some(line => line.includes('no live core /login credential'))).toBe(false)
  })
})
