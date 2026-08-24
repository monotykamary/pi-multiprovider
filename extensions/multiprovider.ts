import type { Api, Credential, Provider } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
  createManagedIntegration,
  getMultiAuthPath,
  liftProvider,
  MULTIPROVIDER_REGISTER_EVENT,
  MultiAuthStore,
  MultiProviderService,
  type MultiProviderIntegration,
  type SelectionPolicy,
} from '../src/index.ts'
import { selectLogin, showLoginDialog } from '../src/multilogin.ts'

type AnyIntegration = MultiProviderIntegration<Api, unknown>

const strategyLabels: ReadonlyArray<{ label: string; value: SelectionPolicy }> = [
  { label: 'Round robin · rotate evenly', value: 'round-robin' },
  { label: 'Weighted round robin · distribute by account weight', value: 'weighted-round-robin' },
  { label: 'Least in flight · favor free capacity', value: 'least-inflight' },
  { label: 'Priority failover · use the first healthy account', value: 'priority' },
]

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
        `  ${account.label} (${account.authKind}) · ${account.status} · ${account.inFlight} in flight · ${account.consecutiveFailures} failures${cooldown}`,
      )
    }
  }
  return lines
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

async function chooseStrategy(
  ctx: ExtensionContext,
  current: SelectionPolicy | undefined,
): Promise<SelectionPolicy | undefined> {
  const ordered = current === undefined
    ? strategyLabels
    : [
        ...strategyLabels.filter(option => option.value === current),
        ...strategyLabels.filter(option => option.value !== current),
      ]
  const selected = await ctx.ui.select('Pool strategy:', ordered.map(option => option.label))
  return ordered.find(option => option.label === selected)?.value
}

async function chooseBoolean(
  ctx: ExtensionContext,
  title: string,
  enabledLabel: string,
  disabledLabel: string,
  current: boolean,
): Promise<boolean | undefined> {
  const options = current ? [enabledLabel, disabledLabel] : [disabledLabel, enabledLabel]
  const selected = await ctx.ui.select(title, options)
  if (selected === undefined) return undefined
  return selected === enabledLabel
}

async function positiveInteger(
  ctx: ExtensionContext,
  title: string,
  fallback: number,
): Promise<number | undefined> {
  const value = await ctx.ui.input(title, String(fallback))
  if (value === undefined) return undefined
  const parsed = Number(value.trim() === '' ? fallback : value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    ctx.ui.notify(`${title} must be a positive integer.`, 'error')
    return undefined
  }
  return parsed
}

async function integer(
  ctx: ExtensionContext,
  title: string,
  fallback: number,
): Promise<number | undefined> {
  const value = await ctx.ui.input(title, String(fallback))
  if (value === undefined) return undefined
  const parsed = Number(value.trim() === '' ? fallback : value)
  if (!Number.isInteger(parsed)) {
    ctx.ui.notify(`${title} must be an integer.`, 'error')
    return undefined
  }
  return parsed
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
    description: 'Add an API-key or OAuth account to a provider pool',
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify('/multilogin requires Pi interactive mode.', 'warning')
        return
      }
      await reconcile(ctx)
      const providers = uniqueProviders(ctx, baseProviders)
      const pools = await Promise.all(providers.map(provider => store.getPool(provider.id)))
      const counts = new Map(
        pools.filter(pool => pool !== undefined).map(pool => [pool.providerId, pool.accounts.length]),
      )
      const selection = await selectLogin(ctx, providers, counts, args.trim() || undefined)
      if (selection === undefined) return

      const currentPool = await store.getPool(selection.provider.id)
      const defaultLabel = `${selection.provider.name} ${currentPool?.accounts.length === undefined ? 1 : currentPool.accounts.length + 1}`
      const labelInput = await ctx.ui.input('Account label:', defaultLabel)
      if (labelInput === undefined) return
      const label = labelInput.trim() || defaultLabel
      const policy = await chooseStrategy(ctx, currentPool?.policy)
      if (policy === undefined) return
      const affinity = await chooseBoolean(
        ctx,
        'Session affinity:',
        'On · keep a healthy account for this session',
        'Off · select for every request',
        currentPool?.affinity ?? true,
      )
      if (affinity === undefined) return
      const includeUpstream = await chooseBoolean(
        ctx,
        'Include Pi default auth in this pool?',
        'Yes · merge /login, auth.json, environment, and ambient auth',
        'No · use only multilogin accounts',
        currentPool?.includeUpstream ?? true,
      )
      if (includeUpstream === undefined) return
      const weight = policy === 'weighted-round-robin'
        ? await positiveInteger(ctx, 'Account weight:', 1)
        : 1
      if (weight === undefined) return
      const priority = policy === 'priority'
        ? await integer(ctx, 'Account priority (lower runs first):', (currentPool?.accounts.length ?? 0) + 1)
        : (currentPool?.accounts.length ?? 0) + 1
      if (priority === undefined) return

      const login = await showLoginDialog(ctx, selection)
      if (login === undefined) return
      if ('error' in login) {
        ctx.ui.notify(`Failed to authenticate ${selection.provider.name}: ${login.error.message}`, 'error')
        return
      }

      let credential: Credential | undefined = login.credential
      try {
        await store.addAccount(selection.provider.id, {
          label,
          credential,
          weight,
          priority,
          pool: { policy, affinity, includeUpstream },
        })
        credential = undefined
        await reconcile(ctx)
        ctx.ui.notify(
          `Added ${label.trim()} to ${selection.provider.name}. Credentials saved to ${getMultiAuthPath()}`,
          'info',
        )
      } catch (error) {
        credential = undefined
        ctx.ui.notify(`Could not save account: ${errorText(error)}`, 'error')
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
}
