import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
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
import type { UpstreamOnlyMarker } from './auth-store.ts'

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

/**
 * True when Pi reports a live native credential for the provider. A pooled
 * login performed through the provider's own login dialog (e.g. Antigravity's
 * loginAndRemember) can also create or update that native credential as a
 * side effect, leaving the pool's upstream row and the new stored account
 * pointing at the same underlying account. The paste-API-key flow never
 * touches upstream, so it is excluded by the caller via `method`.
 */
/**
 * A "fallback" source means the key is statically embedded by an extension
 * (e.g. pi-cursor-sdk's non-functional placeholder), not a live login, so it
 * must not count as an upstream credential — the upstream row would otherwise
 * point at a placeholder the user never set.
 */
export function liveUpstreamConfigured(
  status?: { configured?: boolean; source?: string },
): boolean {
  return status?.configured === true && status.source !== 'fallback'
}

export function isUpstreamConfigured(ctx: ExtensionContext, providerId: string): boolean {
  try {
    return liveUpstreamConfigured(probeSessionRuntime(ctx)?.getProviderAuthStatus(providerId))
  } catch {
    return false
  }
}

/**
 * Builds the notice shown after a pooled account is added (or reauthenticated)
 * through a provider login dialog while upstream is configured. Worded as a
 * possibility, not a certainty: an upstream credential for a genuinely
 * different account is legitimate, but a provider-owned login dialog may have
 * duplicated it, so the operator should verify.
 */
export function upstreamDuplicateNotice(providerName: string, accountLabel: string): string {
  return `Added ${accountLabel} to ${providerName}. This login may also have saved the native Pi credential, in which case the pool's upstream row and "${accountLabel}" are the same account counted twice — disable upstream in /multilogin if so.`
}

export interface UpstreamFirstAddSnapshot {
  poolExistedBefore: boolean
  method: string
  /**
   * True when an upstream credential (or the pending-upstream marker for a
   * provider whose native store Pi core cannot see) already predates this
   * add. Upstream-first only applies to the add that CREATES the upstream
   * credential; once it exists, further adds must take the pool path —
   * otherwise a natively-backfilling provider would swallow every add and
   * the pool could never start. Also recorded on the pool at creation as
   * its upstreamConfigured seed value.
   */
  upstreamExisted?: boolean
  /**
   * True when the login observably backfilled a native credential: either a
   * watched auth file in the agent dir was created/modified across the login,
   * or Pi core status flipped from unconfigured to configured. The file
   * signal is the one that matters for providers with their own native
   * stores (e.g. Antigravity): Pi core's getProviderAuthStatus only consults
   * the core credential, the models.json/provider config, and its auth
   * snapshot, so it stays false even right after such a provider persists
   * natively — verified live when a re-add rewrote antigravity-accounts.json
   * yet status still reported unconfigured.
   */
  providerBackfilledNative: boolean
}

/**
 * Decides whether a fresh add through a provider login dialog should become
 * the native upstream credential instead of a pooled copy. True only when the
 * pool is new and the login observably backfilled native state — i.e. the
 * provider persists to its own native store as a side effect (Antigravity's
 * loginAndRemember). Pure logins change nothing natively, and the
 * paste-API-key flow never touches upstream, so both fall through to the
 * pool path. Detection is observational, so multiprovider stays read-only: it
 * never writes native credentials itself, it just refrains from duplicating
 * them.
 */
export function shouldSaveAsUpstreamOnly(snapshot: UpstreamFirstAddSnapshot): boolean {
  return !snapshot.poolExistedBefore
    && snapshot.upstreamExisted !== true
    && snapshot.method !== 'api_key_paste'
    && snapshot.providerBackfilledNative
}
export interface UpstreamDuplicateWarningSnapshot {
  savedAsUpstreamOnly: boolean
  method: string
  providerBackfilledNative: boolean
  upstreamConfiguredAfter: boolean
}

/**
 * Whether the post-add notice should warn that the new pooled copy may
 * duplicate the native upstream credential. Either a natively-persisting
 * login was observed mid-add, or Pi core reports upstream configured
 * afterwards (covers standard providers whose native credential predates the
 * pool). The upstream-first path and the paste flow never warn.
 */
export function shouldWarnUpstreamDuplicate(snapshot: UpstreamDuplicateWarningSnapshot): boolean {
  return !snapshot.savedAsUpstreamOnly
    && snapshot.method !== 'api_key_paste'
    && (snapshot.providerBackfilledNative || snapshot.upstreamConfiguredAfter)
}

