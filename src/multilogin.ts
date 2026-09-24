import type {
  Api,
  AuthEvent,
  AuthPrompt,
  AuthType,
  Credential,
  Provider,
  ProviderAuthInteraction,
} from '@earendil-works/pi-ai'
import {
  ExtensionSelectorComponent,
  LoginDialogComponent,
  OAuthSelectorComponent,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { Container, type Focusable, type TUI } from '@earendil-works/pi-tui'

export interface LoginSelection {
  provider: Provider<Api>
  authType: AuthType
}

interface SelectorOption {
  id: string
  name: string
  authType: AuthType
  method: NonNullable<Provider<Api>['auth']['apiKey']> | NonNullable<Provider<Api>['auth']['oauth']>
  status?: { type: AuthType; source?: string }
}

export interface LoginDialogSuccess {
  credential: Credential
}

export interface LoginDialogFailure {
  error: Error
}

export type LoginDialogResult = LoginDialogSuccess | LoginDialogFailure | undefined

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

interface SessionRuntime {
  getProviders(): readonly Provider<Api>[]
  getProviderAuthStatus(id: string): { configured: boolean; label?: string; source?: string }
  isUsingOAuth(id: string): boolean
}

export function probeSessionRuntime(ctx: ExtensionContext): SessionRuntime | undefined {
  const candidate = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const runtime = candidate as Record<keyof SessionRuntime, unknown>
  if (typeof runtime.getProviders !== 'function') return undefined
  if (typeof runtime.getProviderAuthStatus !== 'function') return undefined
  if (typeof runtime.isUsingOAuth !== 'function') return undefined
  return candidate as unknown as SessionRuntime
}

function loginOptions(
  providers: readonly Provider<Api>[],
  statusFor: (providerId: string) => { type: AuthType; source?: string } | undefined,
): SelectorOption[] {
  const options: SelectorOption[] = []
  for (const provider of providers) {
    const status = statusFor(provider.id)
    for (const [authType, method] of [
      ['oauth', provider.auth.oauth],
      ['api_key', provider.auth.apiKey],
    ] as const) {
      if (method === undefined) continue
      options.push({
        id: provider.id,
        name: provider.name,
        authType,
        method,
        ...(status === undefined ? {} : { status }),
      })
    }
  }
  return options.sort((left, right) => left.name.localeCompare(right.name))
}

export async function selectLogin(
  ctx: ExtensionContext,
  providers: readonly Provider<Api>[],
  providerRef?: string,
): Promise<LoginSelection | undefined> {
  const normalized = providerRef?.trim().toLowerCase()
  const runtime = probeSessionRuntime(ctx)
  const all = runtime === undefined ? providers : runtime.getProviders()
  const scoped = normalized === undefined || normalized === ''
    ? all
    : all.filter(provider => provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized)
  const statusFor = (providerId: string): { type: AuthType; source?: string } | undefined => {
    if (runtime === undefined) return undefined
    const status = runtime.getProviderAuthStatus(providerId)
    if (status === undefined || !status.configured) return undefined
    const source = status.label ?? status.source
    return {
      type: runtime.isUsingOAuth(providerId) ? 'oauth' : 'api_key',
      ...(source === undefined ? {} : { source }),
    }
  }
  const options = loginOptions(scoped, statusFor)
  if (options.length === 0) {
    ctx.ui.notify(
      normalized === undefined
        ? 'No providers with API-key or OAuth authentication are available.'
        : `No API-key or OAuth authentication method is available for "${providerRef}".`,
      'warning',
    )
    return undefined
  }
  if (options.length === 1) {
    const option = options[0]!
    return {
      provider: scoped.find(provider => provider.id === option.id)!,
      authType: option.authType,
    }
  }

  const selected = await ctx.ui.custom<{ providerId: string; authType: AuthType } | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new OAuthSelectorComponent(
        'login',
        options,
        (providerId, authType) => done({ providerId, authType }),
        () => done(undefined),
        normalized,
      )
      return {
        get focused() {
          return selector.focused
        },
        set focused(value: boolean) {
          selector.focused = value
        },
        render: width => selector.render(width),
        invalidate: () => selector.invalidate(),
        handleInput: data => {
          selector.handleInput(data)
          tui.requestRender()
        },
      }
    },
  )
  if (selected === undefined) return undefined
  const provider = all.find(candidate => candidate.id === selected.providerId)
  return provider === undefined ? undefined : { provider, authType: selected.authType }
}

function notifyDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
  if (event.type === 'auth_url') {
    dialog.showAuth(event.url, event.instructions)
  } else if (event.type === 'device_code') {
    dialog.showDeviceCode(event)
    dialog.showWaiting('Waiting for authentication...')
  } else if (event.type === 'info') {
    dialog.showInfo(event.message, event.links)
  } else {
    dialog.showProgress(event.message)
  }
}

async function withPromptSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) throw new Error('Login cancelled')
  let abort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Login cancelled'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([promise, cancelled])
  } finally {
    if (abort !== undefined) signal.removeEventListener('abort', abort)
  }
}

