import type {
  Api,
  ApiKeyAuth,
  AuthResult,
  ModelAuth,
  OAuthAuth,
  Provider,
  ProviderAuth,
  ProviderHeaders,
  StreamOptions,
} from '@earendil-works/pi-ai'
import { MultiAuthStore } from './auth-store.ts'
import type {
  AccountAttemptContext,
  AccountRequestContext,
  MultiProviderIntegration,
  ProviderAccount,
} from './types.ts'

export const PI_UPSTREAM_ACCOUNT_ID = 'pi:default'
const AUTH_MARKER_HEADER = 'x-pi-multiprovider-auth-source'

interface UpstreamMarker {
  available: boolean
  headerNames: string[]
  envNames: string[]
  customBaseUrl: boolean
}

function findHeader(headers: ProviderHeaders | undefined, name: string): string | null | undefined {
  const entry = Object.entries(headers ?? {}).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())
  return entry?.[1]
}

function removeHeader(headers: ProviderHeaders, name: string): void {
  for (const candidate of Object.keys(headers)) {
    if (candidate.toLowerCase() === name.toLowerCase()) delete headers[candidate]
  }
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some(candidate => candidate.toLowerCase() === name.toLowerCase())
}

function markerFor(auth: ModelAuth, env: Readonly<Record<string, string>> | undefined, available: boolean): UpstreamMarker {
  return {
    available,
    headerNames: Object.keys(auth.headers ?? {}).filter(name => name.toLowerCase() !== AUTH_MARKER_HEADER),
    envNames: Object.keys(env ?? {}),
    customBaseUrl: auth.baseUrl !== undefined,
  }
}

function markModelAuth(auth: ModelAuth, available: boolean): ModelAuth {
  const marker = markerFor(auth, undefined, available)
  return {
    ...auth,
    headers: {
      ...auth.headers,
      [AUTH_MARKER_HEADER]: JSON.stringify(marker),
    },
  }
}

function markAuthResult(result: AuthResult, available: boolean): AuthResult {
  const marker = markerFor(result.auth, result.env, available)
  return {
    ...result,
    auth: {
      ...result.auth,
      headers: {
        ...result.auth.headers,
        [AUTH_MARKER_HEADER]: JSON.stringify(marker),
      },
    },
  }
}

function readMarker(options: Readonly<StreamOptions & Record<string, unknown>>): UpstreamMarker | undefined {
  const value = findHeader(options.headers, AUTH_MARKER_HEADER)
  if (typeof value !== 'string') return undefined
  try {
    const marker = JSON.parse(value) as Partial<UpstreamMarker>
    if (typeof marker.available !== 'boolean') return undefined
    return {
      available: marker.available,
      headerNames: Array.isArray(marker.headerNames)
        ? marker.headerNames.filter((name): name is string => typeof name === 'string')
        : [],
      envNames: Array.isArray(marker.envNames)
        ? marker.envNames.filter((name): name is string => typeof name === 'string')
        : [],
      customBaseUrl: marker.customBaseUrl === true,
    }
  } catch {
    return undefined
  }
}

function wrapOAuth(method: OAuthAuth): OAuthAuth {
  return {
    name: method.name,
    ...(method.isSubscription === undefined ? {} : { isSubscription: method.isSubscription }),
    ...(method.loginLabel === undefined ? {} : { loginLabel: method.loginLabel }),
    login: interaction => method.login(interaction),
    refresh: (credential, signal) => method.refresh(credential, signal),
    async toAuth(credential) {
      return markModelAuth(await method.toAuth(credential), true)
    },
  }
}

export function mergeProviderAuth(
  provider: Provider<Api>,
  hasStoredAccounts: () => Promise<boolean>,
): ProviderAuth {
  const original = provider.auth.apiKey
  const apiKey: ApiKeyAuth = {
    name: original?.name ?? 'Multiprovider account pool',
    ...(original?.login === undefined ? {} : { login: interaction => original.login!(interaction) }),
    async check(input) {
      if (original?.check !== undefined) {
        const checked = await original.check(input)
        if (checked !== undefined) return checked
      } else if (original !== undefined) {
        try {
          const resolved = await original.resolve(input)
          if (resolved !== undefined) {
            return {
              type: 'api_key',
              ...(resolved.source === undefined ? {} : { source: resolved.source }),
            }
          }
        } catch (error) {
          if (!await hasStoredAccounts()) throw error
        }
      }
      return await hasStoredAccounts()
        ? { type: 'api_key', source: 'multiprovider account pool' }
        : undefined
    },
    async resolve(input) {
      if (original !== undefined) {
        try {
          const resolved = await original.resolve(input)
          if (resolved !== undefined) return markAuthResult(resolved, true)
        } catch (error) {
          if (!await hasStoredAccounts()) throw error
        }
      }
      return await hasStoredAccounts()
        ? markAuthResult({ auth: {}, source: 'multiprovider account pool' }, false)
        : undefined
    },
  }

  return {
    apiKey,
    ...(provider.auth.oauth === undefined ? {} : { oauth: wrapOAuth(provider.auth.oauth) }),
  }
}

