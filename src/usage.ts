import { normalizeContext } from '@earendil-works/pi-ai'
import type { Api, AuthResult, Model, Provider } from '@earendil-works/pi-ai'
import { PI_UPSTREAM_ACCOUNT_ID } from './managed.ts'
import type { MultiProviderService } from './service.ts'
import type {
  AccountUsageSnapshot,
  MultiProviderIntegration,
  ProviderAccount,
  ProviderUsageSnapshot,
  UsageFetcher,
} from './types.ts'
import { builtInUsageFetcher, hasUsableToken } from './usage-adapters.ts'

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_CONCURRENCY = 3

export interface UsageServiceDependencies {
  scheduler: MultiProviderService
  getIntegration(providerId: string): MultiProviderIntegration<Api, unknown> | undefined
  getProvider(providerId: string): Provider<Api> | undefined
  getModel(providerId: string): Model<Api> | undefined
  resolveUpstreamAuth(
    providerId: string,
    provider: Provider<Api>,
    model: Model<Api>,
    signal: AbortSignal,
  ): Promise<AuthResult | undefined>
  isQuotaAware(providerId: string): boolean | Promise<boolean>
  ttlMs?: number
  timeoutMs?: number
  concurrency?: number
  now?: () => number
}

function cacheKey(providerId: string, accountId: string): string {
  return JSON.stringify([providerId, accountId])
}

function clone(snapshot: AccountUsageSnapshot): AccountUsageSnapshot {
  return structuredClone(snapshot)
}

function safeError(error: unknown, resolution?: AuthResult): string {
  let message = error instanceof Error ? error.message : String(error)
  const secrets = [
    resolution?.auth.apiKey,
    ...Object.values(resolution?.auth.headers ?? {}).filter((value): value is string => typeof value === 'string'),
  ]
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= 4) message = message.replaceAll(secret, '[redacted]')
  }
  const singleLine = message.replaceAll(/[\r\n]+/g, ' ').trim()
  return (singleLine === '' ? 'usage refresh failed' : singleLine).slice(0, 240)
}

function normalizeProviderSnapshot(
  snapshot: ProviderUsageSnapshot,
  now: number,
): Omit<ProviderUsageSnapshot, 'fetchedAt'> & { fetchedAt: number } {
  return {
    ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
    windows: snapshot.windows.map(window => ({
      ...window,
      ...(window.usedPercent === undefined
        ? {}
        : { usedPercent: Math.min(100, Math.max(0, window.usedPercent)) }),
    })),
    fetchedAt: Math.min(snapshot.fetchedAt ?? now, now),
  }
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(new Error('usage refresh timed out'))
    if (signal.aborted) rejectAbort()
    else signal.addEventListener('abort', rejectAbort, { once: true })
  })
}

export class UsageService {
  private readonly cache = new Map<string, AccountUsageSnapshot>()
  private readonly inFlight = new Map<string, Promise<AccountUsageSnapshot>>()
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly now: () => number

  constructor(private readonly dependencies: UsageServiceDependencies) {
    this.ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.concurrency = Math.max(1, Math.floor(dependencies.concurrency ?? DEFAULT_CONCURRENCY))
    this.now = dependencies.now ?? Date.now
  }

  getCached(providerId: string, accountId?: string): AccountUsageSnapshot[] {
    const now = this.now()
    const snapshots: AccountUsageSnapshot[] = []
    for (const [key, stored] of this.cache) {
      const [storedProvider, storedAccount] = JSON.parse(key) as [string, string]
      if (storedProvider !== providerId || (accountId !== undefined && storedAccount !== accountId)) continue
      const snapshot = clone(stored)
      if (snapshot.status === 'fresh' && now - snapshot.fetchedAt > this.ttlMs) {
        snapshot.status = 'stale'
        snapshot.stale = true
      }
      snapshots.push(snapshot)
    }
    return snapshots
  }

  async refreshProvider(providerId: string, force = true): Promise<AccountUsageSnapshot[]> {
    const integration = this.dependencies.getIntegration(providerId)
    if (integration === undefined) return []
    const accounts = [...await integration.accounts()]
    const results: AccountUsageSnapshot[] = []
    for (let index = 0; index < accounts.length; index += this.concurrency) {
      const batch = accounts.slice(index, index + this.concurrency)
      results.push(...await Promise.all(batch.map(account =>
        this.refreshAccount(providerId, account.id, force))))
    }
    return results
  }

