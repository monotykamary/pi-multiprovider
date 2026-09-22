import {
  createProvider,
  type Api,
  type Model,
  type Provider,
} from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import {
  MultiProviderService,
  UsageService,
  type MultiProviderIntegration,
  type ProviderUsageSnapshot,
  parseClaudeUsage,
  parseCodexUsage,
  parseZaiUsage,
} from '../src/index.ts'

const model: Model<'test-api'> = {
  id: 'model',
  name: 'Model',
  api: 'test-api',
  provider: 'example',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

const provider = createProvider<'test-api'>({
  id: model.provider,
  name: 'Example',
  auth: {},
  models: [model],
  api: {
    stream() { throw new Error('not used') },
    streamSimple() { throw new Error('not used') },
  },
}) as unknown as Provider<Api>

type FetchUsage = NonNullable<MultiProviderIntegration['fetchUsage']>

function fixture(fetchUsage: FetchUsage, quotaAware = true, timeoutMs = 10_000, withToken = true) {
  let now = 10_000
  const integration: MultiProviderIntegration = {
    id: 'example',
    label: 'Example',
    accounts: () => [
      { id: 'a', label: 'Work', authKind: 'api-key', credentialRef: 'secret-work' },
      { id: 'b', label: 'Personal', authKind: 'api-key', credentialRef: 'secret-personal' },
    ],
    resolveAuth: account => ({
      auth: withToken ? { apiKey: String(account.credentialRef) } : {},
      source: account.label,
    }),
    fetchUsage,
  }
  const scheduler = new MultiProviderService({ now: () => now })
  scheduler.registerProvider(integration)
  const usage = new UsageService({
    scheduler,
    getIntegration: providerId => providerId === 'example' ? integration : undefined,
    getProvider: providerId => providerId === 'example' ? provider : undefined,
    getModel: providerId => providerId === 'example' ? model as unknown as Model<Api> : undefined,
    resolveUpstreamAuth: async () => undefined,
    isQuotaAware: () => quotaAware,
    ttlMs: 100,
    timeoutMs,
    now: () => now,
  })
  return {
    scheduler,
    usage,
    advance(milliseconds: number) { now += milliseconds },
    now: () => now,
  }
}

describe('usage parsers', () => {
  it('normalizes Codex, Claude, and Z.AI reset windows', () => {
    const codex = parseCodexUsage({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 80, limit_window_seconds: 18_000, reset_at: 123 },
      },
    })
    expect(codex).toMatchObject({
      plan: 'Pro 20x',
      windows: [{ label: '5 hour', usedPercent: 80, resetsAt: 123_000 }],
    })

    const claude = parseClaudeUsage({
      five_hour: { utilization: 42, resets_at: '2030-01-01T00:00:00Z' },
      seven_day: { utilization: 12, resets_at: '2030-01-07T00:00:00Z' },
    })
    expect(claude.windows.map(window => window.usedPercent)).toEqual([42, 12])

    const zai = parseZaiUsage({
      data: { limits: [{ type: 'TOKENS', usage: 75, remaining: 25, number: 5, unit: 1, nextResetTime: 999 }] },
    })
    expect(zai.windows[0]).toMatchObject({ used: 75, remaining: 25, limit: 100, usedPercent: 75 })
  })
})