/** File names this detector never treats as a native-credential side effect. */
const AUTH_WATCH_SKIP_SUFFIXES = ['.lock', '.tmp']

/**
 * Content-hash snapshot of the agent dir's auth-ish files (names plus
 * mtime, size, and a SHA-256 of contents for files within
 * AUTH_WATCH_MAX_BYTES). Compared across a provider login to detect a
 * native-store side effect the Pi core status cannot see; snapshots then
 * narrow changed files by attribution (see attributeChangedFilesToSecrets),
 * so a concurrent unrelated rewrite inside the login window no longer
 * counts — only files containing this login's fresh secret do.
 *
 * `exclude` names multiprovider's own store, which the caller has not yet
 * written at snapshot time but must never count. When attribution is
 * impossible (no secret to check with, or a natively-encrypted store),
 * callers fall back to the raw change heuristic.
 */
export type WatchedAuthFiles = Record<string, { mtimeMs: number; size: number; hash?: string }>

/**
 * Exact native-store filenames known to hold provider credentials, checked
 * in addition to the name pattern below. Entries are literal filenames that
 * only match when present, so a wrong entry is harmless — the attribution
 * check still has to confirm the fresh secret landed in the file.
 */
export const KNOWN_AUTH_FILE_NAMES: readonly string[] = [
  'antigravity-accounts.json',
]

/**
 * Provider-owned native stores we can attribute to a specific provider id.
 * Used to recover upstream existence for legacy pools (created before
 * `upstreamConfigured` was persisted): the provider's own store being present
 * in the agent dir is observational evidence its ambient upstream credential
 * exists, even though Pi core cannot see that store.
 */
export const KNOWN_PROVIDER_AUTH_FILES: Readonly<Record<string, string>> = {
  'antigravity-accounts.json': 'antigravity',
}

/** The provider-owned native store filename recorded for a provider, if any. */
export function knownProviderAuthFileName(providerId: string): string | undefined {
  return Object.entries(KNOWN_PROVIDER_AUTH_FILES)
    .find(([, mappedId]) => mappedId === providerId)?.[0]
}

/** Files larger than this are compared by metadata only, never hashed or read. */
export const AUTH_WATCH_MAX_BYTES = 512 * 1024

async function hashAuthFile(dir: string, name: string): Promise<string | undefined> {
  try {
    const info = await stat(join(dir, name))
    if (!info.isFile() || info.size > AUTH_WATCH_MAX_BYTES) return undefined
    return createHash('sha256').update(await readFile(join(dir, name))).digest('hex')
  } catch {
    return undefined
  }
}

export function isWatchedAuthFileName(name: string, exclude: readonly string[] = []): boolean {
  if (exclude.includes(name)) return false
  if (AUTH_WATCH_SKIP_SUFFIXES.some(suffix => name.endsWith(suffix))) return false
  if ((KNOWN_AUTH_FILE_NAMES as readonly string[]).includes(name)) return true
  return /(auth|account|credential|login)/i.test(name)
}

export async function snapshotWatchedAuthFiles(
  dir: string,
  exclude: readonly string[] = [],
): Promise<WatchedAuthFiles> {
  const snapshot: WatchedAuthFiles = {}
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return snapshot
  }
  for (const name of entries) {
    if (!isWatchedAuthFileName(name, exclude)) continue
    try {
      const info = await stat(join(dir, name))
      if (!info.isFile()) continue
      const entry: { mtimeMs: number; size: number; hash?: string } = {
        mtimeMs: info.mtimeMs,
        size: info.size,
      }
      const hash = await hashAuthFile(dir, name)
      if (hash !== undefined) entry.hash = hash
      snapshot[name] = entry
    } catch {
      continue
    }
  }
  return snapshot
}

/**
 * Names created or content-changed between two snapshots. Content hashes
 * decide whenever both sides have one (immune to mtime granularity and
 * same-size rewrites); metadata is only the fallback for unreadable or
 * oversized files.
 */
export function changedWatchedAuthFiles(before: WatchedAuthFiles, after: WatchedAuthFiles): string[] {
  const changed: string[] = []
  for (const [name, state] of Object.entries(after)) {
    const previous = before[name]
    if (previous === undefined) {
      changed.push(name)
    } else if (previous.hash !== undefined && state.hash !== undefined) {
      if (previous.hash !== state.hash) changed.push(name)
    } else if (previous.mtimeMs !== state.mtimeMs || previous.size !== state.size) {
      changed.push(name)
    }
  }
  return changed
}

