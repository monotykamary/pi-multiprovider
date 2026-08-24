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
  LoginDialogComponent,
  OAuthSelectorComponent,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'

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

function loginOptions(providers: readonly Provider<Api>[], pooledCounts: ReadonlyMap<string, number>): SelectorOption[] {
  const options: SelectorOption[] = []
  for (const provider of providers) {
    const count = pooledCounts.get(provider.id) ?? 0
    const source = count === 0 ? undefined : `${count} pooled account${count === 1 ? '' : 's'}`
    if (provider.auth.oauth !== undefined) {
      options.push({
        id: provider.id,
        name: provider.name,
        authType: 'oauth',
        method: provider.auth.oauth,
        ...(source === undefined ? {} : { status: { type: 'oauth', source } }),
      })
    }
    if (provider.auth.apiKey?.login !== undefined) {
      options.push({
        id: provider.id,
        name: provider.name,
        authType: 'api_key',
        method: provider.auth.apiKey,
        ...(source === undefined ? {} : { status: { type: 'api_key', source } }),
      })
    }
  }
  return options.sort((left, right) => left.name.localeCompare(right.name))
}

export async function selectLogin(
  ctx: ExtensionContext,
  providers: readonly Provider<Api>[],
  pooledCounts: ReadonlyMap<string, number>,
  providerRef?: string,
): Promise<LoginSelection | undefined> {
  const normalized = providerRef?.trim().toLowerCase()
  const scoped = normalized === undefined || normalized === ''
    ? providers
    : providers.filter(provider => provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized)
  const options = loginOptions(scoped, pooledCounts)
  if (options.length === 0) {
    ctx.ui.notify(
      normalized === undefined
        ? 'No providers with interactive authentication are available.'
        : `No interactive authentication method is available for "${providerRef}".`,
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
  const provider = providers.find(candidate => candidate.id === selected.providerId)
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

async function promptDialog(
  ctx: ExtensionContext,
  dialog: LoginDialogComponent,
  prompt: AuthPrompt,
): Promise<string> {
  let response: Promise<string>
  if (prompt.type === 'select') {
    response = (async () => {
      const labels = prompt.options.map(option => option.label)
      const selected = await ctx.ui.select(prompt.message, labels)
      const id = prompt.options.find(option => option.label === selected)?.id
      if (id === undefined) throw new Error('Login cancelled')
      return id
    })()
  } else if (prompt.type === 'manual_code') {
    response = dialog.showManualInput(prompt.message)
  } else {
    response = dialog.showPrompt(prompt.message, prompt.placeholder)
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

export async function showLoginDialog(
  ctx: ExtensionContext,
  selection: LoginSelection,
): Promise<LoginDialogResult> {
  return ctx.ui.custom<LoginDialogResult>((tui, _theme, _keybindings, done) => {
    let finished = false
    const finish = (result: LoginDialogResult) => {
      if (finished) return
      finished = true
      done(result)
    }
    const dialog = new LoginDialogComponent(
      tui,
      selection.provider.id,
      () => finish(undefined),
      selection.provider.name,
      `Add ${selection.provider.name} account`,
    )
    const interaction: ProviderAuthInteraction = {
      signal: dialog.signal,
      prompt: prompt => promptDialog(ctx, dialog, prompt),
      notify: event => notifyDialog(dialog, event),
    }

    queueMicrotask(() => {
      loginCredential(selection, interaction)
        .then(credential => finish({ credential }))
        .catch(error => {
          const normalized = errorFrom(error)
          finish(normalized.message === 'Login cancelled' ? undefined : { error: normalized })
        })
    })

    return dialog
  })
}
