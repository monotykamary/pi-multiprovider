import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderResponse,
  type SimpleStreamOptions,
  type StopReason,
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  liftProvider,
  MultiProviderService,
  type ProviderAccount,
} from '../src/index.ts'

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

function message(
  stopReason: StopReason,
  options: { text?: string; errorMessage?: string } = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
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
    stopReason,
    ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
    timestamp: Date.now(),
  }
}

function finishWithError(
  stream: AssistantMessageEventStream,
  errorMessage: string,
): void {
  const failed = message('error', { errorMessage })
  stream.push({ type: 'error', reason: 'error', error: failed })
  stream.end(failed)
}

function finishWithText(stream: AssistantMessageEventStream, text: string): void {
  const done = message('stop', { text })
  stream.push({ type: 'text_start', contentIndex: 0, partial: done })
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: done })
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: done })
  stream.push({ type: 'done', reason: 'stop', message: done })
  stream.end(done)
}

type Handler = (
  requestModel: Model<'test-api'>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream

function baseProvider(handler: Handler) {
  return createProvider<'test-api'>({
    id: model.provider,
    name: 'Same Provider',
    auth: {
      apiKey: {
        name: 'Outer placeholder',
        async resolve() {
          return { auth: { apiKey: 'outer-placeholder' }, source: 'test' }
        },
      },
    },
    models: [model],
    api: {
      stream: handler,
      streamSimple: handler,
    },
  })
}

const accounts: ProviderAccount<string>[] = [
  { id: 'a', label: 'A', authKind: 'api-key', credentialRef: 'account-a' },
  { id: 'b', label: 'B', authKind: 'api-key', credentialRef: 'account-b' },
]

function setup(handler: Handler) {
  const service = new MultiProviderService({ rateLimitCooldownMs: 60_000 })
  service.registerProvider({
    id: model.provider,
    label: 'Same Provider',
    accounts: () => accounts,
  })
  const lifted = liftProvider<'test-api', string>(baseProvider(handler), service, {
    resolveAuth: account => ({
      auth: {
        apiKey: account.credentialRef,
        headers: { 'x-account': account.id },
        baseUrl: `https://${account.id}.invalid`,
      },
      env: { TEST_ACCOUNT: account.id },
      source: account.label,
    }),
  })
  const models = createModels()
  models.setProvider(lifted)
  const selected = models.getModel(model.provider, model.id)
  if (selected === undefined) throw new Error('test model missing')
  return { service, models, selected }
}

describe('liftProvider', () => {
  it('rotates auth before output without changing provider or model identity', async () => {
    const attempts: Array<{
      provider: string
      model: string
      apiKey?: string
      baseUrl: string
      accountHeader?: string | null
      accountEnv?: string
      maxRetries?: number
    }> = []
    const handler: Handler = (requestModel, _context, options) => {
      attempts.push({
        provider: requestModel.provider,
        model: requestModel.id,
        baseUrl: requestModel.baseUrl,
        ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options?.headers?.['x-account'] === undefined
          ? {}
          : { accountHeader: options.headers['x-account'] }),
        ...(options?.env?.TEST_ACCOUNT === undefined
          ? {}
          : { accountEnv: options.env.TEST_ACCOUNT }),
        ...(options?.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      })
      const stream = createAssistantMessageEventStream()
      void (async () => {
        stream.push({ type: 'start', partial: message('pending') })
        if (options?.apiKey === 'account-a') {
          const response: ProviderResponse = { status: 429, headers: { 'retry-after': '60' } }
          await options.onResponse?.(response, requestModel)
          finishWithError(stream, 'request failed')
          return
        }
        finishWithText(stream, 'rotated')
      })()
      return stream
    }

    const { models, selected, service } = setup(handler)
    const stream = models.streamSimple(selected, { messages: [] })
    const eventTypes: string[] = []
    for await (const event of stream) eventTypes.push(event.type)
    const result = await stream.result()

    expect(eventTypes).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done'])
    expect(selected).toMatchObject({ provider: model.provider, id: model.id })
    expect(attempts).toEqual([
      {
        provider: model.provider,
        model: model.id,
        apiKey: 'account-a',
        baseUrl: 'https://a.invalid',
        accountHeader: 'a',
        accountEnv: 'a',
        maxRetries: 0,
      },
      {
        provider: model.provider,
        model: model.id,
        apiKey: 'account-b',
        baseUrl: 'https://b.invalid',
        accountHeader: 'b',
        accountEnv: 'b',
        maxRetries: 0,
      },
    ])
    expect(result).toMatchObject({
      provider: model.provider,
      model: model.id,
      stopReason: 'stop',
      content: [{ type: 'text', text: 'rotated' }],
    })
    const snapshot = await service.snapshot()
    expect(snapshot.providers[0]?.accounts.find(account => account.id === 'a')).toMatchObject({
      status: 'cooldown', consecutiveFailures: 1, inFlight: 0,
    })
    expect(snapshot.providers[0]?.accounts.find(account => account.id === 'b')).toMatchObject({
      status: 'ready', consecutiveFailures: 0, inFlight: 0,
    })
  })

  it('does not replay after any output event has been exposed', async () => {
    const attempted: string[] = []
    const handler: Handler = (_requestModel, _context, options) => {
      attempted.push(options?.apiKey ?? '')
      const stream = createAssistantMessageEventStream()
      queueMicrotask(() => {
        const partial = message('pending', { text: 'visible' })
        stream.push({ type: 'start', partial })
        stream.push({ type: 'text_start', contentIndex: 0, partial })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'visible', partial })
        finishWithError(stream, '429 rate limit after output')
      })
      return stream
    }

    const { models, selected } = setup(handler)
    const result = await models.completeSimple(selected, { messages: [] })
    expect(attempted).toEqual(['account-a'])
    expect(result.stopReason).toBe('error')
  })

  it('releases an aborted attempt without recording a health failure', async () => {
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    const handler: Handler = (_requestModel, _context, options) => {
      const stream = createAssistantMessageEventStream()
      stream.push({ type: 'start', partial: message('pending') })
      signalStarted()
      options?.signal?.addEventListener('abort', () => {
        const aborted = message('aborted', { errorMessage: 'Request aborted' })
        stream.push({ type: 'error', reason: 'aborted', error: aborted })
        stream.end(aborted)
      }, { once: true })
      return stream
    }

    const { models, selected, service } = setup(handler)
    const controller = new AbortController()
    const resultPromise = models.completeSimple(selected, { messages: [] }, { signal: controller.signal })
    await started
    controller.abort()
    expect((await resultPromise).stopReason).toBe('aborted')
    expect((await service.snapshot()).providers[0]?.accounts.find(account => account.id === 'a')).toMatchObject({
      inFlight: 0, consecutiveFailures: 0, status: 'ready',
    })
  })

  it('holds the account lease until the delegated stream terminates', async () => {
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const handler: Handler = () => {
      const stream = createAssistantMessageEventStream()
      void (async () => {
        stream.push({ type: 'start', partial: message('pending') })
        signalStarted()
        await gate
        const done = message('stop')
        stream.push({ type: 'done', reason: 'stop', message: done })
        stream.end(done)
      })()
      return stream
    }

    const { models, selected, service } = setup(handler)
    const resultPromise = models.completeSimple(selected, { messages: [] })
    await started
    expect((await service.snapshot()).providers[0]?.accounts.find(account => account.id === 'a')?.inFlight).toBe(1)
    finish()
    await resultPromise
    expect((await service.snapshot()).providers[0]?.accounts.find(account => account.id === 'a')?.inFlight).toBe(0)
  })
})
