import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManagedIntegration,
  liftProvider,
  MultiAuthStore,
  MultiProviderService,
  PI_UPSTREAM_ACCOUNT_ID,
} from '../src/index.ts'

const temporaryDirectories: string[] = []

const model: Model<'test-api'> = {
  id: 'same-model',
  name: 'Same Model',
  api: 'test-api',
  provider: 'same-provider',
  baseUrl: 'https://base.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

function doneMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('managed account integration', () => {
  it('merges Pi default auth with stored accounts without carrying credentials across attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-multiprovider-managed-'))
    temporaryDirectories.push(directory)
    const store = new MultiAuthStore(join(directory, 'multiprovider-auth.json'))
    await store.addAccount(model.provider, {
      label: 'Extra',
      credential: { type: 'api_key', key: 'extra-key' },
    })
    await store.updatePool(model.provider, {
      policy: 'round-robin',
      affinity: false,
      includeUpstream: true,
    })

    const attempts: Array<{
      apiKey?: string
      baseUrl: string
      authorization?: string | null
      upstreamHeader?: string | null
      extraHeader?: string | null
      upstreamEnv?: string
      extraEnv?: string
      marker?: string | null
    }> = []
    const handler = (requestModel: Model<'test-api'>, _context: unknown, options?: SimpleStreamOptions) => {
      attempts.push({
        ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        baseUrl: requestModel.baseUrl,
        ...(options?.headers?.Authorization === undefined ? {} : { authorization: options.headers.Authorization }),
        ...(options?.headers?.['x-upstream-only'] === undefined
          ? {}
          : { upstreamHeader: options.headers['x-upstream-only'] }),
        ...(options?.headers?.['x-extra'] === undefined ? {} : { extraHeader: options.headers['x-extra'] }),
        ...(options?.headers?.['x-pi-multiprovider-auth-source'] === undefined
          ? {}
          : { marker: options.headers['x-pi-multiprovider-auth-source'] }),
        ...(options?.env?.UPSTREAM_ONLY === undefined ? {} : { upstreamEnv: options.env.UPSTREAM_ONLY }),
        ...(options?.env?.EXTRA_ONLY === undefined ? {} : { extraEnv: options.env.EXTRA_ONLY }),
      })
      const stream = createAssistantMessageEventStream()
      const done = doneMessage()
      stream.push({ type: 'start', partial: done })
      stream.push({ type: 'done', reason: 'stop', message: done })
      stream.end(done)
      return stream
    }
    const provider = createProvider<'test-api'>({
      id: model.provider,
      name: 'Same Provider',
      auth: {
        apiKey: {
          name: 'Same Provider API key',
          async resolve({ credential }) {
            if (credential?.key === 'upstream-key') {
              return {
                auth: {
                  apiKey: credential.key,
                  baseUrl: 'https://upstream.invalid',
                  headers: {
                    Authorization: 'Bearer upstream-key',
                    'x-upstream-only': 'upstream',
                  },
                },
                env: { UPSTREAM_ONLY: 'upstream' },
                source: 'Pi credential',
              }
            }
            if (credential?.key === 'extra-key') {
              return {
                auth: {
                  apiKey: credential.key,
                  headers: { 'x-extra': 'extra' },
                },
                env: { EXTRA_ONLY: 'extra' },
                source: 'Stored extra credential',
              }
            }
            return undefined
          },
        },
      },
      models: [model],
      api: { stream: handler, streamSimple: handler },
    })
    const integration = createManagedIntegration(provider, store)
    const service = new MultiProviderService({ affinity: false })
    service.registerProvider(integration)
    await service.updatePool(model.provider, { policy: 'round-robin', affinity: false })
    const lifted = liftProvider(provider, service, integration)

    const upstreamCredentials = new InMemoryCredentialStore()
    await upstreamCredentials.modify(model.provider, async () => ({
      type: 'api_key',
      key: 'upstream-key',
    }))
    const upstreamModels = createModels({ credentials: upstreamCredentials })
    upstreamModels.setProvider(lifted)
    const selected = upstreamModels.getModel(model.provider, model.id)
    if (selected === undefined) throw new Error('test model missing')
    await upstreamModels.completeSimple(selected, { messages: [] })
    await upstreamModels.completeSimple(selected, { messages: [] })

    const poolOnlyModels = createModels()
    poolOnlyModels.setProvider(lifted)
    const poolOnly = poolOnlyModels.getModel(model.provider, model.id)
    if (poolOnly === undefined) throw new Error('pool-only test model missing')
    await poolOnlyModels.completeSimple(poolOnly, { messages: [] })

    expect(attempts).toEqual([
      {
        apiKey: 'extra-key',
        baseUrl: 'https://base.invalid',
        extraHeader: 'extra',
        extraEnv: 'extra',
      },
      {
        apiKey: 'upstream-key',
        baseUrl: 'https://upstream.invalid',
        authorization: 'Bearer upstream-key',
        upstreamHeader: 'upstream',
        upstreamEnv: 'upstream',
      },
      {
        apiKey: 'extra-key',
        baseUrl: 'https://base.invalid',
        extraHeader: 'extra',
        extraEnv: 'extra',
      },
    ])
  })

  it('applies stored upstream preferences to the Pi default account listing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-multiprovider-managed-'))
    temporaryDirectories.push(directory)
    const store = new MultiAuthStore(join(directory, 'multiprovider-auth.json'))
    await store.addAccount(model.provider, {
      label: 'Extra',
      credential: { type: 'api_key', key: 'extra-key' },
      pool: { upstream: { label: 'Team account', weight: 5, priority: 3 } },
    })
    const provider = createProvider<'test-api'>({
      id: model.provider,
      name: 'Same Provider',
      auth: {
        apiKey: {
          name: 'Same Provider API key',
          async resolve() {
            return undefined
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

    const integration = createManagedIntegration(provider, store)
    const accounts = await integration.accounts()
    expect(accounts[0]).toMatchObject({
      id: PI_UPSTREAM_ACCOUNT_ID,
      label: 'Team account',
      weight: 5,
      priority: 3,
    })
    expect(accounts[1]).toMatchObject({ label: 'Extra' })

    await store.updatePool(model.provider, { upstream: {} })
    const defaulted = await integration.accounts()
    expect(defaulted[0]).toMatchObject({
      id: PI_UPSTREAM_ACCOUNT_ID,
      label: 'Pi default',
      weight: 1,
      priority: 0,
    })

    await store.updatePool(model.provider, { includeUpstream: false })
    const without = await integration.accounts()
    expect(without.map(account => account.id)).not.toContain(PI_UPSTREAM_ACCOUNT_ID)
  })
})
