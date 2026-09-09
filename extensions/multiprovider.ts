import type { Api, AuthType, Context, Credential, Model, Provider } from '@earendil-works/pi-ai'
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { Container, fuzzyFilter, Input, Text } from '@earendil-works/pi-tui'
import {
  createManagedIntegration,
  createServiceAnnouncement,
  getMultiAuthPath,
  liftProvider,
  MULTIPROVIDER_REGISTER_EVENT,
  MULTIPROVIDER_SERVICE_EVENT,
  MultiAuthStore,
  MultiProviderService,
  PI_UPSTREAM_ACCOUNT_ID,
  type MultiAuthUpstreamPreferences,
  type MultiProviderIntegration,
  type MultiProviderServiceContext,
  type ProviderRegistration,
  type PublicAccountSnapshot,
  type SchedulerSettingsPatch,
  type SelectionPolicy,
  type VirtualProviderConfig,
  createVirtualIntegrations,
  createVirtualProvider,
  virtualSchedulerId,
} from '../src/index.ts'
import { promptApiKeyCredential, probeSessionRuntime, selectLogin, showLoginDialog } from '../src/multilogin.ts'
import {
  openPoolManager,
  type PoolManagerAuthMethod,
  type PoolManagerCallbacks,
} from './pool-manager.ts'

type AnyIntegration = MultiProviderIntegration<Api, unknown>
type VirtualBackendRef = import('../src/index.ts').VirtualBackend

interface SearchableOption {
  value: string
  label: string
  /** Extra text matched by the filter in addition to the label. */
  searchText?: string
}

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

function statusLines(snapshot: Awaited<ReturnType<MultiProviderService['snapshot']>>): string[] {
  const lines: string[] = []
  for (const provider of snapshot.providers) {
    lines.push(
      `${provider.label} (${provider.id}) · ${provider.policy}`
      + `${provider.firstAccountBias ? ' · main-first' : ''}`
      + ` · affinity ${provider.affinity ? 'on' : 'off'}`,
    )
    if (provider.accounts.length === 0) {
      lines.push('  no accounts')
      continue
    }
    for (const account of provider.accounts) {
      const cooldown = account.cooldownUntil === undefined
        ? ''
        : ` · cooldown until ${new Date(account.cooldownUntil).toLocaleTimeString()}`
      lines.push(
        `  ${account.label} (${account.authKind}) · ${account.status} · w${account.weight} · p${account.priority} · ${account.inFlight} in flight · ${account.consecutiveFailures} failures${cooldown}`,
      )
    }
  }
  return lines
}

const AUTOMATIC_SWITCH_REFS = new Set(['auto', 'automatic'])

