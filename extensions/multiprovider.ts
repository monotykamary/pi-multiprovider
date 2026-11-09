import type { Api, AuthType, Credential, Model, Provider } from '@earendil-works/pi-ai'
import { isRetryableAssistantError, normalizeContext } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { applySessionPins, inheritedSessionPinsFromEnv, sessionPinsFromEntries, SESSION_PIN_ENTRY_TYPE, type InheritedSessionPin, type SessionPin } from '../src/session-pins.ts'
import { createManagedIntegration, PI_UPSTREAM_ACCOUNT_ID } from '../src/managed.ts'
import { createServiceAnnouncement } from '../src/announcement.ts'
import { getMultiAuthPath, MultiAuthStore, type MultiAuthUpstreamPreferences } from '../src/auth-store.ts'
import { MultiProviderService } from '../src/service.ts'
import { liftProvider } from '../src/lift.ts'
import { captureVirtualModelTemplate, createVirtualIntegrations, createVirtualProvider, healVirtualTemplates, virtualSchedulerId } from '../src/virtual.ts'
import { MULTIPROVIDER_REGISTER_EVENT, MULTIPROVIDER_SERVICE_EVENT, type FailoverInfo, type MultiProviderIntegration, type MultiProviderServiceContext, type ProviderRegistration, type PublicAccountSnapshot, type SchedulerSettingsPatch, type SelectionPolicy, type VirtualBackend, type VirtualModelTemplate, type VirtualProviderConfig } from '../src/types.ts'
import { liveUpstreamConfigured, rememberConfiguredApiKey, probeSessionRuntime } from '../src/auth-status.ts'
import type { PoolManagerAuthMethod, PoolManagerCallbacks } from './pool-manager.ts'
import type { VirtualEditorOutcome } from './virtual-editor.ts'

type AnyIntegration = MultiProviderIntegration<Api, unknown>
type VirtualBackendRef = VirtualBackend

