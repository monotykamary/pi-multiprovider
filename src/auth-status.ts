import type { Api, Provider } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

interface SessionRuntime {
  getProviders(): readonly Provider<Api>[]
  getProviderAuthStatus(id: string): { configured: boolean; label?: string; source?: string }
  isUsingOAuth(id: string): boolean
  getRegisteredProviderConfig?(id: string): { apiKey?: string } | undefined
}

export function probeSessionRuntime(ctx: ExtensionContext): SessionRuntime | undefined {
  const candidate = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const runtime = candidate as Record<keyof SessionRuntime, unknown>
  if (typeof runtime.getProviders !== 'function') return undefined
  if (typeof runtime.getProviderAuthStatus !== 'function') return undefined
  if (typeof runtime.isUsingOAuth !== 'function') return undefined
  return candidate as unknown as SessionRuntime
}

/**
 * Source `mergeProviderAuth` reports when a pool's own accounts satisfy Pi's
 * auth check. Pi 1.1.0 then surfaces that through getProviderAuthStatus as
 * `{ source: "environment", label: "multiprovider account pool" }`.
 */
export const MULTIPOOL_AUTH_SOURCE = 'multiprovider account pool'

export interface UpstreamAuthStatus {
  configured?: boolean
  source?: string
  label?: string
}

/**
 * The credential source Pi actually attributes.
 *
 * `getProviderAuthStatus` reports an auth-check hit as
 * `{ source: "environment", label: <check source> }`. The label is the
 * check's own source (the pool answering itself, an env var name, or
 * "configured API key"), so it wins over the generic "environment" wrapper.
 */
export function upstreamAuthSource(status?: UpstreamAuthStatus): string | undefined {
  if (status === undefined) return undefined
  if (status.source === 'environment' && status.label !== undefined && status.label !== '') return status.label
  return status.source
}

const literalFallbackProviders: WeakSet<Provider<Api>> = ((globalThis as unknown as Record<symbol, WeakSet<Provider<Api>> | undefined>)[
  Symbol.for('pi-multiprovider.literal-fallback-providers')
] ??= new WeakSet())

/** Preserve only config provenance, never the key or a transient auth-status result. */
export function rememberConfiguredApiKey(provider: Provider<Api>, config: string | undefined): void {
  // A native lift replaces the host's legacy registration metadata. Missing
  // metadata on a later pass must not erase the original classification.
  if (config === undefined) return
  const references = config.match(/\$\$|\$!|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  const usesEnvironment = references.some(value => /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(value))
  if (config.startsWith('!') || usesEnvironment) literalFallbackProviders.delete(provider)
  else literalFallbackProviders.add(provider)
}

/**
 * Whether Pi attributes auth to a core credential rather than the pool itself
 * or an extension-embedded literal fallback. Configuration provenance keeps
 * literals distinct from env/command references after Pi demotes both to
 * "configured API key". Runtime and stored core credentials always take priority.
 * Undefined status is unknown; callers without the runtime must not flag it.
 */
export function liveUpstreamConfigured(status?: UpstreamAuthStatus, provider?: Provider<Api>): boolean {
  if (status?.configured !== true) return false
  const source = upstreamAuthSource(status)
  if (source === 'configured API key' && provider !== undefined && literalFallbackProviders.has(provider)) return false
  return source !== undefined && source !== 'fallback' && source !== MULTIPOOL_AUTH_SOURCE
}

