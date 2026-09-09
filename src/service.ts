import { randomUUID } from 'node:crypto'
import { NoAccountAvailableError, UnknownAccountError, UnknownProviderError } from './errors.ts'
import { SCHEDULER_SETTING_KEYS } from './types.ts'
import type {
  AccountLease,
  AccountPreference,
  AcquireOptions,
  AffinityPin,
  FailureDisposition,
  FailureKind,
  LeaseOutcome,
  MultiProviderSnapshot,
  PoolPreference,
  ProviderAccount,
  ProviderAttemptFailure,
  ProviderRegistration,
  PublicAccountSnapshot,
  SchedulerSettings,
  PublicPoolSnapshot,
  SchedulerOptions,
  SelectionBias,
  SelectionPolicy,
} from './types.ts'

interface RuntimeState {
  inFlight: number
  consecutiveFailures: number
  cooldownUntil: number
  lastSelectedAt?: number
  lastFailureKind?: FailureKind
}

interface EffectiveAccount {
  account: ProviderAccount
  enabled: boolean
  weight: number
  priority: number
  runtime: RuntimeState
}

// Plain round-robin prefers the first healthy account in pool order by
// default so new sessions start on the operator's main account; register a
// provider with selectionBias 'none' for even rotation instead.
const DEFAULT_SELECTION_BIAS: SelectionBias = 'first-account'

const DEFAULTS = {
  defaultPolicy: 'round-robin' as SelectionPolicy,
  affinity: true,
  rateLimitCooldownMs: 60_000,
  quotaCooldownMs: 15 * 60_000,
  authCooldownMs: 5 * 60_000,
  transientBaseCooldownMs: 1_000,
  maxCooldownMs: 60 * 60_000,
}

export const SCHEDULER_DEFAULTS: Required<SchedulerSettings> = {
  rateLimitCooldownMs: DEFAULTS.rateLimitCooldownMs,
  quotaCooldownMs: DEFAULTS.quotaCooldownMs,
  authCooldownMs: DEFAULTS.authCooldownMs,
  transientBaseCooldownMs: DEFAULTS.transientBaseCooldownMs,
  maxCooldownMs: DEFAULTS.maxCooldownMs,
}

function stateKey(providerId: string, accountId: string): string {
  return JSON.stringify([providerId, accountId])
}

function statusFromFailure(failure: ProviderAttemptFailure): number | undefined {
  if (failure.status !== undefined) return failure.status
  const leading = failure.message.match(/^(?:http\s*)?(\d{3})(?::|\s|$)/i)
  const labelled = failure.message.match(/\bstatus(?:\s+code)?\s*[:=]?\s*(\d{3})\b/i)
  const value = leading?.[1] ?? labelled?.[1]
  return value === undefined ? undefined : Number(value)
}

function defaultDisposition(failure: ProviderAttemptFailure): FailureDisposition {
  const message = failure.message.toLowerCase()
  const status = statusFromFailure(failure)
  if (status === 429 || /rate.?limit|too many requests|overloaded/.test(message)) {
    return { kind: 'rate-limit', retryable: true }
  }
  if (status === 402 || /quota|usage.?limit|limit.*reached|out of credits/.test(message)) {
    return { kind: 'quota', retryable: true }
  }
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid.*(?:token|api.?key|auth|grant)|(?:token|credential).*(?:expired|invalid)/.test(message)) {
    return { kind: 'auth', retryable: true }
  }
  if (status !== undefined && (status >= 500 || status === 408 || status === 425)) {
    return { kind: 'transient', retryable: true }
  }
  return { kind: 'fatal', retryable: false }
}

export class MultiProviderService {
  private readonly providers = new Map<string, ProviderRegistration>()
  private readonly preferences = new Map<string, PoolPreference>()
  private readonly runtime = new Map<string, RuntimeState>()
  private readonly selectionBias = new Map<string, SelectionBias>()
  private readonly affinity = new Map<string, Map<string, string>>()
  private readonly explicitAffinity = new Map<string, Set<string>>()
  private readonly roundRobinCursor = new Map<string, number>()
  private readonly smoothScores = new Map<string, Map<string, number>>()
  private readonly defaults: Required<Omit<SchedulerOptions, 'now' | 'randomId'>>
  private readonly now: () => number
  private readonly randomId: () => string

