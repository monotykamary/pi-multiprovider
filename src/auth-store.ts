import { access, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Api,
  AuthContext,
  AuthResult,
  Credential,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { SCHEDULER_SETTING_KEYS } from './types.ts'
import type { AuthKind, SchedulerSettings, SchedulerSettingsPatch, SelectionPolicy } from './types.ts'

export const MULTIPROVIDER_AUTH_FILE = 'multiprovider-auth.json'

export interface MultiAuthAccount {
  id: string
  label: string
  authKind: AuthKind
  enabled: boolean
  weight: number
  priority: number
  createdAt: string
  updatedAt: string
}

export interface MultiAuthUpstreamPreferences {
  label?: string
  weight?: number
  priority?: number
}

export interface MultiAuthPool {
  providerId: string
  policy: SelectionPolicy
  affinity: boolean
  includeUpstream: boolean
  upstream?: MultiAuthUpstreamPreferences
  accounts: MultiAuthAccount[]
}

export interface AddMultiAuthAccount {
  label: string
  credential: Credential
  enabled?: boolean
  weight?: number
  priority?: number
  pool?: MultiAuthPoolSettings
}

export interface MultiAuthPoolSettings {
  policy?: SelectionPolicy
  affinity?: boolean
  includeUpstream?: boolean
  upstream?: MultiAuthUpstreamPreferences
}

export interface MultiAuthAccountSettings {
  label?: string
  enabled?: boolean
  weight?: number
  priority?: number
}

interface PersistedAccount extends MultiAuthAccount {
  credential: Credential
}

interface PersistedPool {
  policy: SelectionPolicy
  affinity: boolean
  includeUpstream: boolean
  upstream?: MultiAuthUpstreamPreferences
  accounts: PersistedAccount[]
}

interface PersistedState {
  version: 1
  scheduler?: SchedulerSettings
  providers: Record<string, PersistedPool>
}

const DEFAULT_POLICY: SelectionPolicy = 'round-robin'
const LOCK_STALE_MS = 120_000
const LOCK_TIMEOUT_MS = 15_000
const OAUTH_REFRESH_SKEW_MS = 5 * 60_000
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])

function emptyState(): PersistedState {
  return { version: 1, providers: {} }
}

function assertSafeKey(value: string, label: string): void {
  if (value.trim() === '' || unsafeKeys.has(value)) throw new Error(`multiprovider: invalid ${label}`)
}

function assertCredential(value: unknown): asserts value is Credential {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new Error('multiprovider: malformed stored credential')
  }
  const type = (value as { type?: unknown }).type
  if (type !== 'api_key' && type !== 'oauth') {
    throw new Error('multiprovider: unsupported stored credential type')
  }
}

function assertUpstreamPreferences(value: unknown): asserts value is MultiAuthUpstreamPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('multiprovider: malformed upstream preferences')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.label !== undefined && typeof candidate.label !== 'string') {
    throw new Error('multiprovider: malformed upstream label')
  }
  for (const key of ['weight', 'priority'] as const) {
    const entry = candidate[key]
    if (entry !== undefined && (typeof entry !== 'number' || !Number.isFinite(entry))) {
      throw new Error(`multiprovider: malformed upstream ${key}`)
    }
  }
}

function assertSchedulerSettings(value: unknown): asserts value is SchedulerSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('multiprovider: malformed scheduler settings')
  }
  const candidate = value as Record<string, unknown>
  for (const key of SCHEDULER_SETTING_KEYS) {
    const entry = candidate[key]
    if (entry !== undefined && (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)) {
      throw new Error(`multiprovider: malformed scheduler setting "${key}"`)
    }
  }
}

