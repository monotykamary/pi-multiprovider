import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProvider,
  type AuthEvent,
  type AuthPrompt,
  type Model,
  type ProviderAuthInteraction,
} from '@earendil-works/pi-ai'
import {
  type ExtensionContext,
  initTheme,
} from '@earendil-works/pi-coding-agent'
import type { TUI } from '@earendil-works/pi-tui'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  attributableSecrets,
  attributeChangedFilesToSecrets,
  changedWatchedAuthFiles,
  isUpstreamConfigured,
  isWatchedAuthFileName,
  LoginDialogHostComponent,
  loginCredential,
  markerPendingUpstreamIds,
  pendingUpstreamProviders,
  pendingUpstreamStatusLines,
  shouldSaveAsUpstreamOnly,
  shouldWarnUpstreamDuplicate,
  showLoginDialog,
  snapshotWatchedAuthFiles,
  upstreamDuplicateNotice,
  upstreamOnlyNotice,
} from '../src/multilogin.ts'

const model: Model<'test-api'> = {
  id: 'model',
  name: 'Model',
  api: 'test-api',
  provider: 'login-provider',
  baseUrl: 'https://login.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

const provider = createProvider<'test-api'>({
  id: model.provider,
  name: 'Login Provider',
  auth: {
    apiKey: {
      name: 'Login API key',
      async login(interaction) {
        return {
          type: 'api_key',
          key: await interaction.prompt({ type: 'secret', message: 'Enter API key' }),
        }
      },
      async resolve() {
        return undefined
      },
    },
    oauth: {
      name: 'Login OAuth',
      async login(interaction) {
        interaction.notify({
          type: 'device_code',
          userCode: 'ABCD-1234',
          verificationUri: 'https://login.invalid/device',
        })
        interaction.notify({ type: 'progress', message: 'Waiting for authentication...' })
        const method = await interaction.prompt({
          type: 'select',
          message: 'Select login method:',
          options: [
            { id: 'browser', label: 'Browser OAuth' },
            { id: 'manual', label: 'Manual code' },
          ],
        })
        const code = await interaction.prompt({ type: 'manual_code', message: 'Paste the authorization code' })
        return {
          type: 'oauth',
          refresh: `${method}-refresh`,
          access: code,
          expires: Date.now() + 60_000,
        }
      },
      async refresh(credential) {
        return credential
      },
      async toAuth(credential) {
        return { apiKey: credential.access }
      },
    },
  },
  models: [model],
  api: {
    stream() {
      throw new Error('not used')
    },
    streamSimple() {
      throw new Error('not used')
    },
  },
})

function interaction(events: AuthEvent[], prompts: AuthPrompt[]): ProviderAuthInteraction {
  return {
    signal: new AbortController().signal,
    notify(event) {
      events.push(event)
    },
    async prompt(prompt) {
      prompts.push(prompt)
      if (prompt.type === 'secret') return 'simulated-api-key'
      if (prompt.type === 'select') return 'browser'
      return 'simulated-oauth-code'
    },
  }
}

describe('/multilogin provider auth', () => {
  beforeAll(() => {
    initTheme()
  })
  it('runs API-key and OAuth provider flows through the same interaction contract', async () => {
    const events: AuthEvent[] = []
    const prompts: AuthPrompt[] = []
    await expect(loginCredential(
      { provider, authType: 'api_key' },
      interaction(events, prompts),
    )).resolves.toEqual({ type: 'api_key', key: 'simulated-api-key' })
    await expect(loginCredential(
      { provider, authType: 'oauth' },
      interaction(events, prompts),
    )).resolves.toMatchObject({
      type: 'oauth',
      refresh: 'browser-refresh',
      access: 'simulated-oauth-code',
    })
    expect(prompts.map(prompt => prompt.type)).toEqual(['secret', 'select', 'manual_code'])
    expect(events.map(event => event.type)).toEqual(['device_code', 'progress'])
  })

  it('LoginDialogHostComponent switches to selector for select prompt and restores dialog view', async () => {
    const renders: number[] = []
    const mockTui = {
      requestRender() {
        renders.push(Date.now())
      },
    } as unknown as TUI

    const host = new LoginDialogHostComponent(
      mockTui,
      provider.id,
      () => {},
      provider.name,
    )

    expect(host.children).toHaveLength(1)
    expect(host.children[0]).toBe(host.dialog)

    const selectPromise = host.showSelect('Choose login method:', [
      { id: 'browser', label: 'Browser OAuth' },
      { id: 'manual', label: 'Manual code' },
    ])

    // While selecting, active view is the selector
    expect(host.children[0]).not.toBe(host.dialog)

    // Select first option by sending Enter
    host.handleInput('\n')

    await expect(selectPromise).resolves.toBe('browser')

    // Dialog is restored as active view
    expect(host.children[0]).toBe(host.dialog)
  })

  it('LoginDialogHostComponent restores dialog view when selection is cancelled', async () => {
    const mockTui = {
      requestRender() {},
    } as unknown as TUI

    const host = new LoginDialogHostComponent(
      mockTui,
      provider.id,
      () => {},
      provider.name,
    )

    const selectPromise = host.showSelect('Choose login method:', [
      { id: 'browser', label: 'Browser OAuth' },
      { id: 'manual', label: 'Manual code' },
    ])

    expect(host.children[0]).not.toBe(host.dialog)

    // Cancel selection via Escape
    host.handleInput('\x1b')

    await expect(selectPromise).rejects.toThrow('Login cancelled')
    expect(host.children[0]).toBe(host.dialog)
  })

  it('showLoginDialog hosts select prompts internally without calling ctx.ui.select', async () => {
    const selectSpy = vi.fn().mockResolvedValue(undefined)
    let renderedHost: LoginDialogHostComponent | undefined

    const mockTui = {
      requestRender() {},
    } as unknown as TUI

    const mockCtx = {
      ui: {
        select: selectSpy,
        custom: vi.fn(async (factory) => {
          return new Promise((resolve) => {
            const component = factory(mockTui, {} as any, {} as any, resolve)
            renderedHost = component as LoginDialogHostComponent
          })
        }),
      },
    } as unknown as ExtensionContext

    const dialogPromise = showLoginDialog(mockCtx, {
      provider,
      authType: 'oauth',
    })

    // Allow queueMicrotask to start loginCredential
    await vi.waitFor(() => {
      expect(renderedHost).toBeDefined()
      // Selector should be active inside the host
      expect(renderedHost!.children[0]).not.toBe(renderedHost!.dialog)
    })

    // Make selection in host component: select 'browser' (first option)
    renderedHost!.handleInput('\n')

    // After select, dialog is restored and waiting for manual_code input
    await vi.waitFor(() => {
      expect(renderedHost!.children[0]).toBe(renderedHost!.dialog)
    })

    // Make sure ctx.ui.select was NEVER called, which would overwrite editorContainer in Pi
    expect(selectSpy).not.toHaveBeenCalled()

    // Cancel the rest of the flow by pressing Escape on the dialog
    renderedHost!.handleInput('\x1b')

    const result = await dialogPromise
    expect(result).toBeUndefined()
  })
})

describe('upstream duplicate notice', () => {
  function ctxWithUpstream(configured: boolean): ExtensionContext {
    return {
      modelRegistry: {
        runtime: {
          getProviders: () => [],
          getProviderAuthStatus: () => ({ configured }),
          isUsingOAuth: () => true,
        },
      },
    } as unknown as ExtensionContext
  }

  it('reports upstream as configured only when the runtime says so', () => {
    expect(isUpstreamConfigured(ctxWithUpstream(true), 'antigravity')).toBe(true)
    expect(isUpstreamConfigured(ctxWithUpstream(false), 'antigravity')).toBe(false)
  })

  it('reports unconfigured when there is no session runtime', () => {
    const ctx = { modelRegistry: {} } as unknown as ExtensionContext
    expect(isUpstreamConfigured(ctx, 'antigravity')).toBe(false)
  })

  it('reports unconfigured when the runtime probe throws', () => {
    const ctx = {
      modelRegistry: {
        runtime: {
          getProviders: () => [],
          getProviderAuthStatus: () => { throw new Error('unavailable') },
          isUsingOAuth: () => true,
        },
      },
    } as unknown as ExtensionContext
    expect(isUpstreamConfigured(ctx, 'antigravity')).toBe(false)
  })

  it('notice names the pool rows and points at the upstream toggle', () => {
    const message = upstreamDuplicateNotice('Antigravity', 'bn')
    expect(message).toContain('bn')
    expect(message).toContain('Antigravity')
    expect(message).toContain('upstream')
    expect(message).toContain('/multilogin')
  })
})

describe('upstream-first first add', () => {
  it('saves as upstream only for a new pool whose login backfilled native state', () => {
    expect(shouldSaveAsUpstreamOnly({
      poolExistedBefore: false,
      method: 'oauth',
      providerBackfilledNative: true,
    })).toBe(true)
  })

  it('pools normally when the pool already existed', () => {
    expect(shouldSaveAsUpstreamOnly({
      poolExistedBefore: true,
      method: 'oauth',
      providerBackfilledNative: true,
    })).toBe(false)
  })

  it('pools normally when the login left native state untouched (pure login)', () => {
    expect(shouldSaveAsUpstreamOnly({
      poolExistedBefore: false,
      method: 'oauth',
      providerBackfilledNative: false,
    })).toBe(false)
  })

  it('pools normally for the paste-API-key flow, which never touches upstream', () => {
    expect(shouldSaveAsUpstreamOnly({
      poolExistedBefore: false,
      method: 'api_key_paste',
      providerBackfilledNative: true,
    })).toBe(false)
  })

  it('upstream-only notice names the provider and the next step', () => {
    const message = upstreamOnlyNotice('Antigravity')
    expect(message).toContain('Antigravity')
    expect(message).toContain('upstream')
    expect(message).toContain('/multilogin')
  })

  it('upstream-only notice names the discarded label when one was typed', () => {
    const message = upstreamOnlyNotice('Antigravity', 'bn')
    expect(message).toContain('"bn"')
    expect(message).toContain('not kept')
  })
})

describe('pending upstream providers', () => {
  const all = [
    { id: 'antigravity', label: 'Antigravity' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'cursor', label: 'Cursor' },
  ]

  it('lists configured providers that have no pool', () => {
    const pending = pendingUpstreamProviders(
      all,
      new Set(['openai']),
      id => id !== 'cursor',
    )
    expect(pending).toEqual([{ id: 'antigravity', label: 'Antigravity' }])
  })

  it('is empty when every configured provider already has a pool', () => {
    expect(pendingUpstreamProviders(
      all,
      new Set(['antigravity', 'openai', 'cursor']),
      () => true,
    )).toEqual([])
  })

  it('renders pending rows without claiming an account identity', () => {
    const lines = pendingUpstreamStatusLines([{ id: 'antigravity', label: 'Antigravity' }])
    expect(lines).toEqual([
      'Antigravity (antigravity) · no pool yet',
      '  Pi default (upstream) · native credential, not pooled · next /multilogin add starts the pool',
    ])
  })
})

describe('upstream-only markers', () => {
  const markers = {
    antigravity: { addedAt: '2026-10-04T00:00:00.000Z', watchedFiles: ['antigravity-accounts.json'] },
    openai: { addedAt: '2026-10-04T00:00:00.000Z', watchedFiles: ['auth.json'] },
  }

  it('keeps markers whose recorded native file is still present and unpooled', () => {
    expect(markerPendingUpstreamIds(
      markers,
      new Set(),
      new Set(['antigravity-accounts.json', 'models-store.json']),
    )).toEqual(['antigravity'])
  })

  it('retires markers once a pool exists or the native file is gone', () => {
    expect(markerPendingUpstreamIds(markers, new Set(['antigravity']), new Set(['antigravity-accounts.json'])))
      .toEqual([])
    expect(markerPendingUpstreamIds(markers, new Set(), new Set(['models-store.json']))).toEqual([])
  })
})

describe('upstream duplicate warning', () => {
  it('warns when the login backfilled native state', () => {
    expect(shouldWarnUpstreamDuplicate({
      savedAsUpstreamOnly: false,
      method: 'oauth',
      providerBackfilledNative: true,
      upstreamConfiguredAfter: false,
    })).toBe(true)
  })

  it('warns when upstream is configured afterwards (standard providers)', () => {
    expect(shouldWarnUpstreamDuplicate({
      savedAsUpstreamOnly: false,
      method: 'oauth',
      providerBackfilledNative: false,
      upstreamConfiguredAfter: true,
    })).toBe(true)
  })

  it('stays quiet for pure logins with no native trace', () => {
    expect(shouldWarnUpstreamDuplicate({
      savedAsUpstreamOnly: false,
      method: 'oauth',
      providerBackfilledNative: false,
      upstreamConfiguredAfter: false,
    })).toBe(false)
  })

  it('stays quiet on the upstream-first path and for pasted keys', () => {
    expect(shouldWarnUpstreamDuplicate({
      savedAsUpstreamOnly: true,
      method: 'oauth',
      providerBackfilledNative: true,
      upstreamConfiguredAfter: false,
    })).toBe(false)
    expect(shouldWarnUpstreamDuplicate({
      savedAsUpstreamOnly: false,
      method: 'api_key_paste',
      providerBackfilledNative: true,
      upstreamConfiguredAfter: true,
    })).toBe(false)
  })
})

describe('watched auth files', () => {
  it('matches auth-ish file names and skips the pool store, locks, and temp files', () => {
    expect(isWatchedAuthFileName('auth.json')).toBe(true)
    expect(isWatchedAuthFileName('antigravity-accounts.json')).toBe(true)
    expect(isWatchedAuthFileName('cursor-credentials.json')).toBe(true)
    expect(isWatchedAuthFileName('models-store.json')).toBe(false)
    expect(isWatchedAuthFileName('multiprovider-auth.json', ['multiprovider-auth.json'])).toBe(false)
    expect(isWatchedAuthFileName('auth.json.lock')).toBe(false)
    expect(isWatchedAuthFileName('.multiprovider-auth.json.123.abc.tmp')).toBe(false)
  })

  it('detects a native store created or rewritten with different content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multiprovider-watch-'))
    try {
      const before = await snapshotWatchedAuthFiles(dir, ['multiprovider-auth.json'])
      expect(changedWatchedAuthFiles(before, before)).toEqual([])
      await writeFile(join(dir, 'antigravity-accounts.json'), '{"accounts":{}}')
      await writeFile(join(dir, 'models-store.json'), '{}')
      const afterCreate = await snapshotWatchedAuthFiles(dir, ['multiprovider-auth.json'])
      expect(changedWatchedAuthFiles(before, afterCreate)).toEqual(['antigravity-accounts.json'])
      await writeFile(join(dir, 'antigravity-accounts.json'), '{"accounts":{"a":1}}')
      const afterRewrite = await snapshotWatchedAuthFiles(dir, ['multiprovider-auth.json'])
      expect(changedWatchedAuthFiles(afterCreate, afterRewrite)).toEqual(['antigravity-accounts.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores same-content rewrites that only touch metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multiprovider-watch-'))
    try {
      await writeFile(join(dir, 'antigravity-accounts.json'), '{"accounts":{}}')
      const before = await snapshotWatchedAuthFiles(dir, ['multiprovider-auth.json'])
      const past = new Date(Date.now() - 60_000)
      await utimes(join(dir, 'antigravity-accounts.json'), past, past)
      const after = await snapshotWatchedAuthFiles(dir, ['multiprovider-auth.json'])
      expect(changedWatchedAuthFiles(before, after)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to metadata when content hashes are unavailable', () => {
    const before = { 'auth.json': { mtimeMs: 1, size: 10 } }
    expect(changedWatchedAuthFiles(before, { 'auth.json': { mtimeMs: 2, size: 10 } })).toEqual(['auth.json'])
    expect(changedWatchedAuthFiles(before, { 'auth.json': { mtimeMs: 1, size: 10 } })).toEqual([])
  })

  it('extracts attributable secrets from fresh credentials', () => {
    expect(attributableSecrets({ type: 'oauth', refresh: 'r', access: 'a', expires: 1 })).toEqual(['r', 'a'])
    expect(attributableSecrets({ type: 'oauth', refresh: '', access: '', expires: 1 })).toEqual([])
    expect(attributableSecrets({ type: 'api_key', key: 'k' })).toEqual(['k'])
    expect(attributableSecrets({ type: 'api_key' })).toEqual([])
  })

  it('attributes only changed files containing a fresh secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multiprovider-attribute-'))
    try {
      await writeFile(join(dir, 'native-accounts.json'), JSON.stringify({ refresh: 'fresh-refresh-token' }))
      await writeFile(join(dir, 'other-auth.json'), JSON.stringify({ refresh: 'someone-elses-token' }))
      expect(await attributeChangedFilesToSecrets(
        dir,
        ['native-accounts.json', 'other-auth.json', 'gone-auth.json'],
        ['fresh-refresh-token'],
      )).toEqual(['native-accounts.json'])
      expect(await attributeChangedFilesToSecrets(dir, ['native-accounts.json'], [])).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty snapshot for a missing directory', async () => {
    const snapshot = await snapshotWatchedAuthFiles(join(tmpdir(), 'multiprovider-watch-missing-dir'))
    expect(snapshot).toEqual({})
  })
})
