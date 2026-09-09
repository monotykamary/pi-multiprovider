import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthContext,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StopReason,
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  createVirtualIntegrations,
  createVirtualProvider,
  type FailoverInfo,
  MultiProviderService,
  virtualSchedulerId,
  type VirtualProviderConfig,
  type VirtualProviderDependencies,
} from '../src/index.ts'

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const modelA: Model<'test-api'> = {
  id: 'model-a',
  name: 'Model A',
  api: 'test-api',
  provider: 'prov-a',
  baseUrl: 'https://a.invalid',
  reasoning: false,
  thinkingLevelMap: { high: 'high-effort', off: null },
  input: ['text'],
  cost: zeroCost,
  contextWindow: 1_000,
  maxTokens: 100,
}

const modelB: Model<'test-api'> = {
  ...modelA,
  id: 'model-b',
  name: 'Model B',
  provider: 'prov-b',
  baseUrl: 'https://b.invalid',
}

const config: VirtualProviderConfig = {
  id: 'pooled',
  label: 'Pooled',
  models: [{
    id: 'ultra',
    backends: [
      { providerId: 'prov-a', modelId: 'model-a' },
      { providerId: 'prov-b', modelId: 'model-b' },
    ],
  }],
}

const context: Context = { messages: [] }

const authContext: AuthContext = {
  async env() {
    return undefined
  },
  async fileExists() {
    return false
  },
}

function message(
  stopReason: StopReason,
  options: { text?: string; errorMessage?: string } = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
    api: 'test-api',
    provider: 'prov-a',
    model: 'model-a',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
    timestamp: Date.now(),
  }
}

function finishWithText(stream: AssistantMessageEventStream, text: string): void {
  const done = message('stop', { text })
  stream.push({ type: 'text_start', contentIndex: 0, partial: done })
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: done })
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: done })
  stream.push({ type: 'done', reason: 'stop', message: done })
  stream.end(done)
}

function finishWithError(stream: AssistantMessageEventStream, errorMessage: string): void {
  const failed = message('error', { errorMessage })
  stream.push({ type: 'error', reason: 'error', error: failed })
  stream.end(failed)
}

function okStream(text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  finishWithText(stream, text)
  return stream
}

function errorStream(errorMessage: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  finishWithError(stream, errorMessage)
  return stream
}