function parseState(text: string): PersistedState {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) {
    throw new Error('multiprovider: auth store must contain an object')
  }
  const candidate = value as Partial<PersistedState>
  if (candidate.version !== 1 || typeof candidate.providers !== 'object' || candidate.providers === null) {
    throw new Error('multiprovider: unsupported auth store format')
  }
  if (candidate.scheduler !== undefined) assertSchedulerSettings(candidate.scheduler)
  for (const [providerId, poolValue] of Object.entries(candidate.providers)) {
    assertSafeKey(providerId, 'provider id')
    if (typeof poolValue !== 'object' || poolValue === null) {
      throw new Error(`multiprovider: malformed pool for "${providerId}"`)
    }
    const pool = poolValue as Partial<PersistedPool>
    if (!Array.isArray(pool.accounts)) {
      throw new Error(`multiprovider: malformed accounts for "${providerId}"`)
    }
    if (pool.upstream !== undefined) assertUpstreamPreferences(pool.upstream)
    for (const accountValue of pool.accounts) {
      if (typeof accountValue !== 'object' || accountValue === null) {
        throw new Error(`multiprovider: malformed account for "${providerId}"`)
      }
      const account = accountValue as Partial<PersistedAccount>
      if (typeof account.id !== 'string' || typeof account.label !== 'string') {
        throw new Error(`multiprovider: malformed account identity for "${providerId}"`)
      }
      assertSafeKey(account.id, 'account id')
      assertCredential(account.credential)
    }
  }
  return candidate as PersistedState
}

function publicAccount(account: PersistedAccount): MultiAuthAccount {
  const { credential: _credential, ...snapshot } = account
  return structuredClone(snapshot)
}

function publicPool(providerId: string, pool: PersistedPool): MultiAuthPool {
  return {
    providerId,
    policy: pool.policy,
    affinity: pool.affinity,
    includeUpstream: pool.includeUpstream,
    ...(pool.upstream === undefined ? {} : { upstream: { ...pool.upstream } }),
    accounts: pool.accounts.map(publicAccount),
  }
}

function normalizeWeight(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : 1
}

function normalizePriority(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value!) : fallback
}

export function normalizeUpstreamPreferences(
  input: MultiAuthUpstreamPreferences,
): MultiAuthUpstreamPreferences {
  const normalized: MultiAuthUpstreamPreferences = {}
  if (input.label !== undefined) {
    const label = input.label.trim()
    if (label !== '') normalized.label = label
  }
  if (input.weight !== undefined) normalized.weight = normalizeWeight(input.weight)
  if (input.priority !== undefined) normalized.priority = normalizePriority(input.priority, 0)
  return normalized
}

function expandPath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(path)
}

const authContext: AuthContext = {
  async env(name) {
    return process.env[name]
  },
  async fileExists(path) {
    try {
      await access(expandPath(path))
      return true
    } catch {
      return false
    }
  },
}