export class LoginDialogHostComponent extends Container implements Focusable {
  readonly dialog: LoginDialogComponent
  private activeView: Container & { handleInput?(data: string): void; focused?: boolean; dispose?(): void }
  private _focused = false

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    if ('focused' in this.activeView && typeof this.activeView.focused === 'boolean') {
      this.activeView.focused = value
    }
  }

  constructor(
    private readonly tui: TUI,
    providerId: string,
    onCancel: () => void,
    providerName?: string,
    titleOverride?: string,
  ) {
    super()
    this.dialog = new LoginDialogComponent(
      tui,
      providerId,
      onCancel,
      providerName,
      titleOverride,
    )
    this.activeView = this.dialog
    this.addChild(this.dialog)
  }

  showSelect(
    title: string,
    options: readonly { id: string; label: string }[],
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted || this.dialog.signal.aborted) {
        reject(new Error('Login cancelled'))
        return
      }

      let onPromptAbort: (() => void) | undefined
      let onDialogAbort: (() => void) | undefined
      let selector: ExtensionSelectorComponent | undefined
      let settled = false

      const restoreDialog = () => {
        if (settled) return
        settled = true
        if (onPromptAbort !== undefined && signal !== undefined) {
          signal.removeEventListener('abort', onPromptAbort)
        }
        if (onDialogAbort !== undefined) {
          this.dialog.signal.removeEventListener('abort', onDialogAbort)
        }
        try {
          selector?.dispose()
        } catch {
          // ignore selector disposal failure
        }
        this.clear()
        this.activeView = this.dialog
        this.addChild(this.dialog)
        this.dialog.focused = this._focused
        this.invalidate()
        this.tui.requestRender()
      }

      onPromptAbort = () => {
        restoreDialog()
        reject(new Error('Login cancelled'))
      }
      onDialogAbort = () => {
        restoreDialog()
        reject(new Error('Login cancelled'))
      }

      if (signal !== undefined) {
        signal.addEventListener('abort', onPromptAbort, { once: true })
      }
      this.dialog.signal.addEventListener('abort', onDialogAbort, { once: true })

      const labels = options.map(option => option.label)
      selector = new ExtensionSelectorComponent(
        title,
        labels,
        selectedLabel => {
          restoreDialog()
          const matched = options.find(option => option.label === selectedLabel)
          if (matched === undefined) {
            reject(new Error('Login cancelled'))
          } else {
            resolve(matched.id)
          }
        },
        () => {
          restoreDialog()
          reject(new Error('Login cancelled'))
        },
        { tui: this.tui },
      )

      this.clear()
      this.activeView = selector
      this.addChild(selector)
      this.invalidate()
      this.tui.requestRender()
    })
  }

  handleInput(data: string): void {
    if (typeof this.activeView.handleInput === 'function') {
      this.activeView.handleInput(data)
    }
    this.tui.requestRender()
  }

  dispose(): void {
    if (typeof this.activeView.dispose === 'function') {
      this.activeView.dispose()
    }
  }
}

async function promptDialog(
  host: LoginDialogHostComponent,
  prompt: AuthPrompt,
): Promise<string> {
  let response: Promise<string>
  if (prompt.type === 'select') {
    response = host.showSelect(prompt.message, prompt.options, prompt.signal)
  } else if (prompt.type === 'manual_code') {
    response = host.dialog.showManualInput(prompt.message)
  } else {
    response = host.dialog.showPrompt(prompt.message, prompt.placeholder)
  }
  return withPromptSignal(response, prompt.signal)
}

export async function loginCredential(
  selection: LoginSelection,
  interaction: ProviderAuthInteraction,
): Promise<Credential> {
  const method = selection.authType === 'oauth'
    ? selection.provider.auth.oauth
    : selection.provider.auth.apiKey
  if (method?.login === undefined) {
    throw new Error(`No ${selection.authType} login method for ${selection.provider.name}`)
  }
  return method.login(interaction)
}

export async function promptApiKeyCredential(
  ctx: ExtensionContext,
  provider: Provider<Api>,
): Promise<LoginDialogResult> {
  const name = provider.auth.apiKey?.name
  if (name === undefined) {
    return { error: new Error(`No API-key authentication for ${provider.name}`) }
  }
  const input = await ctx.ui.input(`Enter ${name}:`, '')
  if (input === undefined) return undefined
  const key = input.trim()
  if (key === '') return { error: new Error('API key is required') }
  return { credential: { type: 'api_key', key } }
}

export interface LoginDialogOptions {
  title?: string
}

export async function showLoginDialog(
  ctx: ExtensionContext,
  selection: LoginSelection,
  options: LoginDialogOptions = {},
): Promise<LoginDialogResult> {
  return ctx.ui.custom<LoginDialogResult>((tui, _theme, _keybindings, done) => {
    let finished = false
    const finish = (result: LoginDialogResult) => {
      if (finished) return
      finished = true
      done(result)
    }
    const host = new LoginDialogHostComponent(
      tui,
      selection.provider.id,
      () => finish(undefined),
      selection.provider.name,
      options.title ?? `Add ${selection.provider.name} account`,
    )
    const interaction: ProviderAuthInteraction = {
      signal: host.dialog.signal,
      prompt: prompt => promptDialog(host, prompt),
      notify: event => notifyDialog(host.dialog, event),
    }

    queueMicrotask(() => {
      loginCredential(selection, interaction)
        .then(credential => finish({ credential }))
        .catch(error => {
          const normalized = errorFrom(error)
          finish(normalized.message === 'Login cancelled' ? undefined : { error: normalized })
        })
    })

    return host
  })
}