type Handler = (
  model: Model<'test-api'>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream

interface Attempt {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
}

function backend(id: string, model: Model<'test-api'>, handler: Handler): Provider<Api> {
  return createProvider<'test-api'>({
    id,
    name: id.toUpperCase(),
    auth: {
      apiKey: {
        name: 'key',
        async resolve() {
          return { auth: { apiKey: 'ambient-' + id }, source: 'test' }
        },
      },
    },
    models: [model],
    api: {
      stream: (receivedModel, _context, options) => handler(receivedModel as Model<'test-api'>, _context, options),
      streamSimple: (receivedModel, _context, options) => handler(receivedModel as Model<'test-api'>, _context, options),
    },
  })
}

function harness(
  handlers: { a: Handler; b: Handler },
  overrides: {
    missingProviders?: string[]
    isBackendConfigured?: (providerId: string) => boolean
    affinityKey?: string
  } = {},
  options: {
    errorsBeforeSwitch?: number
    onFailover?: VirtualProviderDependencies['onFailover']
  } = {},
) {
  const attempts: Attempt[] = []
  const providers = new Map<string, Provider<Api>>([
    ['prov-a', backend('prov-a', modelA, (receivedModel, requestContext, options) => {
      const model = receivedModel as Model<'test-api'>
      attempts.push({
        provider: 'prov-a',
        model: model.id,
        ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        baseUrl: model.baseUrl,
      })
      return handlers.a(model, requestContext, options)
    })],
    ['prov-b', backend('prov-b', modelB, (receivedModel, requestContext, options) => {
      const model = receivedModel as Model<'test-api'>
      attempts.push({
        provider: 'prov-b',
        model: model.id,
        ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        baseUrl: model.baseUrl,
      })
      return handlers.b(model as Model<'test-api'>, requestContext, options)
    })],
  ])
  const service = new MultiProviderService(
    options.errorsBeforeSwitch === undefined ? {} : { errorsBeforeSwitch: options.errorsBeforeSwitch },
  )
  for (const integration of createVirtualIntegrations(config)) {
    service.registerProvider(integration)
  }
  const deps: VirtualProviderDependencies = {
    service,
    config,
    ...(options.onFailover === undefined ? {} : { onFailover: options.onFailover }),
    getAffinityKey: () => overrides.affinityKey ?? 'session-1',
    getBackingProvider: providerId =>
      overrides.missingProviders?.includes(providerId) ? undefined : providers.get(providerId),
    resolveAmbientAuth: async providerId => ({ ok: true, apiKey: 'ambient-' + providerId }),
    isBackendConfigured: overrides.isBackendConfigured ?? (() => true),
  }
  const virtual = createVirtualProvider(deps)
  return { service, virtual, attempts, deps }
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('virtual providers', () => {
  it('registers one unbiased scheduler per virtual model', async () => {
    const service = new MultiProviderService()
    for (const integration of createVirtualIntegrations(config)) {
      service.registerProvider(integration)
    }
    const snapshot = await service.snapshot()
    expect(snapshot.providers).toHaveLength(1)
    expect(snapshot.providers[0]?.id).toBe(virtualSchedulerId('pooled', 'ultra'))
    expect(snapshot.providers[0]?.firstAccountBias).toBe(false)
    expect(snapshot.providers[0]?.accounts.map(account => account.id))
      .toEqual(['prov-a::model-a', 'prov-b::model-b'])
  })

  it('exposes virtual models templated from the first healthy backend', () => {
    const { virtual } = harness({ a: () => okStream('x'), b: () => okStream('x') })
    const models = virtual.getModels()
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'ultra',
      name: 'ultra',
      provider: 'pooled',
      api: 'test-api',
      baseUrl: 'https://a.invalid',
      thinkingLevelMap: { high: 'high-effort', off: null },
      contextWindow: 1_000,
    })
  })

  it('round-robins backends across sessions and delegates with backing model and ambient auth', async () => {
    const { attempts, deps } = harness({
      a: () => okStream('from-a'),
      b: () => okStream('from-b'),
    })
    // One service, two sessions: the pool rotates while each session stays
    // pinned to its selected backend.
    const firstSession = createVirtualProvider({ ...deps, getAffinityKey: () => 'session-1' })
    const secondSession = createVirtualProvider({ ...deps, getAffinityKey: () => 'session-2' })
    const model = firstSession.getModels()[0]!
    const first = await collect(firstSession.stream(model, context))
    const second = await collect(secondSession.stream(model, context))
    expect(first.at(-1)).toMatchObject({ type: 'done' })
    expect(second.at(-1)).toMatchObject({ type: 'done' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-b'])
    expect(attempts.map(attempt => attempt.apiKey)).toEqual(['ambient-prov-a', 'ambient-prov-b'])
    expect(attempts.every(attempt => attempt.baseUrl?.startsWith('https://'))).toBe(true)
  })

  it('pins the session affinity key to the last healthy backend', async () => {
    const { virtual, attempts } = harness({
      a: () => okStream('from-a'),
      b: () => okStream('from-b'),
    })
    const model = virtual.getModels()[0]!
    await collect(virtual.stream(model, context))
    await collect(virtual.stream(model, context))
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-a'])
  })

  it('fails over to the next backend before output', async () => {
    const { virtual, attempts } = harness(
      { a: () => errorStream('HTTP 500 upstream'), b: () => okStream('from-b') },
      undefined,
      { errorsBeforeSwitch: 1 },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-b'])
  })

  it('fails over when a backend provider or model is unavailable', async () => {
    const { virtual, attempts } = harness(
      { a: () => okStream('from-a'), b: () => okStream('from-b') },
      { missingProviders: ['prov-a'] },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-b'])
  })

  it('replays the terminal error once every backend is exhausted', async () => {
    const { virtual, attempts } = harness(
      { a: () => errorStream('HTTP 500'), b: () => errorStream('HTTP 503') },
      undefined,
      { errorsBeforeSwitch: 1 },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(attempts).toHaveLength(2)
  })

  it('absorbs up to three backend errors before failing over', async () => {
    const { virtual, attempts } = harness({
      a: () => errorStream('HTTP 503'),
      b: () => okStream('from-b'),
    })
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-a', 'model-a', 'model-b'])
  })

  it('surfaces the buffered error when onFailover claims the transition', async () => {
    const hookCalls: FailoverInfo[] = []
    const { virtual, attempts } = harness(
      { a: () => errorStream('HTTP 500'), b: () => errorStream('HTTP 503') },
      {},
      {
        onFailover: info => {
          hookCalls.push(info)
          return true
        },
      },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-a', 'model-a'])
    expect(hookCalls).toEqual([expect.objectContaining({
      providerId: virtualSchedulerId('pooled', 'ultra'),
      fromAccountId: 'prov-a::model-a',
      failure: expect.objectContaining({ message: 'HTTP 500', outputStarted: false }),
      errorsOnAccount: 3,
    })])
  })

  it('reports unconfigured auth when no backend provider is configured', async () => {
    const { virtual } = harness(
      { a: () => okStream('x'), b: () => okStream('x') },
      { isBackendConfigured: () => false },
    )
    await expect(
      virtual.auth.apiKey!.resolve({ ctx: authContext, signal: new AbortController().signal }),
    ).resolves.toBeUndefined()
  })

  it('reports placeholder auth once a backend is configured', async () => {
    const { virtual } = harness({ a: () => okStream('x'), b: () => okStream('x') })
    const resolution = await virtual.auth.apiKey!.resolve({
      ctx: authContext,
      signal: new AbortController().signal,
    })
    expect(resolution).toMatchObject({ auth: { apiKey: 'virtual-provider' }, source: 'virtual provider' })
  })
})