function abortError(): Error {
  return new Error('multiprovider: operation cancelled')
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError()
  let abort: (() => void) | undefined
  try {
    await new Promise<void>((resolvePause, reject) => {
      const timer = setTimeout(resolvePause, ms)
      abort = () => {
        clearTimeout(timer)
        reject(abortError())
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  } finally {
    if (abort !== undefined) signal?.removeEventListener('abort', abort)
  }
}

export function getMultiAuthPath(): string {
  return join(getAgentDir(), MULTIPROVIDER_AUTH_FILE)
}

export class MultiAuthStore {
  readonly path: string
  private readonly lockPath: string

  constructor(path = getMultiAuthPath()) {
    this.path = path
    this.lockPath = `${path}.lock`
  }

  async listProviderIds(): Promise<string[]> {
    const state = await this.readState()
    return Object.entries(state.providers)
      .filter(([, pool]) => pool.accounts.length > 0)
      .map(([providerId]) => providerId)
      .sort()
  }

  async getPool(providerId: string): Promise<MultiAuthPool | undefined> {
    const state = await this.readState()
    const pool = state.providers[providerId]
    return pool === undefined ? undefined : publicPool(providerId, pool)
  }

  async hasAccounts(providerId: string): Promise<boolean> {
    return (await this.getPool(providerId))?.accounts.some(account => account.enabled) ?? false
  }

  async addAccount(providerId: string, input: AddMultiAuthAccount): Promise<MultiAuthAccount> {
    assertSafeKey(providerId, 'provider id')
    const label = input.label.trim()
    if (label === '') throw new Error('multiprovider: account label is required')
    assertCredential(input.credential)
    return this.mutate(state => {
      const pool = state.providers[providerId] ?? {
        policy: DEFAULT_POLICY,
        affinity: true,
        includeUpstream: true,
        accounts: [],
      }
      state.providers[providerId] = pool
      if (input.pool?.policy !== undefined) pool.policy = input.pool.policy
      if (input.pool?.affinity !== undefined) pool.affinity = input.pool.affinity
      if (input.pool?.includeUpstream !== undefined) pool.includeUpstream = input.pool.includeUpstream
      if (input.pool?.upstream !== undefined) {
        const upstream = normalizeUpstreamPreferences({ ...pool.upstream, ...input.pool.upstream })
        if (Object.keys(upstream).length === 0) delete pool.upstream
        else pool.upstream = upstream
      }
      const now = new Date().toISOString()
      const account: PersistedAccount = {
        id: randomUUID(),
        label,
        authKind: input.credential.type === 'oauth' ? 'oauth' : 'api-key',
        credential: structuredClone(input.credential),
        enabled: input.enabled ?? true,
        weight: normalizeWeight(input.weight),
        priority: normalizePriority(input.priority, pool.accounts.length + 1),
        createdAt: now,
        updatedAt: now,
      }
      pool.accounts.push(account)
      return publicAccount(account)
    })
  }

  async removeAccount(providerId: string, accountId: string): Promise<boolean> {
    return this.mutate(state => {
      const pool = state.providers[providerId]
      if (pool === undefined) return false
      const index = pool.accounts.findIndex(account => account.id === accountId)
      if (index < 0) return false
      pool.accounts.splice(index, 1)
      if (pool.accounts.length === 0) delete state.providers[providerId]
      return true
    })
  }

  async updatePool(providerId: string, settings: MultiAuthPoolSettings): Promise<MultiAuthPool> {
    assertSafeKey(providerId, 'provider id')
    return this.mutate(state => {
      const pool = state.providers[providerId]
      if (pool === undefined) throw new Error(`multiprovider: unknown stored pool "${providerId}"`)
      if (settings.policy !== undefined) pool.policy = settings.policy
      if (settings.affinity !== undefined) pool.affinity = settings.affinity
      if (settings.includeUpstream !== undefined) pool.includeUpstream = settings.includeUpstream
      if (settings.upstream !== undefined) {
        const upstream = normalizeUpstreamPreferences(settings.upstream)
        if (Object.keys(upstream).length === 0) delete pool.upstream
        else pool.upstream = upstream
      }
      return publicPool(providerId, pool)
    })
  }

  async updateAccount(
    providerId: string,
    accountId: string,
    settings: MultiAuthAccountSettings,
  ): Promise<MultiAuthAccount> {
    return this.mutate(state => {
      const account = state.providers[providerId]?.accounts.find(candidate => candidate.id === accountId)
      if (account === undefined) throw new Error(`multiprovider: unknown stored account "${accountId}"`)
      if (settings.label !== undefined) {
        const label = settings.label.trim()
        if (label === '') throw new Error('multiprovider: account label is required')
        account.label = label
      }
      if (settings.enabled !== undefined) account.enabled = settings.enabled
      if (settings.weight !== undefined) account.weight = normalizeWeight(settings.weight)
      if (settings.priority !== undefined) account.priority = normalizePriority(settings.priority, account.priority)
      account.updatedAt = new Date().toISOString()
      return publicAccount(account)
    })
  }

  async getSchedulerSettings(): Promise<SchedulerSettings> {
    const state = await this.readState()
    const current = state.scheduler ?? {}
    const result: Partial<Record<(typeof SCHEDULER_SETTING_KEYS)[number], number>> = {}
    for (const key of SCHEDULER_SETTING_KEYS) {
      const value = current[key]
      if (value !== undefined) result[key] = value
    }
    return { ...result } as SchedulerSettings
  }

  async updateSchedulerSettings(settings: SchedulerSettingsPatch): Promise<SchedulerSettings> {
    return this.mutate(state => {
      const current = state.scheduler ?? {}
      const next: Partial<Record<(typeof SCHEDULER_SETTING_KEYS)[number], number>> = {}
      for (const key of SCHEDULER_SETTING_KEYS) {
        const value = key in settings ? settings[key] : current[key]
        if (value === undefined) continue
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`multiprovider: scheduler setting "${key}" must be a non-negative number`)
        }
        next[key] = value
      }
      if (Object.keys(next).length === 0) delete state.scheduler
      else state.scheduler = { ...next } as SchedulerSettings
      return { ...next } as SchedulerSettings
    })
  }

  async resolveAccount<TApi extends Api>(
    provider: Provider<TApi>,
    accountId: string,
    signal: AbortSignal,
  ): Promise<AuthResult> {
    if (signal.aborted) throw abortError()
    const state = await this.readState()
    const account = state.providers[provider.id]?.accounts.find(candidate => candidate.id === accountId)
    if (account === undefined || !account.enabled) {
      throw new Error(`multiprovider: stored account "${accountId}" is unavailable`)
    }

    if (account.credential.type === 'api_key') {
      const method = provider.auth.apiKey
      if (method === undefined) {
        throw new Error(`multiprovider: provider "${provider.id}" does not support API-key auth`)
      }
      const resolution = await method.resolve({
        ctx: authContext,
        credential: structuredClone(account.credential),
        signal,
      })
      if (resolution === undefined) {
        throw new Error(`multiprovider: stored account "${account.label}" did not resolve auth`)
      }
      return {
        ...resolution,
        source: `${account.label} · ${resolution.source ?? method.name}`,
      }
    }

    const method = provider.auth.oauth
    if (method === undefined) {
      throw new Error(`multiprovider: provider "${provider.id}" does not support OAuth`)
    }
    const resolved = await this.withLock(async () => {
      const lockedState = await this.readStateUnlocked()
      const lockedAccount = lockedState.providers[provider.id]?.accounts.find(
        candidate => candidate.id === accountId,
      )
      if (lockedAccount === undefined || lockedAccount.credential.type !== 'oauth') {
        throw new Error(`multiprovider: stored OAuth account "${accountId}" is unavailable`)
      }
      let credential: OAuthCredential = structuredClone(lockedAccount.credential)
      if (credential.expires <= Date.now() + OAUTH_REFRESH_SKEW_MS) {
        credential = await method.refresh(credential, signal)
        assertCredential(credential)
        if (credential.type !== 'oauth') {
          throw new Error(`multiprovider: provider "${provider.id}" returned invalid OAuth credentials`)
        }
        lockedAccount.credential = structuredClone(credential)
        lockedAccount.updatedAt = new Date().toISOString()
        await this.writeStateUnlocked(lockedState)
      }
      return { credential, label: lockedAccount.label }
    }, signal)
    return {
      auth: await method.toAuth(resolved.credential),
      source: `${resolved.label} · ${method.name}`,
    }
  }

  private async mutate<T>(operation: (state: PersistedState) => T | Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const state = await this.readStateUnlocked()
      const result = await operation(state)
      await this.writeStateUnlocked(state)
      return result
    })
  }

  private async readState(): Promise<PersistedState> {
    return this.readStateUnlocked()
  }

  private async readStateUnlocked(): Promise<PersistedState> {
    try {
      return parseState(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
  }

  private async writeStateUnlocked(state: PersistedState): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${MULTIPROVIDER_AUTH_FILE}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.path)
      await chmod(this.path, 0o600)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }

  private async withLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const startedAt = Date.now()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    while (handle === undefined) {
      if (signal?.aborted) throw abortError()
      try {
        handle = await open(this.lockPath, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const lock = await stat(this.lockPath)
          if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
            await unlink(this.lockPath)
            continue
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw lockError
        }
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`multiprovider: timed out waiting for auth store lock at ${this.lockPath}`)
        }
        await pause(25, signal)
      }
    }

    try {
      return await operation()
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(this.lockPath).catch(() => undefined)
    }
  }
}