function restoreBaseUrl<TApi extends Api>(
  provider: Provider<TApi>,
  modelId: string,
): string | undefined {
  return provider.getModels().find(model => model.id === modelId)?.baseUrl ?? provider.baseUrl
}

function sanitizeAttempt(
  attempt: AccountAttemptContext<Api, string>,
): StreamOptions & Record<string, unknown> {
  const marker = readMarker(attempt.requestOptions)
  const options = { ...attempt.requestOptions } as StreamOptions & Record<string, unknown>
  const headers: ProviderHeaders = { ...(options.headers ?? {}) }
  removeHeader(headers, AUTH_MARKER_HEADER)

  if (attempt.account.id !== PI_UPSTREAM_ACCOUNT_ID && marker !== undefined) {
    for (const name of marker.headerNames) {
      if (!hasHeader(attempt.resolution.auth.headers, name)) removeHeader(headers, name)
    }
    const selectedEnv = new Set(Object.keys(attempt.resolution.env ?? {}))
    const env = { ...(options.env ?? {}) }
    for (const name of marker.envNames) {
      if (!selectedEnv.has(name)) delete env[name]
    }
    if (Object.keys(env).length === 0) delete options.env
    else options.env = env
  }

  if (Object.keys(headers).length === 0) delete options.headers
  else options.headers = headers
  return options
}

export function createManagedIntegration<TApi extends Api>(
  provider: Provider<TApi>,
  store: MultiAuthStore,
): MultiProviderIntegration<TApi, string> {
  const accounts = async (): Promise<ProviderAccount<string>[]> => {
    const pool = await store.getPool(provider.id)
    if (pool === undefined) return []
    const result: ProviderAccount<string>[] = []
    if (pool.includeUpstream) {
      result.push({
        id: PI_UPSTREAM_ACCOUNT_ID,
        label: pool.upstream?.label ?? 'Pi default',
        authKind: 'custom',
        credentialRef: PI_UPSTREAM_ACCOUNT_ID,
        weight: pool.upstream?.weight ?? 1,
        priority: pool.upstream?.priority ?? 0,
        metadata: { source: 'auth.json, environment, or provider ambient auth' },
      })
    }
    result.push(...pool.accounts.map(account => ({
      id: account.id,
      label: account.label,
      authKind: account.authKind,
      credentialRef: account.id,
      enabled: account.enabled,
      weight: account.weight,
      priority: account.priority,
      metadata: { stored: true },
    })))
    return result
  }

  return {
    id: provider.id,
    label: provider.name,
    accounts,
    auth: mergeProviderAuth(provider as Provider<Api>, () => store.hasAccounts(provider.id)),
    managementHint: 'Use /multilogin to manage the pool and /multilogout to remove accounts quickly.',
    excludeAccountIds(request: AccountRequestContext<TApi>) {
      return readMarker(request.requestOptions)?.available === true
        ? []
        : [PI_UPSTREAM_ACCOUNT_ID]
    },
    async resolveAuth(account, signal, request) {
      if (account.id === PI_UPSTREAM_ACCOUNT_ID) {
        return {
          auth: {
            ...(request.requestOptions.apiKey === undefined
              ? {}
              : { apiKey: request.requestOptions.apiKey as string }),
          },
          ...(request.requestOptions.env === undefined
            ? {}
            : { env: { ...request.requestOptions.env } }),
          source: 'Pi default auth',
        }
      }
      const resolution = await store.resolveAccount(provider, account.credentialRef, signal)
      const marker = readMarker(request.requestOptions)
      if (marker?.customBaseUrl === true && resolution.auth.baseUrl === undefined) {
        const baseUrl = restoreBaseUrl(provider, request.model.id)
        if (baseUrl !== undefined) {
          return {
            ...resolution,
            auth: { ...resolution.auth, baseUrl },
          }
        }
      }
      return resolution
    },
    sanitizeRequestOptions: attempt => sanitizeAttempt(attempt as AccountAttemptContext<Api, string>),
  }
}
