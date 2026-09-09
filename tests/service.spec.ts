import { describe, expect, it } from 'vitest'
import {
  MultiProviderService,
  NoAccountAvailableError,
  type ProviderAccount,
  type ProviderAttemptFailure,
  SCHEDULER_DEFAULTS,
  UnknownAccountError,
} from '../src/index.ts'

const accounts: ProviderAccount<string>[] = [
  { id: 'a', label: 'Work', authKind: 'api-key', credentialRef: 'secret-work', weight: 3, priority: 1 },
  { id: 'b', label: 'Personal', authKind: 'oauth', credentialRef: 'secret-personal', weight: 1, priority: 2 },
]

function scheduler(options: ConstructorParameters<typeof MultiProviderService>[0] = {}) {
  const service = new MultiProviderService({
    randomId: (() => {
      let id = 0
      return () => `lease-${++id}`
    })(),
    ...options,
  })
  service.registerProvider({ id: 'example', label: 'Example', accounts: () => accounts })
  return service
}

async function select(
  service: MultiProviderService,
  options: { affinityKey?: string; excludeAccountIds?: string[] } = {},
): Promise<string> {
  const lease = await service.acquire<string>({ providerId: 'example', ...options })
  lease.release({ status: 'success' })
  return lease.accountId
}

function failure(status: number): ProviderAttemptFailure {
  return { message: `HTTP ${status}`, status, outputStarted: false }
}

