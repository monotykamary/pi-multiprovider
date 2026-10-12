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
  LoginDialogHostComponent,
  loginCredential,
  showLoginDialog,
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
