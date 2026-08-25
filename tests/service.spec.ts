import { describe, expect, it } from 'vitest'
import {
  MultiProviderService,
  NoAccountAvailableError,
  type ProviderAccount,
  type ProviderAttemptFailure,
  SCHEDULER_DEFAULTS,
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
  it('round robins stable account ids without exposing credential references', async () => {
    const service = scheduler()
    expect(await select(service)).toBe('a')
    const lease = await service.acquire<string>({ providerId: 'example' })
    expect(lease.accountId).toBe('b')
    expect(lease.credentialRef).toBe('secret-personal')
    lease.release()

    const snapshot = await service.snapshot()
    expect(snapshot.providers[0]?.accounts).toHaveLength(2)
    expect(JSON.stringify(snapshot)).not.toContain('secret-work')
    expect(JSON.stringify(snapshot)).not.toContain('secret-personal')
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
})