describe('UsageService', () => {
  it('isolates cache entries per account and keeps credentials out of snapshots', async () => {
    const fetchUsage = vi.fn<FetchUsage>(async ({ account }) => ({
      windows: [{ id: 'daily', label: '1 day', usedPercent: account.id === 'a' ? 20 : 40 }],
    }))
    const { usage } = fixture(fetchUsage)
    const snapshots = await usage.refreshProvider('example')

    expect(snapshots.map(snapshot => [snapshot.accountId, snapshot.windows[0]?.usedPercent])).toEqual([
      ['a', 20],
      ['b', 40],
    ])
    expect(fetchUsage).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(snapshots)).not.toContain('secret-work')
    expect(JSON.stringify(snapshots)).not.toContain('secret-personal')
  })

  it('deduplicates concurrent refreshes for the same provider account', async () => {
    let complete: ((snapshot: ProviderUsageSnapshot) => void) | undefined
    const fetchUsage = vi.fn<FetchUsage>(() => new Promise(resolve => { complete = resolve }))
    const { usage } = fixture(fetchUsage)
    const first = usage.refreshAccount('example', 'a')
    const second = usage.refreshAccount('example', 'a')
    await vi.waitFor(() => { expect(fetchUsage).toHaveBeenCalledTimes(1) })
    complete?.({ windows: [{ id: 'daily', label: '1 day', usedPercent: 5 }] })
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { accountId: 'a', windows: [{ usedPercent: 5 }] },
      { accountId: 'a', windows: [{ usedPercent: 5 }] },
    ])
  })

  it('lets provider-owned adapters handle custom auth without a bearer token', async () => {
    const fetchUsage = vi.fn<FetchUsage>(async () => ({
      windows: [{ id: 'custom', label: 'Custom quota', remaining: 7 }],
    }))
    const { usage } = fixture(fetchUsage, false, 10_000, false)
    await expect(usage.refreshAccount('example', 'a')).resolves.toMatchObject({
      status: 'fresh',
      windows: [{ remaining: 7 }],
    })
  })

  it('uses fresh cache entries and preserves stale data when refresh fails', async () => {
    let fail = false
    const fetchUsage = vi.fn<FetchUsage>(async () => {
      if (fail) throw new Error('provider unavailable: secret-work\nretry')
      return { windows: [{ id: 'weekly', label: '1 week', usedPercent: 25 }] }
    })
    const { usage, advance } = fixture(fetchUsage)
    await usage.refreshAccount('example', 'a', true)
    await usage.refreshAccount('example', 'a', false)
    expect(fetchUsage).toHaveBeenCalledTimes(1)

    advance(101)
    expect(usage.getCached('example', 'a')[0]).toMatchObject({ status: 'stale', stale: true })
    fail = true
    const stale = await usage.refreshAccount('example', 'a', true)
    expect(stale).toMatchObject({ status: 'stale', stale: true, windows: [{ usedPercent: 25 }] })
    expect(stale.error).toBe('provider unavailable: [redacted] retry')
  })

  it('times out adapters even when they ignore the abort signal', async () => {
    const never: FetchUsage = () => new Promise(() => undefined)
    const { usage } = fixture(never, true, 5)
    await expect(usage.refreshAccount('example', 'a')).resolves.toMatchObject({
      status: 'error',
      error: 'usage refresh timed out',
    })
  })

  it('temporarily bypasses an exhausted pinned account and returns after reset', async () => {
    let resetAt = 0
    const fetchUsage: FetchUsage = async ({ account }): Promise<ProviderUsageSnapshot> => ({
      windows: account.id === 'a'
        ? [{ id: 'session', label: 'Session', usedPercent: 100, resetsAt: resetAt }]
        : [{ id: 'session', label: 'Session', usedPercent: 10, resetsAt: resetAt }],
    })
    const state = fixture(fetchUsage)
    resetAt = state.now() + 1_000
    await state.scheduler.updatePool('example', { quotaAwareRouting: true })
    await state.scheduler.pinAccount('example', 'session', 'a')
    await state.usage.refreshProvider('example')

    const blocked = await state.scheduler.acquire({ providerId: 'example', affinityKey: 'session' })
    expect(blocked.accountId).toBe('b')
    blocked.release()
    expect(state.scheduler.getAffinity('example', 'session')).toEqual({ accountId: 'a', explicit: true })
    expect((await state.scheduler.snapshot()).providers[0]?.accounts[0]).toMatchObject({
      status: 'cooldown',
      cooldownReason: 'usage-quota',
      quotaBlockedUntil: resetAt,
    })

    state.advance(1_000)
    const recovered = await state.scheduler.acquire({ providerId: 'example', affinityKey: 'session' })
    expect(recovered.accountId).toBe('a')
    recovered.release()
  })

  it('does not block for disabled routing or an exhausted window without a known reset', async () => {
    const fetchUsage: FetchUsage = async () => ({
      windows: [{ id: 'unknown-reset', label: 'Unknown reset', usedPercent: 100 }],
    })
    const state = fixture(fetchUsage, false)
    await state.usage.refreshAccount('example', 'a')
    expect((await state.scheduler.acquire({ providerId: 'example' })).accountId).toBe('a')

    const enabled = fixture(fetchUsage, true)
    await enabled.usage.refreshAccount('example', 'a')
    expect((await enabled.scheduler.acquire({ providerId: 'example' })).accountId).toBe('a')
  })

  it('does not route from a provider snapshot that is already stale', async () => {
    let resetAt = 0
    const fetchUsage: FetchUsage = async () => ({
      fetchedAt: 1,
      windows: [{ id: 'old', label: 'Old quota', usedPercent: 100, resetsAt: resetAt }],
    })
    const state = fixture(fetchUsage, true)
    resetAt = state.now() + 1_000
    await expect(state.usage.refreshAccount('example', 'a')).resolves.toMatchObject({
      status: 'stale',
      stale: true,
    })
    expect((await state.scheduler.acquire({ providerId: 'example' })).accountId).toBe('a')
  })
})
