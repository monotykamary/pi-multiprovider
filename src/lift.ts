import {
  lazyStream,
  type Api,
  type ApiStreamOptions,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthResult,
  type Context,
  type Model,
  type Provider,
  type ProviderHeaders,
  type ProviderResponse,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai'
import { MultiProviderService } from './service.ts'
import type {
  AccountLease,
  LiftProviderOptions,
  ProviderAttemptFailure,
} from './types.ts'

type StreamKind = 'stream' | 'streamSimple'
type RequestOptions = StreamOptions & Record<string, unknown>

interface BufferedTerminal {
  start?: AssistantMessageEvent & { type: 'start' }
  event: AssistantMessageEvent & { type: 'error' }
}

function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  if (base === undefined && override === undefined) return undefined
  const merged: ProviderHeaders = { ...base }
  for (const [name, value] of Object.entries(override ?? {})) {
    const lowerName = name.toLowerCase()
    for (const existingName of Object.keys(merged)) {
      if (existingName.toLowerCase() === lowerName) delete merged[existingName]
    }
    merged[name] = value
  }
  return merged
}

function applyResolvedAuth<TApi extends Api>(
  model: Model<TApi>,
  options: RequestOptions,
  resolution: AuthResult,
): { model: Model<TApi>; options: RequestOptions } {
  const nextOptions = { ...options } as RequestOptions
  delete nextOptions.apiKey
  if (resolution.auth.apiKey !== undefined) nextOptions.apiKey = resolution.auth.apiKey

  const headers = mergeHeaders(options.headers, resolution.auth.headers)
  if (headers === undefined) delete nextOptions.headers
  else nextOptions.headers = headers

  const env = resolution.env === undefined && options.env === undefined
    ? undefined
    : { ...(options.env ?? {}), ...(resolution.env ?? {}) }
  if (env === undefined) delete nextOptions.env
  else nextOptions.env = env

  return {
    model: resolution.auth.baseUrl === undefined
      ? model
      : { ...model, baseUrl: resolution.auth.baseUrl },
    options: nextOptions,
  }
}

function failureFrom(
  error: unknown,
  response: ProviderResponse | undefined,
  outputStarted: boolean,
  assistantMessage?: ProviderAttemptFailure['assistantMessage'],
): ProviderAttemptFailure {
  const message = assistantMessage?.errorMessage
    ?? (error instanceof Error ? error.message : String(error))
  return {
    message,
    outputStarted,
    ...(response === undefined ? {} : {
      status: response.status,
      headers: response.headers,
    }),
    ...(assistantMessage === undefined ? {} : { assistantMessage }),
    ...(error === undefined ? {} : { cause: error }),
  }
}

function callProvider<TApi extends Api>(
  provider: Provider<TApi>,
  kind: StreamKind,
  model: Model<TApi>,
  context: Context,
  options: RequestOptions,
): AssistantMessageEventStream {
  if (kind === 'streamSimple') {
    return provider.streamSimple(model, context, options as SimpleStreamOptions)
  }
  return provider.stream(model, context, options as ApiStreamOptions<TApi>)
}

function replayTerminal(terminal: BufferedTerminal): AsyncIterable<AssistantMessageEvent> {
  return (async function* () {
    if (terminal.start !== undefined) yield terminal.start
    yield terminal.event
  })()
}

