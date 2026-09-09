import {
  lazyStream,
  type Api,
  type ApiStreamOptions,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type ProviderHeaders,
  type ProviderResponse,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai'
import {
  failureFrom,
  mergeHeaders,
  replayTerminal,
  type BufferedTerminal,
} from './lift.ts'
import type { MultiProviderService } from './service.ts'
import type {
  AccountLease,
  ProviderAttemptFailure,
  ProviderRegistration,
  SelectionBias,
  VirtualBackend,
  VirtualModelConfig,
  VirtualProviderConfig,
} from './types.ts'

type StreamKind = 'stream' | 'streamSimple'
type RequestOptions = StreamOptions & Record<string, unknown>

// Virtual provider ids, virtual model ids, and provider/model ids must not
// contain this separator: it composes scheduler ids and backend account ids.
export const VIRTUAL_ID_SEPARATOR = '::'
export const BACKEND_UNAVAILABLE_PREFIX = 'multiprovider: virtual backend unavailable'

// Placeholder credential the virtual provider reports to the host so its
// models pass auth-availability checks; real auth resolves per attempt at the
// backing provider layer.
const VIRTUAL_PLACEHOLDER_API_KEY = 'virtual-provider'

export function virtualSchedulerId(virtualProviderId: string, modelId: string): string {
  return virtualProviderId + VIRTUAL_ID_SEPARATOR + modelId
}

export function virtualBackendAccountId(
  backend: Pick<VirtualBackend, 'providerId' | 'modelId'>,
): string {
  return backend.providerId + VIRTUAL_ID_SEPARATOR + backend.modelId
}

// Ambient (host-registered) auth for a backing provider, resolved per attempt.
// A failed resolution does not abort the attempt: backing providers with their
// own multiprovider pool resolve stored credentials themselves.
export type AmbientAuthResolution =
  | {
      ok: true
      apiKey?: string
      headers?: ProviderHeaders
      baseUrl?: string
      env?: Record<string, string>
    }
  | { ok: false; error: string }

export interface VirtualProviderDependencies {
  service: MultiProviderService
  config: VirtualProviderConfig
  getAffinityKey: () => string
  getBackingProvider: (providerId: string) => Provider<Api> | undefined
  resolveAmbientAuth: (
    providerId: string,
    model: Model<Api>,
    signal: AbortSignal,
  ) => Promise<AmbientAuthResolution>
  isBackendConfigured?: (providerId: string) => boolean
  maxAccountAttempts?: number
}

export interface VirtualIntegrationOptions {
  getProviderLabel?: (providerId: string) => string | undefined
  maxAccountAttempts?: number
}

// One scheduler registration per virtual model: each model's backends pool
// independently, and every virtual pool rotates with selectionBias 'none' so
// sessions spread evenly across providers (no first-provider favoritism).
export function createVirtualIntegrations(
  config: VirtualProviderConfig,
  options: VirtualIntegrationOptions = {},
): ProviderRegistration<VirtualBackend>[] {
  return config.models.map(model => ({
    id: virtualSchedulerId(config.id, model.id),
    label: config.label + ' · ' + (model.label ?? model.id),
    selectionBias: 'none' as SelectionBias,
    accounts: () =>
      model.backends
        .filter(backend => backend.enabled !== false)
        .map(backend => ({
          id: virtualBackendAccountId(backend),
          label: (options.getProviderLabel?.(backend.providerId) ?? backend.providerId) + ' · ' + backend.modelId,
          authKind: 'custom' as const,
          credentialRef: backend,
          weight: backend.weight ?? 1,
          metadata: { virtual: true, providerId: backend.providerId, modelId: backend.modelId },
        })),
    classifyFailure: (failure: ProviderAttemptFailure) => {
      const message = failure.message.toLowerCase()
      if (
        failure.message.startsWith(BACKEND_UNAVAILABLE_PREFIX)
        || /fetch failed|network|econn(?:aborted|refused|reset)|enotfound|etimedout|socket hang up|not configured/.test(message)
      ) {
        return { kind: 'transient' as const, retryable: true }
      }
      return undefined
    },
    ...(options.maxAccountAttempts === undefined ? {} : { maxAccountAttempts: options.maxAccountAttempts }),
  }))
}

function resolveTarget(
  dependencies: VirtualProviderDependencies,
  backend: VirtualBackend,
): { provider: Provider<Api>; model: Model<Api> } | string {
  const provider = dependencies.getBackingProvider(backend.providerId)
  if (provider === undefined) {
    return BACKEND_UNAVAILABLE_PREFIX + ': provider "' + backend.providerId + '" is not registered'
  }
  const model = provider.getModels().find(candidate => candidate.id === backend.modelId)
  if (model === undefined) {
    return BACKEND_UNAVAILABLE_PREFIX + ': provider "' + backend.providerId + '" has no model "' + backend.modelId + '"'
  }
  return { provider, model }
}

function virtualStream<TApi extends Api>(
  dependencies: VirtualProviderDependencies,
  kind: StreamKind,
  model: Model<TApi>,
  context: Context,
  options?: RequestOptions,
): AssistantMessageEventStream {
  const { config, service } = dependencies
  return lazyStream(model, async () => {
    const requestOptions = { ...(options ?? {}) } as RequestOptions
    const signal = requestOptions.signal ?? new AbortController().signal
    const schedulerId = virtualSchedulerId(config.id, model.id)
    const affinityKey = dependencies.getAffinityKey()
    const attempted = new Set<string>()
    const maxAttempts = dependencies.maxAccountAttempts ?? Number.MAX_SAFE_INTEGER
    let attempts = 0
    let lastTerminal: BufferedTerminal | undefined
    let lastSetupError: unknown

    const attemptsStream = (async function* (): AsyncGenerator<AssistantMessageEvent> {
      while (attempts < maxAttempts) {
        let lease: AccountLease<VirtualBackend>
        try {
          lease = await service.acquire<VirtualBackend>({
            providerId: schedulerId,
            affinityKey,
            excludeAccountIds: attempted,
          })
        } catch (error) {
          if (lastTerminal !== undefined) {
            yield* replayTerminal(lastTerminal)
            return
          }
          throw lastSetupError ?? error
        }

        attempts += 1
        attempted.add(lease.accountId)
        const backend = lease.credentialRef
        let settled = false
        let outputStarted = false
        let start: BufferedTerminal['start']
        let response: ProviderResponse | undefined
        let shouldRetry = false

        try {
          const target = resolveTarget(dependencies, backend)
          if (typeof target === 'string') {
            lastSetupError = new Error(target)
            const disposition = lease.release({
              status: 'failure',
              error: { message: target, outputStarted: false },
            })
            settled = true
            if (disposition?.retryable && attempts < maxAttempts && !signal.aborted) continue
            throw lastSetupError
          }

          const ambient = await dependencies.resolveAmbientAuth(backend.providerId, target.model, signal)
          const attemptOptions = { ...requestOptions } as RequestOptions
          // The host resolves auth for the virtual provider itself (a
          // placeholder key); backing auth comes from the ambient layer below
          // or from the backing provider's own integration.
          delete attemptOptions.apiKey
          if (ambient.ok) {
            if (ambient.apiKey !== undefined) attemptOptions.apiKey = ambient.apiKey
            const headers = mergeHeaders(requestOptions.headers, ambient.headers)
            if (headers !== undefined) attemptOptions.headers = headers
            const env = ambient.env === undefined && requestOptions.env === undefined
              ? undefined
              : { ...(requestOptions.env ?? {}), ...(ambient.env ?? {}) }
            if (env !== undefined) attemptOptions.env = env
          }
          const streamModel: Model<Api> = ambient.ok && ambient.baseUrl !== undefined
            ? { ...target.model, baseUrl: ambient.baseUrl }
            : target.model
          const onResponse = attemptOptions.onResponse
          attemptOptions.onResponse = async (nextResponse, responseModel) => {
            response = {
              status: nextResponse.status,
              headers: { ...nextResponse.headers },
            }
            await onResponse?.(nextResponse, responseModel)
          }
          attemptOptions.maxRetries = 0

          const inner = kind === 'streamSimple'
            ? target.provider.streamSimple(streamModel, context, attemptOptions as SimpleStreamOptions)
            : target.provider.stream(streamModel, context, attemptOptions as ApiStreamOptions<Api>)

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
                const failure = failureFrom(undefined, response, outputStarted, event.error)
                const disposition = lease.release({ status: 'failure', error: failure })
                settled = true
                if (!outputStarted && disposition?.retryable && attempts < maxAttempts) {
                  lastTerminal = {
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

      if (lastTerminal !== undefined) {
        yield* replayTerminal(lastTerminal)
        return
      }
      throw lastSetupError ?? new Error('multiprovider: exhausted virtual backends for "' + config.id + '"')
    })()

    return attemptsStream
  })
}

export function createVirtualProvider(dependencies: VirtualProviderDependencies): Provider<Api> {
  const { config } = dependencies

  const virtualModel = (model: VirtualModelConfig): Model<Api> => {
    let template: Model<Api> | undefined
    for (const backend of model.backends) {
      if (backend.enabled === false) continue
      const candidate = dependencies
        .getBackingProvider(backend.providerId)
        ?.getModels()
        .find(item => item.id === backend.modelId)
      if (candidate !== undefined) {
        template = candidate
        break
      }
    }
    return {
      id: model.id,
      name: model.label ?? model.id,
      api: template?.api ?? 'openai-completions',
      provider: config.id,
      baseUrl: template?.baseUrl ?? '',
      reasoning: template?.reasoning ?? false,
      input: template?.input ?? ['text'],
      cost: template?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: template?.contextWindow ?? 128_000,
      maxTokens: template?.maxTokens ?? 8_192,
    }
  }

  const provider: Provider<Api> = {
    id: config.id,
    name: config.label,
    auth: {
      apiKey: {
        name: config.label + ' (virtual)',
        async resolve() {
          const backends = config.models
            .flatMap(model => model.backends)
            .filter(backend => backend.enabled !== false)
          if (backends.length === 0) return undefined
          const configured = backends.some(backend =>
            dependencies.isBackendConfigured?.(backend.providerId) ?? true)
          if (!configured) return undefined
          return { auth: { apiKey: VIRTUAL_PLACEHOLDER_API_KEY }, source: 'virtual provider' }
        },
      },
    },
    getModels: () => config.models.map(virtualModel),
    stream<T extends Api>(
      model: Model<T>,
      context: Context,
      streamOptions?: ApiStreamOptions<T>,
    ): AssistantMessageEventStream {
      return virtualStream(dependencies, 'stream', model, context, streamOptions as RequestOptions | undefined)
    },
    streamSimple(
      model: Model<Api>,
      context: Context,
      streamOptions?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
      return virtualStream(dependencies, 'streamSimple', model, context, streamOptions as RequestOptions | undefined)
    },
  }
  return provider
}