  async refreshAccount(
    providerId: string,
    accountId: string,
    force = true,
  ): Promise<AccountUsageSnapshot> {
    const key = cacheKey(providerId, accountId)
    const current = this.cache.get(key)
    if (!force && current !== undefined && this.now() - current.fetchedAt <= this.ttlMs) {
      return clone(current)
    }
    const running = this.inFlight.get(key)
    if (running !== undefined) return clone(await running)
    const promise = this.performRefresh(providerId, accountId)
    this.inFlight.set(key, promise)
    try {
      return clone(await promise)
    } finally {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key)
    }
  }

  clear(providerId: string, accountId?: string): void {
    for (const key of this.cache.keys()) {
      const [storedProvider, storedAccount] = JSON.parse(key) as [string, string]
      if (storedProvider === providerId && (accountId === undefined || storedAccount === accountId)) {
        this.cache.delete(key)
      }
    }
    if (accountId === undefined) this.dependencies.scheduler.clearQuotaBlocks(providerId)
    else this.dependencies.scheduler.setQuotaBlock(providerId, accountId)
  }

  private async performRefresh(providerId: string, accountId: string): Promise<AccountUsageSnapshot> {
    const integration = this.dependencies.getIntegration(providerId)
    const provider = this.dependencies.getProvider(providerId)
    const model = this.dependencies.getModel(providerId)
    const account = integration === undefined
      ? undefined
      : (await integration.accounts()).find(candidate => candidate.id === accountId)
    if (integration === undefined || provider === undefined || model === undefined || account === undefined) {
      return this.storeUnsupported(providerId, accountId, account?.label ?? accountId, 'account is unavailable')
    }

    const integrationFetcher = integration.fetchUsage as UsageFetcher<Api, unknown> | undefined
    const fetchUsage = integrationFetcher ?? builtInUsageFetcher(providerId)
    if (fetchUsage === undefined) {
      return this.storeUnsupported(providerId, account.id, account.label, 'provider has no usage adapter')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const aborted = rejectWhenAborted(controller.signal)
    let resolution: AuthResult | undefined
    try {
      const resolving = account.id === PI_UPSTREAM_ACCOUNT_ID
        ? this.dependencies.resolveUpstreamAuth(providerId, provider, model, controller.signal)
        : integration.resolveAuth(account, controller.signal, {
            provider,
            model,
            context: normalizeContext({ messages: [] }),
            requestOptions: {},
            signal: controller.signal,
          })
      resolution = await Promise.race([Promise.resolve(resolving), aborted])
      if (resolution === undefined || (integrationFetcher === undefined && !hasUsableToken(resolution))) {
        return this.storeUnsupported(providerId, account.id, account.label, 'account auth cannot query usage')
      }
      const fetched = await Promise.race([
        Promise.resolve(fetchUsage({ provider, model, account, resolution, signal: controller.signal })),
        aborted,
      ])
      if (fetched === undefined) {
        return this.storeUnsupported(providerId, account.id, account.label, 'account auth is unsupported by this adapter')
      }
      const checkedAt = this.now()
      const normalized = normalizeProviderSnapshot(fetched, checkedAt)
      const fresh = checkedAt - normalized.fetchedAt <= this.ttlMs
      const snapshot: AccountUsageSnapshot = {
        providerId,
        accountId: account.id,
        accountLabel: account.label,
        status: fresh ? 'fresh' : 'stale',
        stale: !fresh,
        ...normalized,
      }
      this.cache.set(cacheKey(providerId, account.id), clone(snapshot))
      if (fresh) await this.applyRouting(snapshot)
      return snapshot
    } catch (error) {
      const key = cacheKey(providerId, account.id)
      const prior = this.cache.get(key)
      if (prior !== undefined && prior.windows.length > 0) {
        const stale: AccountUsageSnapshot = {
          ...prior,
          status: 'stale',
          stale: true,
          error: safeError(error, resolution),
        }
        this.cache.set(key, clone(stale))
        return stale
      }
      const failed: AccountUsageSnapshot = {
        providerId,
        accountId: account.id,
        accountLabel: account.label,
        status: 'error',
        stale: false,
        windows: [],
        fetchedAt: this.now(),
        error: controller.signal.aborted ? 'usage refresh timed out' : safeError(error, resolution),
      }
      this.cache.set(key, clone(failed))
      return failed
    } finally {
      clearTimeout(timeout)
    }
  }

  private storeUnsupported(
    providerId: string,
    accountId: string,
    accountLabel: string,
    error: string,
  ): AccountUsageSnapshot {
    const snapshot: AccountUsageSnapshot = {
      providerId,
      accountId,
      accountLabel,
      status: 'unsupported',
      stale: false,
      windows: [],
      fetchedAt: this.now(),
      error,
    }
    this.cache.set(cacheKey(providerId, accountId), clone(snapshot))
    return snapshot
  }

  private async applyRouting(snapshot: AccountUsageSnapshot): Promise<void> {
    if (!await this.dependencies.isQuotaAware(snapshot.providerId)) return
    const now = this.now()
    const exhaustedResets = snapshot.windows
      .filter(window => (window.usedPercent ?? 0) >= 100 || window.remaining === 0)
      .map(window => window.resetsAt)
      .filter((value): value is number => value !== undefined && value > now)
    this.dependencies.scheduler.setQuotaBlock(
      snapshot.providerId,
      snapshot.accountId,
      exhaustedResets.length === 0 ? undefined : Math.max(...exhaustedResets),
    )
  }
}