// Ids compose into scheduler ids and backend account ids via '::' separators.
const VIRTUAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

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
      return customAffinityKey({ provider, model, context: { messages: [] } }) ?? fallback
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

  const restoreProvider = (providerId: string, ctx?: ExtensionContext): void => {
    const base = baseProviders.get(providerId)
    const installed = installedProviders.get(providerId)
    const current = ctx?.modelRegistry.getProvider(providerId)
    if (base !== undefined && (ctx === undefined || current === installed)) pi.registerProvider(base)
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
    const base = current === priorLift ? baseProviders.get(providerId) : current
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

    if (current === priorLift && baseProviders.get(providerId) === base) return
    const affinityKey = integration.affinityKey
      ?? (() => ctx.sessionManager.getSessionId())
    const lifted = liftProvider(base, service, { ...integration, affinityKey })
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
      const base = current === priorLift ? baseProviders.get(providerId) : current
      if (base === undefined) continue
      if (managedBases.get(providerId) !== base) {
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
        pi.unregisterProvider(providerId)
        virtualProviders.delete(providerId)
      }
    }

    for (const config of stored) {
      const prior = virtualConfigs.get(config.id)
      if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(config)) continue
      if (prior !== undefined) unregisterVirtualModels(prior)

      // Registration runs at extension load, before any session exists; the
      // closures only dereference the context once a session is streaming.
      const sessionContext = (): ExtensionContext | undefined => currentContext
      const providerLabel = (providerId: string): string | undefined =>
        baseProviders.get(providerId)?.name
        ?? sessionContext()?.modelRegistry.getProvider(providerId)?.name

      const integrations = createVirtualIntegrations(config, { getProviderLabel: providerLabel })
      for (const integration of integrations) {
        unregisterSchedulers.get(integration.id)?.()
        unregisterSchedulers.set(integration.id, service.registerProvider(integration))
        virtualIntegrations.set(integration.id, integration)
      }

      const virtualProvider = createVirtualProvider({
        service,
        config,
        getAffinityKey: () => sessionContext()?.sessionManager.getSessionId() ?? '',
        getBackingProvider: providerId =>
          installedProviders.get(providerId)
          ?? baseProviders.get(providerId)
          ?? sessionContext()?.modelRegistry.getProvider(providerId) as Provider<Api> | undefined,
        isBackendConfigured: providerId =>
          sessionContext()?.modelRegistry.getProviderAuthStatus(providerId).configured ?? true,
        resolveAmbientAuth: async (_providerId, model, signal) => {
          const context = sessionContext()
          if (context === undefined) return { ok: false, error: 'multiprovider: session not ready' }
          const resolution = await context.modelRegistry.getApiKeyAndHeaders(model)
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

  const reconcile = async (ctx: ExtensionContext): Promise<void> => {
    service.updateSchedulerDefaults(await store.getSchedulerSettings())
    await refreshVirtual()
    await refreshManaged(ctx)
    const ids = new Set([
      ...externalIntegrations.keys(),
      ...managedIntegrations.keys(),
      ...installedProviders.keys(),
    ])
    for (const providerId of ids) await install(providerId, ctx)
    await refreshVirtual()
  }

  // Fixed-height, type-to-filter selection dialog modeled on the core /model
  // picker: an Input filters a scrolled list of rows with fuzzy matching, and
  // the scheduler keybindings route up/down/enter/escape to the list while
  // every other key feeds the filter.
  const searchableSelect = async (
    ctx: ExtensionContext,
    title: string,
    options: SearchableOption[],
  ): Promise<string | undefined> => {
    if (options.length === 0) return undefined
    const maxVisible = 10
    const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
      let query = ''
      let selectedIndex = 0
      let filtered = options
      const container = new Container()
      container.addChild(new DynamicBorder(s => theme.fg('accent', s)))
      container.addChild(new Text(theme.fg('accent', theme.bold(title)), 1, 0))
      const searchInput = new Input({ placeholder: 'filter' })
      searchInput.focused = true
      container.addChild(searchInput)
      const listContainer = new Container()
      container.addChild(listContainer)
      container.addChild(new Text(theme.fg('dim', 'type to filter · ↑↓ select · enter confirm · esc cancel'), 1, 0))
      container.addChild(new DynamicBorder(s => theme.fg('accent', s)))

      const updateList = () => {
        listContainer.clear()
        if (filtered.length === 0) {
          listContainer.addChild(new Text(theme.fg('muted', '  No matches'), 0, 0))
          return
        }
        const startIndex = Math.max(0, Math.min(
          selectedIndex - Math.floor(maxVisible / 2),
          filtered.length - maxVisible,
        ))
        const endIndex = Math.min(startIndex + maxVisible, filtered.length)
        for (let index = startIndex; index < endIndex; index++) {
          const option = filtered[index]!
          const cursor = index === selectedIndex ? theme.fg('accent', '→ ') : '  '
          listContainer.addChild(new Text(cursor + option.label, 0, 0))
        }
        if (startIndex > 0 || endIndex < filtered.length) {
          listContainer.addChild(new Text(theme.fg('muted', `  (${selectedIndex + 1}/${filtered.length})`), 0, 0))
        }
      }

      const refilter = () => {
        const needle = query.trim()
        filtered = needle === '' ? options : fuzzyFilter(options, needle, option => option.searchText ?? option.label)
        selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1))
        updateList()
      }

      updateList()
      return {
        render: width => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: data => {
          if (keybindings.matches(data, 'tui.select.up')) {
            if (filtered.length > 0) selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length
          } else if (keybindings.matches(data, 'tui.select.down')) {
            if (filtered.length > 0) selectedIndex = (selectedIndex + 1) % filtered.length
          } else if (keybindings.matches(data, 'tui.select.confirm')) {
            const option = filtered[selectedIndex]
            if (option !== undefined) done(option.value)
            return
          } else if (keybindings.matches(data, 'tui.select.cancel')) {
            done(null)
            return
          } else {
            searchInput.handleInput(data)
            const next = searchInput.getValue()
            if (next !== query) {
              query = next
              refilter()
            }
          }
          updateList()
          tui.requestRender()
        },
      }
    })
    return result ?? undefined
  }

  // Interactive editor for a virtual provider draft. The UI manages one
  // virtual model per provider; extra models (created programmatically) are
  // preserved untouched through saves.
  const editVirtualProvider = async (
    ctx: ExtensionContext,
    draft: VirtualProviderConfig,
  ): Promise<boolean> => {
    const model = draft.models[0]!
    while (true) {
      const rows: string[] = [
        `Model id: ${model.id}`,
        'Add backing provider model',
        ...model.backends.map((backend, backendIndex) =>
          `${backendIndex + 1}. ${backend.providerId} · ${backend.modelId}`
          + ` · ${backend.enabled === false ? 'disabled' : 'enabled'} · w${backend.weight ?? 1}`),
        'Save and apply',
        'Discard changes',
      ]
      const selected = await ctx.ui.select(`Virtual provider "${draft.id}":`, rows)
      const rowIndex = rows.indexOf(selected ?? '')
      if (rowIndex < 0) return false
      const row = rows[rowIndex]!

      if (row === 'Discard changes') return false
      if (row === 'Save and apply') {
        if (model.backends.filter(backend => backend.enabled !== false).length === 0) {
          ctx.ui.notify('Add at least one enabled backing provider model first.', 'error')
          continue
        }
        await store.saveVirtualProvider(draft)
        await reconcile(ctx)
        return true
      }
      if (row.startsWith('Model id: ')) {
        const next = await ctx.ui.input('Virtual model id (shown in /model):', model.id)
        if (next !== undefined && next.trim() !== '') {
          const id = next.trim()
          if (!VIRTUAL_ID_PATTERN.test(id)) {
            ctx.ui.notify('Use letters, numbers, dots, dashes, or underscores.', 'error')
          } else {
            model.id = id
          }
        }
        continue
      }
      if (row === 'Add backing provider model') {
        const candidates = uniqueProviders(ctx, baseProviders)
          .filter(provider => !virtualProviders.has(provider.id) && provider.getModels().length > 0)
        if (candidates.length === 0) {
          ctx.ui.notify('No registered providers expose models yet.', 'warning')
          continue
        }
        const providerId = await searchableSelect(ctx, 'Backing provider:', candidates.map(candidate => ({
          value: candidate.id,
          label: `${candidate.name} (${candidate.id})`,
        })))
        const chosen = candidates.find(candidate => candidate.id === providerId)
        if (chosen === undefined) continue
        const catalog = chosen.getModels()
        const modelId = await searchableSelect(ctx, `Backing model for ${chosen.name}:`, catalog.map(candidate => ({
          value: candidate.id,
          label: `${candidate.id} · ${candidate.name}`,
          searchText: `${candidate.id} ${candidate.name}`,
        })))
        const backingModel = catalog.find(candidate => candidate.id === modelId)
        if (backingModel === undefined) continue
        if (model.backends.some(backend =>
          backend.providerId === chosen.id && backend.modelId === backingModel.id)) {
          ctx.ui.notify('That provider model is already a backend.', 'warning')
          continue
        }
        model.backends.push({ providerId: chosen.id, modelId: backingModel.id, weight: 1 })
        continue
      }
      const backendMatch = /^(\d+)\. /.exec(row)
      if (backendMatch === null) continue
      const backendNumber = Number(backendMatch[1]!)
      const backend = model.backends[backendNumber - 1]
      if (backend === undefined) continue
      const actions = [backend.enabled === false ? 'Enable' : 'Disable', 'Set weight', 'Remove']
      const actionIndex = actions.indexOf(await ctx.ui.select(`${backend.providerId} · ${backend.modelId}:`, actions) ?? '')
      if (actionIndex < 0) continue
      if (actionIndex === 0) {
        backend.enabled = backend.enabled === false
      } else if (actionIndex === 1) {
        const next = await ctx.ui.input('Weight (1 = equal share):', String(backend.weight ?? 1))
        if (next === undefined) continue
        const parsed = Number(next)
        if (Number.isInteger(parsed) && parsed >= 1) backend.weight = parsed
        else ctx.ui.notify('Weight must be an integer ≥ 1.', 'error')
      } else {
        model.backends.splice(backendNumber - 1, 1)
      }
    }
  }

  const unsubscribeRegistration = pi.events.on(MULTIPROVIDER_REGISTER_EVENT, value => {
    if (!isIntegration(value)) return
    const existing = externalIntegrations.get(value.id)
    if (existing === value) return
    externalIntegrations.set(value.id, value)
    if (currentContext !== undefined) void install(value.id, currentContext)
  })

  pi.on('session_start', async (_event, ctx) => {
    currentContext = ctx
    await reconcile(ctx)
    announceService()
  })

  pi.on('before_agent_start', async (_event, ctx) => {
    currentContext = ctx
    await reconcile(ctx)
  })

  pi.on('session_shutdown', () => {
    unsubscribeRegistration()
    for (const providerId of installedProviders.keys()) restoreProvider(providerId, currentContext)
    managedIntegrations.clear()
    managedBases.clear()
    for (const providerId of virtualProviders.keys()) pi.unregisterProvider(providerId)
    virtualProviders.clear()
    virtualIntegrations.clear()
    virtualConfigs.clear()
    currentContext = undefined
  })

  pi.registerCommand('multilogin', {
    description: 'Manage a provider pool, Pi default auth, schedulers, and accounts',
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify('/multilogin requires Pi interactive mode.', 'warning')
        return
      }
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

      let result = await openPoolManager(ctx, provider, callbacks, methods)
      while (result.type === 'add') {
        const method = result.method
        const existing = await store.getPool(provider.id)
        const defaultLabel = `${provider.name} ${(existing?.accounts.length ?? 0) + 1}`
        const labelInput = await ctx.ui.input('Account label:', defaultLabel)
        if (labelInput !== undefined) {
          const label = labelInput.trim() || defaultLabel
          const login = method === 'api_key_paste'
            ? await promptApiKeyCredential(ctx, provider)
            : await showLoginDialog(ctx, { provider, authType: method as AuthType })
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
      await ctx.ui.select('Provider Accounts', statusLines(snapshot))
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
      const ref = args.trim().toLowerCase()
      if (ref !== '') {
        const existing = stored.find(candidate => candidate.id.toLowerCase() === ref)
        if (existing !== undefined) {
          const draft = structuredClone(existing)
          if (await editVirtualProvider(ctx, draft)) {
            ctx.ui.notify(`Saved virtual provider "${draft.id}". Select "${draft.models[0]!.id}" on provider "${draft.id}" in /model.`, 'info')
          }
          return
        }
      }

      const rows = [
        'Create new virtual provider',
        ...stored.map(candidate => `Edit ${candidate.id}`),
        ...stored.map(candidate => `Delete ${candidate.id}`),
      ]
      const selected = await ctx.ui.select('Virtual providers:', rows)
      const index = rows.indexOf(selected ?? '')
      if (index < 0) return
      const row = rows[index]!

      if (row === 'Create new virtual provider') {
        const idInput = await ctx.ui.input('Virtual provider id:', 'pooled')
        if (idInput === undefined) return
        const id = idInput.trim()
        if (!VIRTUAL_ID_PATTERN.test(id) || virtualProviders.has(id)
          || ctx.modelRegistry.getProvider(id) !== undefined) {
          ctx.ui.notify('Provider id is invalid or already registered.', 'error')
          return
        }
        const modelIdInput = await ctx.ui.input('Virtual model id (shown in /model):', id)
        if (modelIdInput === undefined) return
        const modelId = modelIdInput.trim()
        if (!VIRTUAL_ID_PATTERN.test(modelId)) {
          ctx.ui.notify('Use letters, numbers, dots, dashes, or underscores for the model id.', 'error')
          return
        }
        const draft: VirtualProviderConfig = {
          id,
          label: id,
          models: [{ id: modelId, backends: [] }],
        }
        ctx.ui.notify('Add at least one backing provider model, then choose "Save and apply".', 'info')
        if (await editVirtualProvider(ctx, draft)) {
          ctx.ui.notify(`Created virtual provider "${id}". Select "${draft.models[0]!.id}" on provider "${id}" in /model.`, 'info')
        }
        return
      }

      const target = stored.find(candidate => row === `Edit ${candidate.id}` || row === `Delete ${candidate.id}`)
      if (target === undefined) return
      if (row.startsWith('Edit ')) {
        const draft = structuredClone(target)
        if (await editVirtualProvider(ctx, draft)) {
          ctx.ui.notify(`Saved virtual provider "${draft.id}". Select "${draft.models[0]!.id}" on provider "${draft.id}" in /model.`, 'info')
        }
        return
      }
      if (row.startsWith('Delete ')) {
        const confirmed = await ctx.ui.confirm(
          'Remove virtual provider?',
          `Remove ${target.id}? Backing providers and their pooled accounts are untouched.`,
        )
        if (!confirmed) return
        await store.removeVirtualProvider(target.id)
        await reconcile(ctx)
        ctx.ui.notify(`Removed virtual provider "${target.id}".`, 'info')
      }
    },
  })
}