describe('MultiProviderService', () => {
  it('keeps unpinned selection on the main account and never exposes credential references', async () => {
    const service = scheduler()
    expect(await select(service)).toBe('a')
    // First-account bias: unpinned picks stay on the first healthy account.
    expect(await select(service)).toBe('a')
    const lease = await service.acquire<string>({ providerId: 'example' })
    expect(lease.accountId).toBe('a')
    expect(lease.credentialRef).toBe('secret-work')
    lease.release()

    const snapshot = await service.snapshot()
    expect(snapshot.providers[0]?.firstAccountBias).toBe(true)
    expect(snapshot.providers[0]?.accounts).toHaveLength(2)
    expect(JSON.stringify(snapshot)).not.toContain('secret-work')
    expect(JSON.stringify(snapshot)).not.toContain('secret-personal')
  })

  it('spills unpinned selection over in pool order and follows pool order over id order', async () => {
    const service = scheduler()
    expect(await select(service, { excludeAccountIds: ['a'] })).toBe('b')
    const reversed = new MultiProviderService()
    reversed.registerProvider({
      id: 'example',
      label: 'Example',
      accounts: () => [...accounts].reverse(),
    })
    expect(await select(reversed)).toBe('b')
  })

  it('rotates evenly for providers registered without first-account bias', async () => {
    const service = new MultiProviderService({
      randomId: (() => {
        let id = 0
        return () => `lease-${++id}`
      })(),
    })
    service.registerProvider({
      id: 'example',
      label: 'Example',
      selectionBias: 'none',
      accounts: () => accounts,
    })
    expect(await select(service)).toBe('a')
    expect(await select(service)).toBe('b')
    expect(await select(service)).toBe('a')
  })

  it('spills new sessions to the next account while the main account cools down', async () => {
    let now = 1_000
    const service = scheduler({ now: () => now, affinity: false })
    const lease = await service.acquire({ providerId: 'example' })
    expect(lease.accountId).toBe('a')
    lease.release({ status: 'failure', error: failure(429) })
    expect(await select(service)).toBe('b')
    now = 61_000
    expect(await select(service)).toBe('a')
  })

  it('pins affinity while available and honors explicit attempt exclusions', async () => {
    const service = scheduler()
    const first = await select(service, { affinityKey: 'session-1' })
    expect(await select(service, { affinityKey: 'session-1' })).toBe(first)
    expect(await select(service, { affinityKey: 'session-1', excludeAccountIds: [first] })).not.toBe(first)
    await expect(service.acquire({
      providerId: 'example',
      excludeAccountIds: ['a', 'b'],
    })).rejects.toBeInstanceOf(NoAccountAvailableError)
  })

  it('tracks leases idempotently and cools down failed accounts', async () => {
    let now = 1_000
    const service = scheduler({ now: () => now, rateLimitCooldownMs: 500 })
    const lease = await service.acquire({ providerId: 'example', excludeAccountIds: ['b'] })
    expect((await service.snapshot()).providers[0]?.accounts[0]?.inFlight).toBe(1)
    expect(lease.release({ status: 'failure', error: failure(429) })).toMatchObject({
      kind: 'rate-limit', retryable: true,
    })
    expect(lease.release({ status: 'success' })).toBeUndefined()

    const account = (await service.snapshot()).providers[0]?.accounts.find(item => item.id === 'a')
    expect(account).toMatchObject({
      status: 'cooldown', inFlight: 0, consecutiveFailures: 1, cooldownUntil: 1_500,
    })
    now = 1_500
    expect((await service.acquire({ providerId: 'example', excludeAccountIds: ['b'] })).accountId).toBe('a')
  })

  it('classifies HTTP status embedded in adapter error messages', async () => {
    const service = scheduler()
    const lease = await service.acquire({ providerId: 'example', excludeAccountIds: ['b'] })
    expect(lease.release({
      status: 'failure',
      error: {
        message: '401: authentication rejected before a response callback',
        outputStarted: false,
      },
    })).toMatchObject({ kind: 'auth', retryable: true })
    expect((await service.snapshot()).providers[0]?.accounts.find(account => account.id === 'a')).toMatchObject({
      status: 'cooldown', lastFailureKind: 'auth',
    })
  })

  it('supports smooth weighted and least-in-flight selection', async () => {
    const weighted = scheduler({ affinity: false, defaultPolicy: 'weighted-round-robin' })
    const selections = await Promise.all(Array.from({ length: 8 }, () => select(weighted)))
    expect(selections.filter(account => account === 'a')).toHaveLength(6)
    expect(selections.filter(account => account === 'b')).toHaveLength(2)

    const least = scheduler({ affinity: false, defaultPolicy: 'least-inflight' })
    const first = await least.acquire({ providerId: 'example' })
    const second = await least.acquire({ providerId: 'example' })
    expect(second.accountId).not.toBe(first.accountId)
    first.release()
    second.release()
  })

  it('applies operator policy and account preferences independently of health', async () => {
    const service = scheduler()
    await service.updatePool('example', {
      policy: 'priority',
      affinity: false,
      accounts: [
        { accountId: 'a', enabled: false, weight: 1, priority: 0 },
        { accountId: 'b', enabled: true, weight: 1, priority: -1 },
      ],
    })
    expect(await select(service)).toBe('b')
    expect(service.getPoolPreference('example')).toMatchObject({
      policy: 'priority', affinity: false,
    })
    service.resetHealth('example', 'a')
    expect((await service.snapshot()).providers[0]?.accounts.find(item => item.id === 'a')?.status).toBe('disabled')
  })

  it('updates scheduler cooldowns live via updateSchedulerDefaults', async () => {
    let now = 1_000
    const service = scheduler({ now: () => now })
    service.updateSchedulerDefaults({ rateLimitCooldownMs: 250 })
    const lease = await service.acquire({ providerId: 'example', excludeAccountIds: ['b'] })
    expect(lease.release({ status: 'failure', error: failure(429) })).toMatchObject({
      kind: 'rate-limit',
      retryable: true,
    })
    const account = (await service.snapshot()).providers[0]?.accounts.find(item => item.id === 'a')
    expect(account?.cooldownUntil).toBe(1_250)
    expect(SCHEDULER_DEFAULTS.rateLimitCooldownMs).toBe(60_000)
    expect(() => service.updateSchedulerDefaults({ rateLimitCooldownMs: -1 })).toThrow('non-negative')
  })

  it('pins an explicit session account that survives exclusions and cooldowns', async () => {
    let now = 1_000
    const service = scheduler({ now: () => now })
    await service.pinAccount('example', 'session-1', 'b')
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'b', explicit: true })
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
    // Retry exclusions within a logical request fall back without stealing the pin.
    expect(await select(service, { affinityKey: 'session-1', excludeAccountIds: ['b'] })).toBe('a')
    expect(service.getAffinity('example', 'session-1')?.accountId).toBe('b')
    // A cooldown falls back temporarily, then the session returns to the pin.
    const lease = await service.acquire({ providerId: 'example', affinityKey: 'session-1' })
    expect(lease.accountId).toBe('b')
    lease.release({ status: 'failure', error: failure(429) })
    now = 30_000
    expect(await select(service, { affinityKey: 'session-1' })).toBe('a')
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'b', explicit: true })
    now = 61_000
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
  })

  it('honors explicit session pins even when pool affinity is off', async () => {
    const service = scheduler({ affinity: false })
    expect(service.getPoolPreference('example').affinity).toBe(false)
    expect(await select(service, { affinityKey: 'session-1' })).toBe('a')
    expect(service.getAffinity('example', 'session-1')).toBeUndefined()
    await service.pinAccount('example', 'session-1', 'b')
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
    expect(service.getPoolPreference('example').affinity).toBe(false)
  })

  it('validates pin targets and drops pins for disabled accounts', async () => {
    const service = scheduler()
    await expect(service.pinAccount('example', 'session-1', 'missing'))
      .rejects.toBeInstanceOf(UnknownAccountError)
    await service.pinAccount('example', 'session-1', 'a')
    await service.updatePool('example', {
      accounts: [{ accountId: 'a', enabled: false, weight: 1, priority: 0 }],
    })
    await expect(service.pinAccount('example', 'session-1', 'a')).rejects.toThrow('disabled')
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'b', explicit: false })
  })

  it('clears explicit session pins on demand', async () => {
    const service = scheduler()
    await service.pinAccount('example', 'session-1', 'b')
    service.clearAffinity('example', 'session-1')
    expect(service.getAffinity('example', 'session-1')).toBeUndefined()
    expect(await select(service, { affinityKey: 'session-1' })).toBe('a')
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'a', explicit: false })
    service.clearAffinity()
    expect(service.getAffinity('example', 'session-1')).toBeUndefined()
  })
})