/**
 * Secrets from a fresh credential usable to attribute a native-store write
 * to this login. Refresh tokens, access tokens, and API keys are long
 * random strings; a changed file containing one verbatim is evidence this
 * login wrote it, not a concurrent unrelated rewrite. Both OAuth tokens
 * are needles because some stores persist only the access token.
 */
export function attributableSecrets(credential: Credential): string[] {
  if (credential.type === 'oauth') return [credential.refresh, credential.access].filter(secret => secret !== '')
  return credential.key === undefined || credential.key === '' ? [] : [credential.key]
}

/**
 * Narrows changed files to the ones containing a fresh secret verbatim.
 * File bytes are decoded in memory, compared, and dropped — never logged,
 * never persisted. When there is nothing to attribute with (empty secrets),
 * returns no attribution so callers fall back to the change heuristic.
 */
export async function attributeChangedFilesToSecrets(
  dir: string,
  files: readonly string[],
  secrets: readonly string[],
): Promise<string[]> {
  const needles = secrets.filter(secret => secret !== '')
  if (needles.length === 0) return []
  const attributed: string[] = []
  for (const name of files) {
    let text: string | undefined
    try {
      // latin1 maps every byte 1:1, so binary envelopes cannot hide a match.
      text = (await readFile(join(dir, name))).toString('latin1')
    } catch {
      continue
    }
    try {
      if (needles.some(needle => text?.includes(needle) === true)) attributed.push(name)
    } finally {
      text = undefined
    }
  }
  return attributed
}

/**
 * Notice for the upstream-first path: the typed pool label is unused because
 * no pooled copy is stored, and pre-add pool preferences cannot persist
 * without an account, so both are named plainly. Names the discarded label
 * so the operator does not go looking for it in /accounts.
 */
export function upstreamOnlyNotice(providerName: string, label?: string): string {
  const kept = label === undefined || label.trim() === ''
    ? ''
    : ` Label "${label.trim()}" was not kept —`
  return `Saved as the native ${providerName} credential (upstream).${kept} No pool created — the next /multilogin add will start one.`
}

export interface PendingUpstreamProvider {
  id: string
  label: string
}

/**
 * Providers with a live native credential but no pool: the upstream-first
 * add state. Pure over injected inputs so the commands stay thin; the
 * caller supplies the full provider list, the pooled ids, and Pi core
 * status. Pi core status is blind to provider-owned native stores, so a
 * freshly backfilled credential can be missing here until Pi re-resolves —
 * the notice shown at add time already covered that moment.
 */
export function pendingUpstreamProviders(
  all: readonly PendingUpstreamProvider[],
  pooledIds: ReadonlySet<string>,
  isConfigured: (providerId: string) => boolean,
): PendingUpstreamProvider[] {
  return all.filter(provider => !pooledIds.has(provider.id) && isConfigured(provider.id))
}

/**
 * Ids whose upstream-first marker is still live: no pool, and at least one
 * recorded native file still present in the agent dir. Markers retire when a
 * pool is created (see addAccount); a recorded file disappearing means the
 * native credential was removed out-of-band, so the pending hint retires
 * too instead of pointing at nothing.
 */
export function markerPendingUpstreamIds(
  markers: Record<string, UpstreamOnlyMarker>,
  pooledIds: ReadonlySet<string>,
  filesPresent: ReadonlySet<string>,
): string[] {
  return Object.entries(markers)
    .filter(([id, marker]) =>
      !pooledIds.has(id) && marker.watchedFiles.some(file => filesPresent.has(file)))
    .map(([id]) => id)
}

/**
 * `/accounts` lines for pending upstream providers, in the same two-space
 * style as the pooled account lines. Deliberately claims no account
 * identity: multiprovider observed a native write, not which account.
 */
export function pendingUpstreamStatusLines(pending: readonly PendingUpstreamProvider[]): string[] {
  const lines: string[] = []
  for (const provider of pending) {
    lines.push(`${provider.label} (${provider.id}) · no pool yet`)
    lines.push('  Pi default (upstream) · native credential, not pooled · next /multilogin add starts the pool')
  }
  return lines
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