function isIntegration(value: unknown): value is AnyIntegration {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<AnyIntegration>
  return typeof candidate.id === 'string'
    && candidate.id.trim() !== ''
    && typeof candidate.label === 'string'
    && typeof candidate.accounts === 'function'
    && typeof candidate.resolveAuth === 'function'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusLines(
  snapshot: Awaited<ReturnType<MultiProviderService['snapshot']>>,
  coreCredentialMissing: (providerId: string) => boolean = () => false,
): string[] {
  const lines: string[] = []
  for (const provider of snapshot.providers) {
    lines.push(
      `${provider.label} (${provider.id}) · ${provider.policy}`
      + `${provider.firstAccountBias ? ' · main-first' : ''}`
      + ` · affinity ${provider.affinity ? 'on' : 'off'}`,
    )
    // /logout removes only the core /login credential. A pool-only setup is
    // supported, so this line states that fact instead of treating the pool
    // as stale. It also covers a pool that outlived /logout.
    if (coreCredentialMissing(provider.id)) {
      lines.push('  no live core /login credential (pool is separate from /logout; /multilogout removes pooled accounts)')
    }
    if (provider.accounts.length === 0) {
      lines.push('  no accounts')
      continue
    }
    for (const account of provider.accounts) {
      const cooldown = account.cooldownUntil === undefined
        ? ''
        : ` · cooldown until ${new Date(account.cooldownUntil).toLocaleTimeString()}`
      const modelCooldowns = Object.entries(account.modelCooldowns ?? {})
        .map(([modelId, until]) => ` · ${modelId} cooldown until ${new Date(until).toLocaleTimeString()}`)
        .join('')
      lines.push(
        `  ${account.label} (${account.authKind}) · ${account.status} · w${account.weight} · p${account.priority} · ${account.inFlight} in flight · ${account.consecutiveFailures} failures${cooldown}${modelCooldowns}`,
      )
    }
  }
  return lines
}

const AUTOMATIC_SWITCH_REFS = new Set(['auto', 'automatic'])

function switchAccountLabel(account: PublicAccountSnapshot, current: boolean): string {
  const kind = account.id === PI_UPSTREAM_ACCOUNT_ID ? 'upstream' : account.authKind
  const status = account.status === 'cooldown' && account.cooldownUntil !== undefined
    ? `cooldown until ${new Date(account.cooldownUntil).toLocaleTimeString()}`
    : account.status
  return [
    `${account.label} (${kind})`,
    status,
    `w${account.weight} · p${account.priority}`,
    ...(current ? ['current'] : []),
  ].join(' · ')
}

function switchAccountLabels(
  accounts: readonly PublicAccountSnapshot[],
  currentId: string | undefined,
): string[] {
  const labels = accounts.map(account => switchAccountLabel(account, account.id === currentId))
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  return labels.map((label, index) =>
    (counts.get(label) ?? 0) > 1 ? `${label} · ${accounts[index]!.id.slice(0, 8)}` : label)
}

function uniqueProviders(
  ctx: ExtensionContext,
  baseProviders: ReadonlyMap<string, Provider<Api>>,
): Provider<Api>[] {
  const ids = new Set(ctx.modelRegistry.getAll().map(model => model.provider))
  for (const id of baseProviders.keys()) ids.add(id)
  const providers: Provider<Api>[] = []
  for (const id of ids) {
    const provider = baseProviders.get(id)
      ?? ctx.modelRegistry.getProvider(id) as Provider<Api> | undefined
    if (provider !== undefined) providers.push(provider)
  }
  return providers.sort((left, right) => left.name.localeCompare(right.name))
}

// Pi rebuilds a provider that has models.json or extension overlays into a new
// object on every registration, and that object keeps only `headers` from the
// registered provider by reference. Each lift therefore gets its own headers
// object, so the registry's copy of a lift is still recognized as that lift.
const isLiftOf = (current: Provider<Api> | undefined, lift: Provider<Api> | undefined): boolean =>
  current !== undefined && lift !== undefined
  && (current === lift || (lift.headers !== undefined && current.headers === lift.headers))

// Pi loads one instance of this extension per session, and subagent sessions
// share the parent's provider registry. Each instance lifts the real base
// provider, never another instance's lift, so shutting one instance down cannot
// break a chain of wrappers. This process-wide list of live registrations (lifts
// and virtual providers) decides what a departing instance hands the registry
// back to, in whatever order sessions end.
const LIFTED_BASE = Symbol.for('pi-multiprovider.lifted-base')
type LiftedProvider = Provider<Api> & { [LIFTED_BASE]: Provider<Api> }
const liveProviders: Map<string, Provider<Api>[]> = ((globalThis as unknown as Record<symbol, Map<string, Provider<Api>[]> | undefined>)[
  Symbol.for('pi-multiprovider.live-providers')
] ??= new Map())

// The registry's copy of another instance's lift may be Pi's composed wrapper,
// which carries no tag of its own; match it against the live lifts instead.
const realBase = (providerId: string, provider: Provider<Api> | undefined): Provider<Api> | undefined => {
  let base = provider
  while (base !== undefined) {
    const candidate: Provider<Api> = base
    const lift = LIFTED_BASE in candidate
      ? candidate
      : liveProviders.get(providerId)?.find(live => LIFTED_BASE in live && isLiftOf(candidate, live))
    if (lift === undefined) break
    base = (lift as LiftedProvider)[LIFTED_BASE]
  }
  return base
}

/** Swaps `previous` for `next` among the live registrations and returns the newest one left. */
const replaceLiveProvider = (
  providerId: string,
  previous: Provider<Api> | undefined,
  next?: Provider<Api>,
): Provider<Api> | undefined => {
  const live = (liveProviders.get(providerId) ?? []).filter(provider => provider !== previous)
  if (next !== undefined) live.push(next)
  if (live.length === 0) liveProviders.delete(providerId)
  else liveProviders.set(providerId, live)
  return live.at(-1)
}

export default async function multiprovider(pi: ExtensionAPI): Promise<void> {
  const service = new MultiProviderService()
  const store = new MultiAuthStore()
  const externalIntegrations = new Map<string, AnyIntegration>()
  const managedIntegrations = new Map<string, AnyIntegration>()
  const managedBases = new Map<string, Provider<Api>>()
  const baseProviders = new Map<string, Provider<Api>>()
  const installedProviders = new Map<string, Provider<Api>>()
  const registeredIntegrations = new Map<string, AnyIntegration>()
  const unregisterSchedulers = new Map<string, () => void>()
  const warnedMissing = new Set<string>()
  const warnedOverlap = new Set<string>()
  const virtualConfigs = new Map<string, VirtualProviderConfig>()
  const virtualProviders = new Map<string, Provider<Api>>()
  const virtualIntegrations = new Map<string, ProviderRegistration<VirtualBackendRef>>()
  let currentContext: ExtensionContext | undefined
  // Provider callbacks run on every request and can outlive the context that
  // registered them: a Pi subagent loads this extension into a child session
  // that shares the parent's provider registry, and pi marks that session's
  // context stale once it is disposed. Keep plain values for those callbacks;
  // dereferencing a stale context throws and fails every later request.
  let currentSessionId: string | undefined
  let currentModelRegistry: ExtensionContext['modelRegistry'] | undefined
  const trackContext = (ctx: ExtensionContext): void => {
    currentContext = ctx
    currentSessionId = ctx.sessionManager.getSessionId()
    currentModelRegistry = ctx.modelRegistry
  }
  let pendingSessionPins: SessionPin[] = []
  let pendingInheritedSessionPins: InheritedSessionPin[] = []

  const effectiveIntegration = (providerId: string): AnyIntegration | undefined => {
    const managed = managedIntegrations.get(providerId)
    const external = externalIntegrations.get(providerId)
    if (managed !== undefined && external !== undefined && !warnedOverlap.has(providerId)) {
      warnedOverlap.add(providerId)
      currentContext?.ui.notify(
        `multiprovider: stored accounts take precedence over the provider-owned integration for "${providerId}"`,
        'warning',
      )
    }
    return managed ?? external
  }

  // Mirrors the affinity key the lifted provider computes for each stream: the
  // integration's own key when defined, otherwise the Pi session id. Custom
  // keys are invoked with a minimal context, so keys derived from request
  // message history cannot be reproduced here and fall back to the session id.
  const sessionAffinityKey = (
    integration: AnyIntegration | ProviderRegistration<VirtualBackendRef>,
    ctx: MultiProviderServiceContext,
    model: ExtensionContext['model'],
    providerId: string,
  ): string => {
    const fallback = ctx.sessionManager.getSessionId()
    const customAffinityKey = (integration as Partial<AnyIntegration>).affinityKey
    if (customAffinityKey === undefined || model === undefined) return fallback
    const provider = baseProviders.get(providerId)
      ?? ctx.modelRegistry.getProvider(providerId) as Provider<Api> | undefined
    if (provider === undefined) return fallback
    try {
      return customAffinityKey({ provider, model, context: normalizeContext({ messages: [] }) }) ?? fallback
    } catch {
      return fallback
    }
  }

  // Announced on MULTIPROVIDER_SERVICE_EVENT so sibling extensions can follow
  // the session's active pooled account; re-emitted at factory load and on
  // session start with the same stable object.
  const announcement = createServiceAnnouncement({
    scheduler: service,
    getIntegration: effectiveIntegration,
    getBaseProvider: (providerId, ctx) =>
      baseProviders.get(providerId)
      ?? ctx.modelRegistry.getProvider(providerId) as Provider<Api> | undefined,
    affinityKeyFor: (integration, ctx, providerId) =>
      sessionAffinityKey(integration, ctx, ctx.model, providerId),
  })

  const announceService = (): void => {
    pi.events.emit(MULTIPROVIDER_SERVICE_EVENT, announcement)
  }
  announceService()

  // Failover compaction: when a pooled account is abandoned after its final
  // tolerated error, switching to the next account resends the full request
  // context against a cold prompt cache. If pi-fabric is installed, its
  // deterministic (LLM-free) compaction engine shrinks the session during
  // the retry backoff window so the next account serves a small prefill.
  // While a compaction is scheduled, the stream surfaces the buffered error
  // instead of rotating accounts inline; the resulting retry run rebuilds
  // its context snapshot after compaction and lands on the next account.
  const FAILOVER_COMPACT_DEBOUNCE_MS = 30_000
  const FAILOVER_COMPACT_IDLE_TIMEOUT_MS = 15_000
  let lastFailoverCompactAt = 0

  const isFabricCompactionAvailable = (): boolean => {
    try {
      return pi.getAllTools().some(tool => tool.name === 'fabric_exec')
    } catch {
      return false
    }
  }

  const runFailoverCompaction = async (info: FailoverInfo): Promise<void> => {
    const ctx = currentContext
    if (ctx === undefined) return
    const startedAt = Date.now()
    if (startedAt - lastFailoverCompactAt < FAILOVER_COMPACT_DEBOUNCE_MS) return
    try {
      const pool = (await service.snapshot()).providers.find(
        candidate => candidate.id === info.providerId,
      )
      if (pool === undefined || pool.accounts.filter(account => account.enabled).length < 2) return
    } catch {
      return
    }
    // Wait out the failing run so compaction never aborts an active stream;
    // ctx.compact() aborts the current run as its first step.
    const deadline = startedAt + FAILOVER_COMPACT_IDLE_TIMEOUT_MS
    while (!ctx.isIdle() && Date.now() < deadline) {
      await new Promise(resolve => { setTimeout(resolve, 50) })
    }
    if (!ctx.isIdle() || Date.now() - lastFailoverCompactAt < FAILOVER_COMPACT_DEBOUNCE_MS) return
    lastFailoverCompactAt = Date.now()
    ctx.compact({
      onComplete: () => {
        ctx.ui.notify('multiprovider: compacted session context before account failover', 'info')
      },
      onError: () => {},
    })
  }

  const handleFailover = (info: FailoverInfo): boolean => {
    const integration = effectiveIntegration(info.providerId)
    const handled = integration?.onFailover?.(info) === true
    if (!isFabricCompactionAvailable()) return handled
    // Compaction surfaces the failure and relies on Pi to restart the turn.
    // Quota/auth failures are not host-retryable, so keep rotating inline.
    if (info.failure.assistantMessage === undefined
      || !isRetryableAssistantError(info.failure.assistantMessage)) return handled
    void runFailoverCompaction(info)
    return true
  }

  const restoreProvider = (providerId: string, ctx?: ExtensionContext): void => {
    const base = baseProviders.get(providerId)
    const installed = installedProviders.get(providerId)
    const current = ctx?.modelRegistry.getProvider(providerId)
    const newestLiveLift = replaceLiveProvider(providerId, installed)
    if (base !== undefined && (ctx === undefined || isLiftOf(current, installed))) pi.registerProvider(newestLiveLift ?? base)
    installedProviders.delete(providerId)
    baseProviders.delete(providerId)
    registeredIntegrations.delete(providerId)
    unregisterSchedulers.get(providerId)?.()
    unregisterSchedulers.delete(providerId)
  }

  const install = async (providerId: string, ctx: ExtensionContext): Promise<void> => {
    const integration = effectiveIntegration(providerId)
    if (integration === undefined) {
      restoreProvider(providerId, ctx)
      return
    }

    const current = ctx.modelRegistry.getProvider(providerId) as Provider<Api> | undefined
    const priorLift = installedProviders.get(providerId)
    const base = realBase(providerId, isLiftOf(current, priorLift) ? baseProviders.get(providerId) : current)
    if (base === undefined) {
      if (!warnedMissing.has(providerId)) {
        warnedMissing.add(providerId)
        ctx.ui.notify(`multiprovider: provider "${providerId}" is not registered`, 'warning')
      }
      return
    }
    warnedMissing.delete(providerId)

    if (registeredIntegrations.get(providerId) !== integration) {
      unregisterSchedulers.get(providerId)?.()
      try {
        unregisterSchedulers.set(providerId, service.registerProvider(integration))
        registeredIntegrations.set(providerId, integration)
      } catch (error) {
        ctx.ui.notify(errorText(error), 'error')
        return
      }
    }

    const managedPool = managedIntegrations.has(providerId)
      ? await store.getPool(providerId)
      : undefined
    if (managedPool !== undefined) {
      await service.updatePool(providerId, {
        policy: managedPool.policy,
        affinity: managedPool.affinity,
      })
    }

    if (isLiftOf(current, priorLift) && baseProviders.get(providerId) === base) return
    const sessionId = ctx.sessionManager.getSessionId()
    const affinityKey = integration.affinityKey ?? (() => sessionId)
    const lifted: Provider<Api> = {
      ...liftProvider(base, service, {
        ...integration,
        affinityKey,
        onFailover: handleFailover,
      }),
      // A headers object of its own lets isLiftOf() see through Pi's composition.
      headers: { ...base.headers },
    }
    Object.defineProperty(lifted, LIFTED_BASE, { value: base })
    replaceLiveProvider(providerId, priorLift, lifted)
    pi.registerProvider(lifted)
    baseProviders.set(providerId, base)
    installedProviders.set(providerId, lifted)
  }

  const refreshManaged = async (ctx: ExtensionContext): Promise<void> => {
    const storedIds = new Set(await store.listProviderIds())
    for (const providerId of [...managedIntegrations.keys()]) {
      if (storedIds.has(providerId)) continue
      managedIntegrations.delete(providerId)
      managedBases.delete(providerId)
      if (!externalIntegrations.has(providerId)) restoreProvider(providerId, ctx)
    }

    for (const providerId of storedIds) {
      const current = ctx.modelRegistry.getProvider(providerId) as Provider<Api> | undefined
      const priorLift = installedProviders.get(providerId)
      const base = realBase(providerId, isLiftOf(current, priorLift) ? baseProviders.get(providerId) : current)
      if (base === undefined) continue
      if (managedBases.get(providerId) !== base) {
        const runtime = probeSessionRuntime(ctx)
        if (typeof runtime?.getRegisteredProviderConfig === 'function') {
          rememberConfiguredApiKey(base, runtime.getRegisteredProviderConfig(providerId)?.apiKey)
        }
        managedBases.set(providerId, base)
        managedIntegrations.set(
          providerId,
          createManagedIntegration(base, store) as AnyIntegration,
        )
      }
    }
  }

  const unregisterVirtualModels = (config: VirtualProviderConfig): void => {
    for (const model of config.models) {
      const schedulerId = virtualSchedulerId(config.id, model.id)
      unregisterSchedulers.get(schedulerId)?.()
      unregisterSchedulers.delete(schedulerId)
      virtualIntegrations.delete(schedulerId)
    }
  }

  // Virtual providers round-robin sessions across backing provider models with
  // no first-provider bias; session affinity pins a session to one backend so
  // prompt caches stay warm between hops.
  const refreshVirtual = async (): Promise<void> => {
    const stored = await store.listVirtualProviders()
    const storedIds = new Set(stored.map(config => config.id))
    for (const providerId of [...virtualConfigs.keys()]) {
      if (storedIds.has(providerId)) continue
      const prior = virtualConfigs.get(providerId)
      if (prior !== undefined) unregisterVirtualModels(prior)
      virtualConfigs.delete(providerId)
      if (virtualProviders.has(providerId)) {
        // Deleted from the shared store: every session's registration is obsolete.
        liveProviders.delete(providerId)
        pi.unregisterProvider(providerId)
        virtualProviders.delete(providerId)
      }
    }

    // Heals configs saved before backend templates were captured: once
    // backing providers are registered (install ran), resolve live metadata
    // and persist it so the next extension load snapshots virtual models with
    // correct thinking support. Best-effort; failures retry next reconcile.
    // One catalog read per backing provider per pass: several virtual models
    // usually share a backing provider, and getModels() may rebuild its list.
    const catalogs = new Map<string, readonly Model<Api>[]>()
    const resolveTemplate = (providerId: string, modelId: string): VirtualModelTemplate | undefined => {
      let catalog = catalogs.get(providerId)
      if (catalog === undefined) {
        const provider = installedProviders.get(providerId)
          ?? baseProviders.get(providerId)
          ?? currentModelRegistry?.getProvider(providerId) as Provider<Api> | undefined
        catalog = provider?.getModels() ?? []
        catalogs.set(providerId, catalog)
      }
      const model = catalog.find(item => item.id === modelId)
      return model === undefined ? undefined : captureVirtualModelTemplate(model)
    }
    for (const storedConfig of stored) {
      const healed = healVirtualTemplates(storedConfig, resolveTemplate)
      if (healed !== undefined) {
        try {
          await store.saveVirtualProvider(healed)
        } catch {
          // Template persistence is best-effort; live resolution still wins.
        }
      }
      const config = healed ?? storedConfig
      const prior = virtualConfigs.get(config.id)
      if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(config)) continue
      if (prior !== undefined) unregisterVirtualModels(prior)

      // Registration runs at extension load, before any session exists; the
      // closures only read the session snapshot once a session is streaming.
      const providerLabel = (providerId: string): string | undefined =>
        baseProviders.get(providerId)?.name
        ?? currentModelRegistry?.getProvider(providerId)?.name

      const integrations = createVirtualIntegrations(config, { getProviderLabel: providerLabel })
      for (const integration of integrations) {
        unregisterSchedulers.get(integration.id)?.()
        unregisterSchedulers.set(integration.id, service.registerProvider(integration))
        virtualIntegrations.set(integration.id, integration)
      }

      const virtualProvider = createVirtualProvider({
        service,
        config,
        onFailover: handleFailover,
        getAffinityKey: () => currentSessionId ?? '',
        getBackingProvider: providerId =>
          installedProviders.get(providerId)
          ?? baseProviders.get(providerId)
          ?? currentModelRegistry?.getProvider(providerId) as Provider<Api> | undefined,
        isBackendConfigured: providerId =>
          currentModelRegistry?.getProviderAuthStatus(providerId).configured ?? true,
        resolveAmbientAuth: async (_providerId, model, signal) => {
          const registry = currentModelRegistry
          if (registry === undefined) return { ok: false, error: 'multiprovider: session not ready' }
          const resolution = await registry.getApiKeyAndHeaders(model)
          if (!resolution.ok) return { ok: false, error: resolution.error }
          return {
            ok: true,
            ...(resolution.apiKey === undefined ? {} : { apiKey: resolution.apiKey }),
            ...(resolution.headers === undefined ? {} : { headers: resolution.headers }),
            ...(resolution.baseUrl === undefined ? {} : { baseUrl: resolution.baseUrl }),
            ...(resolution.env === undefined ? {} : { env: resolution.env }),
          }
        },
      })
      replaceLiveProvider(config.id, virtualProviders.get(config.id), virtualProvider)
      pi.registerProvider(virtualProvider)
      virtualProviders.set(config.id, virtualProvider)
      virtualConfigs.set(config.id, config)
    }
  }

  // Register stored virtual providers during extension load: pi resolves
  // model patterns (enabled models, resumed session models) right after
  // extensions load and before session_start fires, so virtual models must
  // already be in the registry for session resume to find them.
  await refreshVirtual()

  // /switch-account records each explicit pin — and each return to automatic
  // selection — as a custom session entry. Resuming the session replays the
  // last decision so it keeps the operator's chosen account instead of falling
  // back to the pool strategy; account health and implicit affinity stay in
  // memory. Pools whose scheduler is not registered yet stay pending until a
  // later reconcile can apply them.
  const affinityKeyForPool = (poolId: string, ctx: ExtensionContext): string => {
    const virtual = virtualIntegrations.get(poolId)
    const integration = virtual ?? effectiveIntegration(poolId)
    if (integration === undefined) return ctx.sessionManager.getSessionId()
    const providerId = virtual !== undefined ? ctx.model?.provider ?? poolId : poolId
    return sessionAffinityKey(integration, ctx, ctx.model, providerId)
  }

  const applyRecordedPins = async (ctx: ExtensionContext): Promise<void> => {
    const restoredPools = new Set<string>()
    const pinHost = {
      hasPool: (poolId: string) => service.hasProvider(poolId),
      pin: (poolId: string, key: string, accountId: string) => service.pinAccount(poolId, key, accountId),
      clear: (poolId: string, key: string) => service.clearAffinity(poolId, key),
    }
    const onRestoreError = (pin: SessionPin, error: unknown): void => {
      const target = pin.label === undefined ? pin.accountId ?? '' : `"${pin.label}"`
      ctx.ui.notify(
        `multiprovider: pinned account ${target} could not be restored for "${pin.pool}": ${errorText(error)}`,
        'warning',
      )
    }

    if (pendingSessionPins.length > 0) {
      pendingSessionPins = await applySessionPins(
        pendingSessionPins,
        pinHost,
        onRestoreError,
        pin => restoredPools.add(pin.pool),
      )
    }

    if (pendingInheritedSessionPins.length > 0) {
      const recordedPools = new Set([
        ...pendingSessionPins.map(pin => pin.pool),
        ...sessionPinsFromEntries(ctx.sessionManager.getEntries()).map(pin => pin.pool),
      ])
      const ready: SessionPin[] = []
      const stillPending: InheritedSessionPin[] = []
      for (const pin of pendingInheritedSessionPins) {
        if (recordedPools.has(pin.pool)) continue
        if (!service.hasProvider(pin.pool)) {
          stillPending.push(pin)
          continue
        }
        ready.push({
          pool: pin.pool,
          key: affinityKeyForPool(pin.pool, ctx),
          ...(pin.accountId === undefined ? {} : { accountId: pin.accountId }),
          ...(pin.label === undefined ? {} : { label: pin.label }),
        })
      }
      const leftover = await applySessionPins(ready, pinHost, onRestoreError, pin => {
        restoredPools.add(pin.pool)
        pi.appendEntry(SESSION_PIN_ENTRY_TYPE, {
          pool: pin.pool,
          key: pin.key,
          ...(pin.accountId === undefined ? {} : { accountId: pin.accountId }),
          ...(pin.label === undefined ? {} : { label: pin.label }),
        })
      })
      pendingInheritedSessionPins = [
        ...stillPending,
        ...leftover.map(pin => ({
          pool: pin.pool,
          ...(pin.accountId === undefined ? {} : { accountId: pin.accountId }),
          ...(pin.label === undefined ? {} : { label: pin.label }),
        })),
      ]
    }

    // Followers of the session's active account — pi-better-openai's usage
    // widget, for example — re-resolve their account-scoped state from this
    // notification. Without it a resumed session keeps showing the account it
    // had before the switch until the follower's own next poll.
    for (const poolId of restoredPools) {
      const account = await announcement.getActiveAccount(poolId, ctx)
      announcement.notifyActiveAccountChanged(poolId, ctx, account)
    }
  }

  const reconcile = async (ctx: ExtensionContext): Promise<void> => {
    service.updateSchedulerDefaults(await store.getSchedulerSettings())
    // Factory registration already exposes restored models. Reconcile virtuals
    // once, after physical lifts are ready, so template healing does not scan
    // and register the same catalog both before and after installation.
    await refreshManaged(ctx)
    const ids = new Set([
      ...externalIntegrations.keys(),
      ...managedIntegrations.keys(),
      ...installedProviders.keys(),
    ])
    for (const providerId of ids) await install(providerId, ctx)
    await refreshVirtual()
    await applyRecordedPins(ctx)
  }

  const unsubscribeRegistration = pi.events.on(MULTIPROVIDER_REGISTER_EVENT, value => {
    if (!isIntegration(value)) return
    const existing = externalIntegrations.get(value.id)
    if (existing === value) return
    externalIntegrations.set(value.id, value)
    if (currentContext !== undefined) void install(value.id, currentContext)
  })

  pi.on('session_start', async (_event, ctx) => {
    trackContext(ctx)
    pendingSessionPins = sessionPinsFromEntries(ctx.sessionManager.getEntries())
    const recordedPools = new Set(pendingSessionPins.map(pin => pin.pool))
    pendingInheritedSessionPins = inheritedSessionPinsFromEnv(process.env)
      .filter((pin: InheritedSessionPin) => !recordedPools.has(pin.pool))
    await reconcile(ctx)
    announceService()
  })

  pi.on('before_agent_start', async (_event, ctx) => {
    trackContext(ctx)
    await reconcile(ctx)
  })

  pi.on('session_shutdown', () => {
    unsubscribeRegistration()
    for (const providerId of installedProviders.keys()) restoreProvider(providerId, currentContext)
    managedIntegrations.clear()
    managedBases.clear()
    for (const [providerId, provider] of virtualProviders) {
      const newest = replaceLiveProvider(providerId, provider)
      // Another live session registered this id after us; leave its registration.
      if (currentModelRegistry !== undefined && currentModelRegistry.getProvider(providerId) !== provider) continue
      if (newest === undefined) pi.unregisterProvider(providerId)
      else pi.registerProvider(newest)
    }
    virtualProviders.clear()
    virtualIntegrations.clear()
    virtualConfigs.clear()
    pendingSessionPins = []
    pendingInheritedSessionPins = []
    currentContext = undefined
  })

  pi.registerCommand('multilogin', {
    description: 'Manage a provider pool, Pi default auth, schedulers, and accounts',
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify('/multilogin requires Pi interactive mode.', 'warning')
        return
      }
      const [{ selectLogin, promptApiKeyCredential, showLoginDialog }, { openPoolManager }] = await Promise.all([
        import('../src/multilogin.ts'),
        import('./pool-manager.ts'),
      ])
      await reconcile(ctx)
      const providers = uniqueProviders(ctx, baseProviders)
        .filter(provider => !virtualProviders.has(provider.id))
      const selection = await selectLogin(ctx, providers, args.trim() || undefined)
      if (selection === undefined) return
      const provider = selection.provider

      interface BufferedPool {
        policy: SelectionPolicy
        affinity: boolean
        includeUpstream: boolean
        upstream: MultiAuthUpstreamPreferences
      }
      const initialPool = await store.getPool(provider.id)
      let buffer: BufferedPool = {
        policy: initialPool?.policy ?? 'round-robin',
        affinity: initialPool?.affinity ?? true,
        includeUpstream: initialPool?.includeUpstream ?? true,
        upstream: { ...(initialPool?.upstream ?? {}) },
      }

      const callbacks: PoolManagerCallbacks = {
        async loadState() {
          const pool = await store.getPool(provider.id)
          const scheduler = await store.getSchedulerSettings()
          const runtime = probeSessionRuntime(ctx)
          const upstreamStatus = runtime?.getProviderAuthStatus(provider.id)
          const upstreamConfigured = upstreamStatus !== undefined && upstreamStatus.configured
          const upstreamSource = upstreamConfigured ? (upstreamStatus.label ?? upstreamStatus.source) : undefined
          const upstreamState = {
            ...(upstreamConfigured ? { upstreamConfigured } : {}),
            ...(upstreamSource === undefined ? {} : { upstreamSource }),
          }
          if (pool === undefined) {
            return {
              poolExists: false,
              policy: buffer.policy,
              affinity: buffer.affinity,
              includeUpstream: buffer.includeUpstream,
              upstream: { ...buffer.upstream },
              accounts: [],
              scheduler,
              ...upstreamState,
            }
          }
          buffer = {
            policy: pool.policy,
            affinity: pool.affinity,
            includeUpstream: pool.includeUpstream,
            upstream: { ...(pool.upstream ?? {}) },
          }
          return {
            poolExists: true,
            policy: pool.policy,
            affinity: pool.affinity,
            includeUpstream: pool.includeUpstream,
            upstream: { ...(pool.upstream ?? {}) },
            accounts: pool.accounts,
            scheduler,
            ...upstreamState,
          }
        },
        async updatePool(settings) {
          if (await store.getPool(provider.id) === undefined) {
            if (settings.policy !== undefined) buffer.policy = settings.policy
            if (settings.affinity !== undefined) buffer.affinity = settings.affinity
            if (settings.includeUpstream !== undefined) buffer.includeUpstream = settings.includeUpstream
            if (settings.upstream !== undefined) buffer.upstream = { ...settings.upstream }
            return
          }
          await store.updatePool(provider.id, settings)
          await reconcile(ctx)
        },
        async updateAccount(accountId, settings) {
          await store.updateAccount(provider.id, accountId, settings)
          await reconcile(ctx)
        },
        async removeAccount(accountId) {
          await store.removeAccount(provider.id, accountId)
          await reconcile(ctx)
        },
        async updateScheduler(key, valueMs) {
          const patch: SchedulerSettingsPatch = { [key]: valueMs }
          const effective = await store.updateSchedulerSettings(patch)
          service.updateSchedulerDefaults(effective)
        },
      }

      const methods: PoolManagerAuthMethod[] = []
      if (provider.auth.oauth?.login !== undefined) {
        methods.push({ label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name, value: 'oauth' })
      }
      if (provider.auth.apiKey !== undefined) {
        const interactive = provider.auth.apiKey.login !== undefined
        const keyName = provider.auth.apiKey.name
        const baseLabel = keyName === 'API key' ? 'API key' : `API key · ${keyName}`
        methods.push({
          label: interactive ? baseLabel : `${baseLabel} (paste)`,
          value: interactive ? 'api_key' : 'api_key_paste',
        })
      }

      const runLogin = async (method: string, title?: string) =>
        method === 'api_key_paste'
          ? await promptApiKeyCredential(ctx, provider)
          : await showLoginDialog(
              ctx,
              { provider, authType: method as AuthType },
              title === undefined ? {} : { title },
            )

      let result = await openPoolManager(ctx, provider, callbacks, methods)
      while (result.type === 'add' || result.type === 'reauth') {
        if (result.type === 'reauth') {
          const reauthAccountId = result.accountId
          const pool = await store.getPool(provider.id)
          const account = pool?.accounts.find(candidate => candidate.id === reauthAccountId)
          if (account === undefined) {
            ctx.ui.notify('That account is no longer stored.', 'warning')
          } else {
            const login = await runLogin(result.method, `Reauthenticate ${account.label}`)
            if (login !== undefined && 'error' in login) {
              ctx.ui.notify(`Failed to reauthenticate ${account.label}: ${login.error.message}`, 'error')
            } else if (login !== undefined) {
              let credential: Credential | undefined = login.credential
              try {
                await store.replaceAccountCredential(provider.id, account.id, credential)
                credential = undefined
                if (service.hasProvider(provider.id)) service.resetHealth(provider.id, account.id)
                await reconcile(ctx)
                ctx.ui.notify(
                  `Reauthenticated ${account.label} for ${provider.name}. Credentials saved to ${getMultiAuthPath()}`,
                  'info',
                )
              } catch (error) {
                credential = undefined
                ctx.ui.notify(`Could not replace account credentials: ${errorText(error)}`, 'error')
              }
            }
          }
        } else {
          const method = result.method
          const existing = await store.getPool(provider.id)
          const defaultLabel = `${provider.name} ${(existing?.accounts.length ?? 0) + 1}`
          const labelInput = await ctx.ui.input('Account label:', defaultLabel)
          if (labelInput !== undefined) {
            const label = labelInput.trim() || defaultLabel
            const login = await runLogin(method)
            if (login !== undefined && 'error' in login) {
              ctx.ui.notify(`Failed to authenticate ${provider.name}: ${login.error.message}`, 'error')
            } else if (login !== undefined) {
              let credential: Credential | undefined = login.credential
              try {
                await store.addAccount(provider.id, {
                  label,
                  credential,
                  ...(await store.getPool(provider.id) === undefined
                    ? {
                        pool: {
                          policy: buffer.policy,
                          affinity: buffer.affinity,
                          includeUpstream: buffer.includeUpstream,
                          upstream: buffer.upstream,
                        },
                      }
                    : {}),
                })
                credential = undefined
                await reconcile(ctx)
                ctx.ui.notify(
                  `Added ${label} to ${provider.name}. Credentials saved to ${getMultiAuthPath()}`,
                  'info',
                )
              } catch (error) {
                credential = undefined
                ctx.ui.notify(`Could not save account: ${errorText(error)}`, 'error')
              }
            }
          }
        }
        result = await openPoolManager(ctx, provider, callbacks, methods)
      }
    },
  })

  pi.registerCommand('multilogout', {
    description: 'Remove an account saved by /multilogin',
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify('/multilogout requires Pi interactive mode.', 'warning')
        return
      }
      const pools = (await Promise.all(
        (await store.listProviderIds()).map(providerId => store.getPool(providerId)),
      )).filter(pool => pool !== undefined)
      if (pools.length === 0) {
        ctx.ui.notify('No multilogin accounts are stored.', 'info')
        return
      }
      const ref = args.trim().toLowerCase()
      let pool = ref === ''
        ? undefined
        : pools.find(candidate => candidate.providerId.toLowerCase() === ref)
      if (pool === undefined) {
        const labels = pools.map(candidate => {
          const provider = baseProviders.get(candidate.providerId)
          return `${provider?.name ?? candidate.providerId} (${candidate.accounts.length})`
        })
        const selected = await ctx.ui.select('Select provider to remove an account from:', labels)
        const index = labels.indexOf(selected ?? '')
        if (index < 0) return
        pool = pools[index]
      }
      if (pool === undefined) return
      const accountLabels = pool.accounts.map(account => `${account.label} · ${account.authKind}`)
      const selectedAccount = await ctx.ui.select('Select account to remove:', accountLabels)
      const accountIndex = accountLabels.indexOf(selectedAccount ?? '')
      if (accountIndex < 0) return
      const account = pool.accounts[accountIndex]
      if (account === undefined) return
      const confirmation = await ctx.ui.confirm(
        'Remove pooled account?',
        `Remove ${account.label} from ${pool.providerId}? Pi's normal /login credential is unchanged.`,
      )
      if (!confirmation) return
      await store.removeAccount(pool.providerId, account.id)
      await reconcile(ctx)
      ctx.ui.notify(`Removed ${account.label} from ${pool.providerId}.`, 'info')
    },
  })

  pi.registerCommand('accounts', {
    description: 'Show multiprovider account pools and health',
    handler: async (_args, ctx) => {
      await reconcile(ctx)
      const snapshot = await service.snapshot()
      if (snapshot.providers.length === 0) {
        ctx.ui.notify('No account pools are configured. Use /multilogin to add one.', 'info')
        return
      }
      const runtime = probeSessionRuntime(ctx)
      await ctx.ui.select('Provider Accounts', statusLines(snapshot, providerId => {
        if (runtime === undefined) return false
        try {
          return !liveUpstreamConfigured(runtime.getProviderAuthStatus(providerId), baseProviders.get(providerId))
        } catch {
          return false
        }
      }))
    },
  })

  pi.registerCommand('switch-account', {
    description: 'Switch the pooled account used by the current model for this session',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('/switch-account requires Pi interactive mode.', 'warning')
        return
      }
      await reconcile(ctx)
      const model = ctx.model
      if (model === undefined) {
        ctx.ui.notify('No model is selected.', 'info')
        return
      }
      const providerId = model.provider
      const virtual = virtualIntegrations.get(virtualSchedulerId(providerId, model.id))
      const integration = virtual ?? effectiveIntegration(providerId)
      const poolId = virtual !== undefined ? virtual.id : providerId
      const providerName = virtual !== undefined
        ? `${virtualProviders.get(providerId)?.name ?? providerId} · ${model.name}`
        : ctx.modelRegistry.getProvider(providerId)?.name ?? providerId
      const pool = integration === undefined
        ? undefined
        : (await service.snapshot()).providers.find(candidate => candidate.id === poolId)
      const accounts = pool?.accounts ?? []
      if (integration === undefined || pool === undefined || accounts.length === 0) {
        ctx.ui.notify(`${providerName} has no pooled accounts. Use /multilogin to add one.`, 'info')
        return
      }
      // The upstream account is excluded from attempts while Pi has no
      // credential configured for it, so pinning it then would never apply.
      const upstreamConfigured = probeSessionRuntime(ctx)
        ?.getProviderAuthStatus(providerId)?.configured !== false
      const switchable = accounts.filter(account =>
        account.id !== PI_UPSTREAM_ACCOUNT_ID || upstreamConfigured)
      if (switchable.length === 0) {
        ctx.ui.notify(`No switchable accounts for ${providerName}. Use /multilogin to add one.`, 'info')
        return
      }

      const affinityKey = sessionAffinityKey(integration, ctx, model, providerId)
      const pin = service.getAffinity(poolId, affinityKey)
      const currentId = pin !== undefined && (pool.affinity || pin.explicit)
        ? pin.accountId
        : undefined

      // Sibling extensions following the active account (usage widgets and the
      // like) re-resolve their account-scoped state from this notification.
      const announceSwitch = async (): Promise<void> => {
        const account = await announcement.getActiveAccount(poolId, ctx)
        announcement.notifyActiveAccountChanged(poolId, ctx, account)
      }

      const ref = args.trim()
      let automatic = false
      let chosen: PublicAccountSnapshot | undefined
      if (ref !== '') {
        const normalized = ref.toLowerCase()
        let matches = switchable.filter(account => account.label.toLowerCase() === normalized)
        if (matches.length === 0) {
          matches = switchable.filter(account => account.label.toLowerCase().startsWith(normalized))
        }
        if (matches.length === 1) chosen = matches[0]
        else if (matches.length === 0 && AUTOMATIC_SWITCH_REFS.has(normalized)) automatic = true
        else if (matches.length > 1) {
          ctx.ui.notify(`Multiple accounts match "${ref}". Pick one below.`, 'warning')
        } else {
          ctx.ui.notify(`No pooled account for ${providerName} matches "${ref}". Pick one below.`, 'warning')
        }
      }

      if (!automatic && chosen === undefined) {
        const labels = [
          `Automatic · let the ${pool.policy} strategy pick the next account`,
          ...switchAccountLabels(switchable, currentId),
        ]
        const selected = await ctx.ui.select(`Switch ${providerName} account:`, labels)
        const index = labels.indexOf(selected ?? '')
        if (index < 0) return
        if (index === 0) automatic = true
        else chosen = switchable[index - 1]
      }

      if (automatic) {
        service.clearAffinity(poolId, affinityKey)
        pi.appendEntry(SESSION_PIN_ENTRY_TYPE, { pool: poolId, key: affinityKey })
        await announceSwitch()
        ctx.ui.notify(
          pool.affinity
            ? "Cleared this session's pinned account. The next request re-selects using the pool strategy."
            : 'Selection for this session is already automatic.',
          'info',
        )
        return
      }

      const account = chosen
      if (account === undefined) return
      if (!account.enabled) {
        ctx.ui.notify(`Account "${account.label}" is disabled. Enable it in /multilogin first.`, 'error')
        return
      }
      try {
        await service.pinAccount(poolId, affinityKey, account.id)
      } catch (error) {
        ctx.ui.notify(`Could not switch account: ${errorText(error)}`, 'error')
        return
      }
      // Recorded so a resumed session re-applies the switch instead of falling
      // back to the pool strategy.
      pi.appendEntry(SESSION_PIN_ENTRY_TYPE, {
        pool: poolId,
        key: affinityKey,
        accountId: account.id,
        label: account.label,
      })
      await announceSwitch()
      const cooldown = account.cooldownUntil === undefined
        ? ''
        : ` It cools down until ${new Date(account.cooldownUntil).toLocaleTimeString()}; other accounts serve until it recovers.`
      ctx.ui.notify(
        `Switched to ${account.label} for this session. Pool settings are unchanged; new requests from this session use it.${cooldown}`,
        'info',
      )
    },
  })

  pi.registerCommand('vprovider', {
    description: 'Create virtual providers that map one model across multiple provider models',
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify('/vprovider requires Pi interactive mode.', 'warning')
        return
      }
      await reconcile(ctx)
      const stored = await store.listVirtualProviders()
      const candidates = uniqueProviders(ctx, baseProviders)
        .filter(provider => !virtualProviders.has(provider.id) && provider.getModels().length > 0)
      const ref = args.trim().toLowerCase()
      const existing = ref === '' ? undefined : stored.find(candidate => candidate.id.toLowerCase() === ref)
      const { VirtualProviderEditorDialog } = await import('./virtual-editor.ts')
      const outcome = await ctx.ui.custom<VirtualEditorOutcome>(
        (_tui, theme, _keybindings, done) => new VirtualProviderEditorDialog({
          theme,
          stored,
          candidates,
          isProviderIdAvailable: id => !virtualProviders.has(id) && ctx.modelRegistry.getProvider(id) === undefined,
          startDraft: existing === undefined ? undefined : structuredClone(existing),
          done,
        }),
      )
      if (outcome === undefined || outcome.kind === 'dismissed' || outcome.kind === 'discarded') return
      if (outcome.kind === 'removed') {
        const confirmed = await ctx.ui.confirm(
          'Remove virtual provider?',
          `Remove ${outcome.id}? Backing providers and their pooled accounts are untouched.`,
        )
        if (!confirmed) return
        await store.removeVirtualProvider(outcome.id)
        await reconcile(ctx)
        ctx.ui.notify(`Removed virtual provider "${outcome.id}".`, 'info')
        return
      }
      await store.saveVirtualProvider(outcome.draft)
      await reconcile(ctx)
      const verb = stored.some(candidate => candidate.id === outcome.draft.id) ? 'Saved' : 'Created'
      ctx.ui.notify(`${verb} virtual provider "${outcome.draft.id}". Select "${outcome.draft.models[0]!.id}" on provider "${outcome.draft.id}" in /model.`, 'info')
    },
  })
}
