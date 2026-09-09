import type { Api, AuthType, Credential, Provider } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
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
  type PublicAccountSnapshot,
  type SchedulerSettingsPatch,
  type SelectionPolicy,
} from '../src/index.ts'
import { promptApiKeyCredential, probeSessionRuntime, selectLogin, showLoginDialog } from '../src/multilogin.ts'
import {
  openPoolManager,
  type PoolManagerAuthMethod,
  type PoolManagerCallbacks,
} from './pool-manager.ts'

type AnyIntegration = MultiProviderIntegration<Api, unknown>

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
    lines.push(`${provider.label} (${provider.id}) · ${provider.policy} · affinity ${provider.affinity ? 'on' : 'off'}`)
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

export default function multiprovider(pi: ExtensionAPI): void {
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
    integration: AnyIntegration,
    ctx: MultiProviderServiceContext,
    model: ExtensionContext['model'],
    providerId: string,
  ): string => {
    const fallback = ctx.sessionManager.getSessionId()
    if (integration.affinityKey === undefined || model === undefined) return fallback
    const provider = baseProviders.get(providerId)
      ?? ctx.modelRegistry.getProvider(providerId) as Provider<Api> | undefined
    if (provider === undefined) return fallback
    try {
      return integration.affinityKey({ provider, model, context: { messages: [] } }) ?? fallback
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

  const reconcile = async (ctx: ExtensionContext): Promise<void> => {
    service.updateSchedulerDefaults(await store.getSchedulerSettings())
    await refreshManaged(ctx)
    const ids = new Set([
      ...externalIntegrations.keys(),
      ...managedIntegrations.keys(),
      ...installedProviders.keys(),
    ])
    for (const providerId of ids) await install(providerId, ctx)
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
      const providerName = ctx.modelRegistry.getProvider(providerId)?.name ?? providerId
      const integration = effectiveIntegration(providerId)
      const pool = integration === undefined
        ? undefined
        : (await service.snapshot()).providers.find(candidate => candidate.id === providerId)
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
      const pin = service.getAffinity(providerId, affinityKey)
      const currentId = pin !== undefined && (pool.affinity || pin.explicit)
        ? pin.accountId
        : undefined

      // Sibling extensions following the active account (usage widgets and the
      // like) re-resolve their account-scoped state from this notification.
      const announceSwitch = async (): Promise<void> => {
        const account = await announcement.getActiveAccount(providerId, ctx)
        announcement.notifyActiveAccountChanged(providerId, ctx, account)
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
        service.clearAffinity(providerId, affinityKey)
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
        await service.pinAccount(providerId, affinityKey, account.id)
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
}