function liftedStream<TApi extends Api, TCredentialRef>(
  provider: Provider<TApi>,
  service: MultiProviderService,
  liftOptions: LiftProviderOptions<TApi, TCredentialRef>,
  kind: StreamKind,
  model: Model<TApi>,
  context: Context,
  options?: RequestOptions,
): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    const requestOptions = { ...(options ?? {}) } as RequestOptions
    const signal = requestOptions.signal ?? new AbortController().signal
    const requestContext = { provider, model, context, requestOptions, signal }
    const attempted = new Set<string>(
      liftOptions.excludeAccountIds === undefined
        ? []
        : await liftOptions.excludeAccountIds(requestContext),
    )
    const maxAttempts = liftOptions.maxAccountAttempts ?? Number.MAX_SAFE_INTEGER
    const affinityKey = liftOptions.affinityKey?.({ provider, model, context })
    let attempts = 0
    let lastRejected: BufferedTerminal | undefined
    let lastSetupError: unknown

    const attemptsStream = (async function* (): AsyncGenerator<AssistantMessageEvent> {
      while (attempts < maxAttempts) {
        let lease: AccountLease<TCredentialRef>
        try {
          lease = await service.acquire<TCredentialRef>({
            providerId: provider.id,
            ...(affinityKey === undefined ? {} : { affinityKey }),
            excludeAccountIds: attempted,
          })
        } catch (error) {
          if (lastRejected !== undefined) {
            yield* replayTerminal(lastRejected)
            return
          }
          throw lastSetupError ?? error
        }

        attempts += 1
        attempted.add(lease.accountId)
        let settled = false
        let outputStarted = false
        let start: BufferedTerminal['start']
        let response: ProviderResponse | undefined
        let shouldRetry = false

        try {
          let resolved: AuthResult
          try {
            resolved = await liftOptions.resolveAuth(lease.account, signal, requestContext)
          } catch (error) {
            lastSetupError = error
            const disposition = lease.release({
              status: 'failure',
              error: failureFrom(error, response, false),
            })
            settled = true
            if (disposition?.retryable && attempts < maxAttempts && !signal.aborted) {
              continue
            }
            throw error
          }

          const applied = applyResolvedAuth(model, requestOptions, resolved)
          const sanitized = liftOptions.sanitizeRequestOptions?.({
            provider,
            model: applied.model,
            context,
            requestOptions: applied.options,
            signal,
            account: lease.account,
            resolution: resolved,
          }) ?? applied.options
          const attemptOptions = { ...sanitized } as RequestOptions
          const onResponse = attemptOptions.onResponse
          attemptOptions.onResponse = async (nextResponse, responseModel) => {
            response = {
              status: nextResponse.status,
              headers: { ...nextResponse.headers },
            }
            await onResponse?.(nextResponse, responseModel)
          }
          if (liftOptions.disableProviderRetries !== false) attemptOptions.maxRetries = 0

          const inner = callProvider(
            provider,
            kind,
            applied.model,
            context,
            attemptOptions,
          )

          for await (const event of inner) {
            if (event.type === 'start') {
              start = event
              continue
            }

            if (event.type === 'error') {
              if (event.reason === 'aborted' || signal.aborted) {
                lease.release({ status: 'cancelled' })
                settled = true
              } else {
                const failure = failureFrom(
                  undefined,
                  response,
                  outputStarted,
                  event.error,
                )
                const disposition = lease.release({ status: 'failure', error: failure })
                settled = true
                if (!outputStarted && disposition?.retryable && attempts < maxAttempts) {
                  lastRejected = {
                    ...(start === undefined ? {} : { start }),
                    event,
                  }
                  shouldRetry = true
                  break
                }
              }

              if (!outputStarted && start !== undefined) yield start
              yield event
              return
            }

            if (event.type === 'done') {
              lease.release({ status: 'success' })
              settled = true
              if (!outputStarted && start !== undefined) yield start
              yield event
              return
            }

            if (!outputStarted) {
              outputStarted = true
              if (start !== undefined) yield start
            }
            yield event
          }

          if (shouldRetry) continue

          if (!settled) {
            const error = new Error('Provider stream ended without a terminal event')
            lastSetupError = error
            const disposition = lease.release({
              status: 'failure',
              error: failureFrom(error, response, outputStarted),
            })
            settled = true
            if (!outputStarted && disposition?.retryable && attempts < maxAttempts) continue
            throw error
          }
        } catch (error) {
          if (!settled) {
            const disposition = signal.aborted
              ? lease.release({ status: 'cancelled' })
              : lease.release({
                  status: 'failure',
                  error: failureFrom(error, response, outputStarted),
                })
            settled = true
            if (!outputStarted && disposition?.retryable && attempts < maxAttempts) {
              lastSetupError = error
              continue
            }
          }
          throw error
        } finally {
          if (!settled) lease.release({ status: 'cancelled' })
        }
      }

      if (lastRejected !== undefined) {
        yield* replayTerminal(lastRejected)
        return
      }
      throw lastSetupError ?? new Error(`multiprovider: exhausted account attempts for "${provider.id}"`)
    })()

    return attemptsStream
  })
}

export function liftProvider<TApi extends Api, TCredentialRef = unknown>(
  provider: Provider<TApi>,
  service: MultiProviderService,
  options: LiftProviderOptions<TApi, TCredentialRef>,
): Provider<TApi> {
  const lifted: Provider<TApi> = {
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    auth: options.auth ?? provider.auth,
    getModels: () => provider.getModels(),
    ...(provider.refreshModels === undefined
      ? {}
      : { refreshModels: context => provider.refreshModels!(context) }),
    ...(provider.filterModels === undefined
      ? {}
      : { filterModels: (models, credential) => provider.filterModels!(models, credential) }),
    stream<T extends TApi>(
      model: Model<T>,
      context: Context,
      streamOptions?: ApiStreamOptions<T>,
    ): AssistantMessageEventStream {
      return liftedStream(
        provider as Provider<T>,
        service,
        options as LiftProviderOptions<T, TCredentialRef>,
        'stream',
        model,
        context,
        streamOptions as RequestOptions | undefined,
      )
    },
    streamSimple(
      model: Model<TApi>,
      context: Context,
      streamOptions?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
      return liftedStream(
        provider,
        service,
        options,
        'streamSimple',
        model,
        context,
        streamOptions as RequestOptions | undefined,
      )
    },
  }

  return lifted
}