  constructor(options: SchedulerOptions = {}) {
    this.defaults = {
      defaultPolicy: options.defaultPolicy ?? DEFAULTS.defaultPolicy,
      affinity: options.affinity ?? DEFAULTS.affinity,
      rateLimitCooldownMs: options.rateLimitCooldownMs ?? DEFAULTS.rateLimitCooldownMs,
      quotaCooldownMs: options.quotaCooldownMs ?? DEFAULTS.quotaCooldownMs,
      authCooldownMs: options.authCooldownMs ?? DEFAULTS.authCooldownMs,
      transientBaseCooldownMs: options.transientBaseCooldownMs ?? DEFAULTS.transientBaseCooldownMs,
      maxCooldownMs: options.maxCooldownMs ?? DEFAULTS.maxCooldownMs,
    }
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
  }

  registerProvider<TCredentialRef>(registration: ProviderRegistration<TCredentialRef>): () => void {
    if (registration.id.trim() === '') throw new Error('multiprovider: provider id must not be empty')
    if (this.providers.has(registration.id)) {
      throw new Error(`multiprovider: duplicate provider "${registration.id}"`)
    }
    this.providers.set(registration.id, registration as ProviderRegistration)
    this.selectionBias.set(registration.id, registration.selectionBias ?? DEFAULT_SELECTION_BIAS)
    return () => {
      if (this.providers.get(registration.id) !== registration) return
      this.providers.delete(registration.id)
      this.selectionBias.delete(registration.id)
      this.affinity.delete(registration.id)
      this.explicitAffinity.delete(registration.id)
      this.roundRobinCursor.delete(registration.id)
      this.smoothScores.delete(registration.id)
    }
  }

  hasProvider(providerId: string): boolean {
    return this.providers.has(providerId)
  }

  async hasEnabledAccounts(providerId: string): Promise<boolean> {
    const registration = this.registration(providerId)
    const pool = this.pool(providerId)
    return (await this.effectiveAccounts(registration, pool)).some(item => item.enabled)
  }

  async acquire<TCredentialRef = unknown>(options: AcquireOptions): Promise<AccountLease<TCredentialRef>> {
    const registration = this.registration(options.providerId)
    const pool = this.pool(options.providerId)
    const accounts = await this.effectiveAccounts(registration, pool)
    const excluded = new Set(options.excludeAccountIds ?? [])
    const now = this.now()
    const available = accounts.filter(item =>
      item.enabled && item.runtime.cooldownUntil <= now && !excluded.has(item.account.id),
    )

    if (available.length === 0) {
      const future = accounts
        .filter(item => item.enabled && !excluded.has(item.account.id) && item.runtime.cooldownUntil > now)
        .map(item => item.runtime.cooldownUntil)
      throw new NoAccountAvailableError(
        options.providerId,
        future.length === 0 ? undefined : Math.min(...future),
      )
    }

    let selected: EffectiveAccount | undefined
    let pinnedId: string | undefined
    let explicitPin = false
    if (options.affinityKey !== undefined) {
      pinnedId = this.affinity.get(options.providerId)?.get(options.affinityKey)
      explicitPin = pinnedId !== undefined
        && this.explicitAffinity.get(options.providerId)?.has(options.affinityKey) === true
      if (explicitPin && !accounts.some(item => item.account.id === pinnedId && item.enabled)) {
        // The explicitly pinned account was removed or disabled: drop the pin
        // and fall back to automatic selection for the rest of the session.
        this.affinity.get(options.providerId)?.delete(options.affinityKey)
        this.explicitAffinity.get(options.providerId)?.delete(options.affinityKey)
        pinnedId = undefined
        explicitPin = false
      }
      // Explicit pins override the pool's affinity setting; implicit pins only
      // apply while the operator left session affinity enabled.
      if ((pool.affinity || explicitPin) && pinnedId !== undefined) {
        selected = available.find(item => item.account.id === pinnedId)
      }
    }
    selected ??= this.select(options.providerId, pool.policy, available)

    if (options.affinityKey !== undefined && pool.affinity && !explicitPin) {
      let table = this.affinity.get(options.providerId)
      if (table === undefined) {
        table = new Map()
        this.affinity.set(options.providerId, table)
      }
      table.set(options.affinityKey, selected.account.id)
    }

    selected.runtime.inFlight += 1
    selected.runtime.lastSelectedAt = now
    let released = false
    const account = selected.account as ProviderAccount<TCredentialRef>

    return {
      id: this.randomId(),
      providerId: options.providerId,
      accountId: account.id,
      account,
      credentialRef: account.credentialRef,
      acquiredAt: now,
      release: (outcome: LeaseOutcome = { status: 'cancelled' }) => {
        if (released) return undefined
        released = true
        selected.runtime.inFlight = Math.max(0, selected.runtime.inFlight - 1)
        if (outcome.status === 'success') this.recordSuccess(options.providerId, account.id)
        else if (outcome.status === 'failure') {
          return this.recordFailure(registration, account, outcome.error)
        }
        return undefined
      },
    }
  }

  async snapshot(): Promise<MultiProviderSnapshot> {
    const providers: PublicPoolSnapshot[] = []
    for (const registration of this.providers.values()) {
      const pool = this.pool(registration.id)
      const effective = await this.effectiveAccounts(registration, pool)
      const now = this.now()
      const accounts: PublicAccountSnapshot[] = effective.map(({
        account, enabled, weight, priority, runtime,
      }) => ({
        id: account.id,
        label: account.label,
        authKind: account.authKind,
        enabled,
        weight,
        priority,
        status: !enabled ? 'disabled' : runtime.cooldownUntil > now ? 'cooldown' : 'ready',
        inFlight: runtime.inFlight,
        consecutiveFailures: runtime.consecutiveFailures,
        ...(runtime.cooldownUntil > now ? { cooldownUntil: runtime.cooldownUntil } : {}),
        ...(runtime.lastSelectedAt === undefined ? {} : { lastSelectedAt: runtime.lastSelectedAt }),
        ...(runtime.lastFailureKind === undefined ? {} : { lastFailureKind: runtime.lastFailureKind }),
        metadata: account.metadata ?? {},
      }))
      providers.push({
        id: registration.id,
        label: registration.label,
        policy: pool.policy,
        affinity: pool.affinity,
        firstAccountBias: (this.selectionBias.get(registration.id) ?? DEFAULT_SELECTION_BIAS) === 'first-account',
        ...(registration.managementHint === undefined
          ? {}
          : { managementHint: registration.managementHint }),
        accounts,
      })
    }
    return { providers }
  }

  async updatePool(
    providerId: string,
    patch: Partial<Pick<PoolPreference, 'policy' | 'affinity' | 'accounts'>>,
  ): Promise<PublicPoolSnapshot> {
    this.registration(providerId)
    const current = this.pool(providerId)
    const next: PoolPreference = {
      providerId,
      policy: patch.policy ?? current.policy,
      affinity: patch.affinity ?? current.affinity,
      accounts: (patch.accounts ?? current.accounts).map(account => ({ ...account })),
    }
    this.preferences.set(providerId, next)
    const result = (await this.snapshot()).providers.find(provider => provider.id === providerId)
    if (result === undefined) throw new UnknownProviderError(providerId)
    return result
  }

  getPoolPreference(providerId: string): PoolPreference {
    this.registration(providerId)
    return this.pool(providerId)
  }

  updateSchedulerDefaults(settings: SchedulerSettings): void {
    for (const key of SCHEDULER_SETTING_KEYS) {
      const value = settings[key]
      if (value === undefined) continue
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`multiprovider: scheduler setting "${key}" must be a non-negative number`)
      }
      this.defaults[key] = value
    }
  }

  resetHealth(providerId: string, accountId: string): void {
    this.registration(providerId)
    const runtime = this.runtime.get(stateKey(providerId, accountId))
    if (runtime === undefined) return
    runtime.consecutiveFailures = 0
    runtime.cooldownUntil = 0
    delete runtime.lastFailureKind
  }

  async pinAccount(providerId: string, affinityKey: string, accountId: string): Promise<void> {
    const registration = this.registration(providerId)
    const pool = this.pool(providerId)
    const accounts = await this.effectiveAccounts(registration, pool)
    const target = accounts.find(item => item.account.id === accountId)
    if (target === undefined) throw new UnknownAccountError(providerId, accountId)
    if (!target.enabled) {
      throw new Error(`multiprovider: account "${target.account.label}" is disabled`)
    }
    let table = this.affinity.get(providerId)
    if (table === undefined) {
      table = new Map()
      this.affinity.set(providerId, table)
    }
    table.set(affinityKey, accountId)
    let explicit = this.explicitAffinity.get(providerId)
    if (explicit === undefined) {
      explicit = new Set()
      this.explicitAffinity.set(providerId, explicit)
    }
    explicit.add(affinityKey)
  }

  getAffinity(providerId: string, affinityKey: string): AffinityPin | undefined {
    this.registration(providerId)
    const accountId = this.affinity.get(providerId)?.get(affinityKey)
    if (accountId === undefined) return undefined
    return {
      accountId,
      explicit: this.explicitAffinity.get(providerId)?.has(affinityKey) === true,
    }
  }

  clearAffinity(providerId?: string, affinityKey?: string): void {
    if (providerId === undefined) {
      this.affinity.clear()
      this.explicitAffinity.clear()
      return
    }
    if (affinityKey === undefined) {
      this.affinity.delete(providerId)
      this.explicitAffinity.delete(providerId)
      return
    }
    this.affinity.get(providerId)?.delete(affinityKey)
    this.explicitAffinity.get(providerId)?.delete(affinityKey)
  }

  private registration(providerId: string): ProviderRegistration {
    const registration = this.providers.get(providerId)
    if (registration === undefined) throw new UnknownProviderError(providerId)
    return registration
  }

  private pool(providerId: string): PoolPreference {
    const configured = this.preferences.get(providerId)
    return configured === undefined
      ? {
          providerId,
          policy: this.defaults.defaultPolicy,
          affinity: this.defaults.affinity,
          accounts: [],
        }
      : {
          ...configured,
          accounts: configured.accounts.map(account => ({ ...account })),
        }
  }

  private runtimeFor(providerId: string, accountId: string): RuntimeState {
    const key = stateKey(providerId, accountId)
    let runtime = this.runtime.get(key)
    if (runtime === undefined) {
      runtime = { inFlight: 0, consecutiveFailures: 0, cooldownUntil: 0 }
      this.runtime.set(key, runtime)
    }
    return runtime
  }

  private async effectiveAccounts(
    registration: ProviderRegistration,
    pool: PoolPreference,
  ): Promise<EffectiveAccount[]> {
    const inventory = [...await registration.accounts()]
    const seen = new Set<string>()
    const preferences = new Map(pool.accounts.map(account => [account.accountId, account]))
    return inventory.map(account => {
      if (account.id.trim() === '') {
        throw new Error(`multiprovider: provider "${registration.id}" returned an empty account id`)
      }
      if (seen.has(account.id)) {
        throw new Error(`multiprovider: provider "${registration.id}" returned duplicate account "${account.id}"`)
      }
      seen.add(account.id)
      const preference = preferences.get(account.id)
      return {
        account,
        enabled: account.enabled !== false && (preference?.enabled ?? true),
        weight: preference?.weight ?? account.weight ?? 1,
        priority: preference?.priority ?? account.priority ?? 0,
        runtime: this.runtimeFor(registration.id, account.id),
      }
    })
  }

  private select(
    providerId: string,
    policy: SelectionPolicy,
    accounts: EffectiveAccount[],
  ): EffectiveAccount {
    const ordered = [...accounts].sort((left, right) =>
      left.account.id.localeCompare(right.account.id),
    )
    if (policy === 'least-inflight') {
      return ordered.sort((left, right) =>
        left.runtime.inFlight - right.runtime.inFlight
        || (left.runtime.lastSelectedAt ?? 0) - (right.runtime.lastSelectedAt ?? 0),
      )[0]!
    }
    if (policy === 'priority') {
      return ordered.sort((left, right) =>
        left.priority - right.priority
        || left.runtime.inFlight - right.runtime.inFlight
        || (left.runtime.lastSelectedAt ?? 0) - (right.runtime.lastSelectedAt ?? 0),
      )[0]!
    }
    if (policy === 'weighted-round-robin') {
      return this.selectWeighted(providerId, ordered)
    }
    // Plain round-robin. accounts preserves pool (inventory) order, so the
    // first entry is the operator's main account; bias keeps new sessions on
    // it and only spills over while it is cooling down, disabled, or excluded.
    if ((this.selectionBias.get(providerId) ?? DEFAULT_SELECTION_BIAS) === 'first-account') {
      return accounts[0]!
    }
    const cursor = this.roundRobinCursor.get(providerId) ?? 0
    const selected = ordered[cursor % ordered.length]!
    this.roundRobinCursor.set(providerId, (cursor + 1) % ordered.length)
    return selected
  }

  private selectWeighted(providerId: string, accounts: EffectiveAccount[]): EffectiveAccount {
    let scores = this.smoothScores.get(providerId)
    if (scores === undefined) {
      scores = new Map()
      this.smoothScores.set(providerId, scores)
    }
    const live = new Set(accounts.map(item => item.account.id))
    for (const id of scores.keys()) if (!live.has(id)) scores.delete(id)
    const total = accounts.reduce((sum, item) => sum + Math.max(1, item.weight), 0)
    let selected = accounts[0]!
    let best = Number.NEGATIVE_INFINITY
    for (const item of accounts) {
      const score = (scores.get(item.account.id) ?? 0) + Math.max(1, item.weight)
      scores.set(item.account.id, score)
      if (score > best) {
        best = score
        selected = item
      }
    }
    scores.set(selected.account.id, (scores.get(selected.account.id) ?? 0) - total)
    return selected
  }

  private recordSuccess(providerId: string, accountId: string): void {
    const runtime = this.runtimeFor(providerId, accountId)
    runtime.consecutiveFailures = 0
    runtime.cooldownUntil = 0
    delete runtime.lastFailureKind
  }

  private recordFailure(
    registration: ProviderRegistration,
    account: ProviderAccount,
    failure: ProviderAttemptFailure,
  ): FailureDisposition {
    let disposition: FailureDisposition
    try {
      disposition = registration.classifyFailure?.(failure, account)
        ?? defaultDisposition(failure)
    } catch {
      disposition = { kind: 'fatal', retryable: false }
    }
    const runtime = this.runtimeFor(registration.id, account.id)
    runtime.consecutiveFailures += 1
    runtime.lastFailureKind = disposition.kind
    const cooldown = disposition.cooldownMs
      ?? this.defaultCooldown(disposition.kind, runtime.consecutiveFailures)
    runtime.cooldownUntil = Math.max(
      runtime.cooldownUntil,
      this.now() + Math.min(this.defaults.maxCooldownMs, Math.max(0, cooldown)),
    )
    return disposition
  }

  private defaultCooldown(kind: FailureKind, failures: number): number {
    if (kind === 'rate-limit') return this.defaults.rateLimitCooldownMs
    if (kind === 'quota') return this.defaults.quotaCooldownMs
    if (kind === 'auth') return this.defaults.authCooldownMs
    if (kind === 'transient') {
      return this.defaults.transientBaseCooldownMs * 2 ** Math.min(10, failures - 1)
    }
    return 0
  }
}
