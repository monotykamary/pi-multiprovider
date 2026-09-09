import type { Api, AuthType, Context, Credential, Model, Provider } from '@earendil-works/pi-ai'
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent'
import {
  Container,
  Input,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
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

interface SettingsListInternals {
  readonly searchEnabled: boolean
  readonly searchInput: { render(width: number): string[] } | undefined
  readonly theme: SettingsListTheme
  readonly selectedIndex: number
  getDisplayItems(): SettingItem[]
  getVisibleRange(displayItems: SettingItem[]): { startIndex: number; endIndex: number }
  addHintLine(lines: string[], width: number): void
}

// SettingsList caps the label column at 36 characters, so rows misalign once
// a label runs longer; this variant sizes the value column to the longest
// label actually displayed instead.
class DynamicColumnSettingsList extends SettingsList {
  override render(width: number): string[] {
    const internal = this as unknown as SettingsListInternals
    const lines: string[] = []
    if (internal.searchEnabled && internal.searchInput) {
      lines.push(...internal.searchInput.render(width))
      lines.push('')
    }
    const displayItems = internal.getDisplayItems()
    if (displayItems.length === 0) {
      lines.push(truncateToWidth(internal.theme.hint('  No matching models'), width))
      internal.addHintLine(lines, width)
      return lines
    }
    const maxLabelWidth = Math.max(...displayItems.map(item => visibleWidth(item.label)))
    const { startIndex, endIndex } = internal.getVisibleRange(displayItems)
    for (let index = startIndex; index < endIndex; index++) {
      const item = displayItems[index]!
      const selected = index === internal.selectedIndex
      const prefix = selected ? internal.theme.cursor : '  '
      const labelPadded = item.label + ' '.repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)))
      const separator = '  '
      const valueMaxWidth = Math.max(0, width - visibleWidth(prefix) - maxLabelWidth - separator.length - 2)
      const valueText = internal.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ''), selected)
      lines.push(truncateToWidth(prefix + internal.theme.label(labelPadded, selected) + separator + valueText, width))
    }
    if (startIndex > 0 || endIndex < displayItems.length) {
      lines.push(internal.theme.hint(truncateToWidth(`  (${internal.selectedIndex + 1}/${displayItems.length})`, width - 2, '')))
    }
    internal.addHintLine(lines, width)
    return lines
  }
}

type VirtualEditorOutcome =
  | { kind: 'dismissed' }
  | { kind: 'saved'; draft: VirtualProviderConfig }
  | { kind: 'discarded' }
  | { kind: 'removed'; id: string }

type EditorPage =
  | { kind: 'root' }
  | { kind: 'menu' }
  | { kind: 'provider-picker' }
  | { kind: 'model-picker' }
  | { kind: 'backend' }
  | { kind: 'input'; purpose: 'provider-id' | 'model-id' | 'weight' }

// Single-host editor for the /vprovider flow, styled after the /model and
// hide-providers selectors: every page (root menu, create inputs, editor
// menu, pickers, backend actions) swaps inside one bordered dialog the way
// /fabric settings does, so moving between pages never tears down to the
// chat view.
class VirtualProviderEditorDialog extends Container {
  private readonly theme: Theme
  private readonly stored: VirtualProviderConfig[]
  private readonly candidates: Provider<Api>[]
  private readonly isProviderIdAvailable: (id: string) => boolean
  private readonly done: (outcome: VirtualEditorOutcome) => void
  private readonly pageContainer = new Container()
  private readonly listTheme: SettingsListTheme
  private draft: VirtualProviderConfig | undefined
  private page: EditorPage
  private inputBackPage: EditorPage = { kind: 'root' }
  private createProviderId: string | undefined
  private chosenProvider: Provider<Api> | undefined
  private activeBackendIndex = 0
  private inputInitial = ''
  private pageError = ''
  private activeList: SettingsList | undefined
  private activeInput: Input | undefined

  constructor(options: {
    theme: Theme
    stored: VirtualProviderConfig[]
    candidates: Provider<Api>[]
    isProviderIdAvailable: (id: string) => boolean
    startDraft: VirtualProviderConfig | undefined
    done: (outcome: VirtualEditorOutcome) => void
  }) {
    super()
    this.theme = options.theme
    this.stored = options.stored
    this.candidates = options.candidates
    this.isProviderIdAvailable = options.isProviderIdAvailable
    this.done = options.done
    this.draft = options.startDraft
    this.page = options.startDraft === undefined ? { kind: 'root' } : { kind: 'menu' }
    this.listTheme = {
      label: (text, selected) => (selected ? this.theme.fg('accent', text) : text),
      value: text => this.theme.fg('muted', text),
      description: text => this.theme.fg('muted', text),
      cursor: this.theme.fg('accent', '→ '),
      hint: text => this.theme.fg('muted', text),
    }
    this.addChild(new DynamicBorder(s => this.theme.fg('border', s)))
    this.addChild(this.pageContainer)
    this.addChild(new DynamicBorder(s => this.theme.fg('border', s)))
    this.enterPage()
  }

  handleInput(data: string): void {
    if (this.activeInput !== undefined) this.activeInput.handleInput(data)
    else this.activeList?.handleInput(data)
  }

  private goTo(page: EditorPage): void {
    this.page = page
    this.pageError = ''
    this.enterPage()
  }

  private enterPage(): void {
    this.activeList = undefined
    this.activeInput = undefined
    this.pageContainer.clear()
    if (this.page.kind === 'root') this.buildRoot()
    else if (this.page.kind === 'menu') this.buildMenu()
    else if (this.page.kind === 'provider-picker') this.buildProviderPicker()
    else if (this.page.kind === 'model-picker') this.buildModelPicker()
    else if (this.page.kind === 'backend') this.buildBackendActions()
    else this.buildInput()
  }

  // Matches the /model and hide-providers selectors: blank line after the
  // border, flush-left accent title, muted description, then the list.
  private addHeading(title: string, description: string): void {
    this.pageContainer.addChild(new Text(this.theme.fg('accent', this.theme.bold(title)), 0, 0))
    this.pageContainer.addChild(new Text(this.theme.fg('muted', description), 0, 0))
    this.pageContainer.addChild(new Spacer(1))
    if (this.pageError !== '') {
      this.pageContainer.addChild(new Text(this.theme.fg('warning', this.pageError), 0, 0))
      this.pageContainer.addChild(new Spacer(1))
    }
  }

  private attachList(
    title: string,
    description: string,
    items: SettingItem[],
    onSelect: (id: string) => void,
    onCancel: () => void,
  ): void {
    this.addHeading(title, description)
    this.activeList = new DynamicColumnSettingsList(
      items,
      10,
      this.listTheme,
      id => onSelect(id),
      onCancel,
      { enableSearch: true },
    )
    this.pageContainer.addChild(this.activeList)
  }

  private menuItem(id: string, label: string): SettingItem {
    return { id, label, currentValue: '', values: [id] }
  }

  private separatorItem(id: string): SettingItem {
    return { id, label: '', currentValue: '' }
  }

  private buildRoot(): void {
    const items: SettingItem[] = [
      this.menuItem('create', 'Create new virtual provider'),
      ...this.stored.map(config => this.menuItem(`edit-${config.id}`, `Edit ${config.id}`)),
      ...this.stored.map(config => this.menuItem(`delete-${config.id}`, `Delete ${config.id}`)),
    ]
    this.attachList(
      'Virtual providers',
      'Create, edit, or remove virtual providers that map one model across provider models.',
      items,
      id => {
        if (id === 'create') {
          this.createProviderId = undefined
          this.inputBackPage = { kind: 'root' }
          this.inputInitial = 'pooled'
          this.goTo({ kind: 'input', purpose: 'provider-id' })
        } else if (id.startsWith('edit-')) {
          const target = this.stored.find(candidate => candidate.id === id.slice(5))
          if (target === undefined) return
          this.draft = structuredClone(target)
          this.goTo({ kind: 'menu' })
        } else if (id.startsWith('delete-')) {
          this.done({ kind: 'removed', id: id.slice(7) })
        }
      },
      () => this.done({ kind: 'dismissed' }),
    )
  }

  private buildMenu(): void {
    const model = this.draft!.models[0]!
    const items: SettingItem[] = [
      this.menuItem('model-id', `Model id: ${model.id}`),
      this.menuItem('add', 'Add backing provider model'),
      this.separatorItem('sep-top'),
      ...model.backends.map((backend, index) => this.menuItem(
        `backend-${index}`,
        `${index + 1}. ${backend.providerId} · ${backend.modelId}`
          + ` · ${backend.enabled === false ? 'disabled' : 'enabled'} · w${backend.weight ?? 1}`,
      )),
      this.separatorItem('sep-bottom'),
      this.menuItem('save', 'Save and apply'),
      this.menuItem('discard', 'Discard changes'),
    ]
    this.attachList(
      `Virtual provider "${this.draft!.id}"`,
      'Enter selects · Esc discards changes.',
      items,
      id => {
        if (id === 'model-id') {
          this.inputBackPage = { kind: 'menu' }
          this.inputInitial = model.id
          this.goTo({ kind: 'input', purpose: 'model-id' })
        } else if (id === 'add') {
          this.goTo({ kind: 'provider-picker' })
        } else if (id === 'save') {
          if (model.backends.filter(backend => backend.enabled !== false).length === 0) {
            this.pageError = 'Add at least one enabled backing provider model before saving.'
            this.enterPage()
            return
          }
          this.done({ kind: 'saved', draft: this.draft! })
        } else if (id === 'discard') {
          this.done({ kind: 'discarded' })
        } else if (id.startsWith('backend-')) {
          this.activeBackendIndex = Number(id.slice(8))
          this.goTo({ kind: 'backend' })
        }
      },
      () => this.done({ kind: 'discarded' }),
    )
  }

  private buildProviderPicker(): void {
    const items: SettingItem[] = this.candidates.map(provider => ({
      id: provider.id,
      label: `${provider.name} (${provider.id})`,
      currentValue: '',
      values: [provider.id],
    }))
    this.attachList(
      'Backing provider',
      'Type to search · Enter picks the provider · Esc goes back.',
      items,
      id => {
        const chosen = this.candidates.find(candidate => candidate.id === id)
        if (chosen === undefined) return
        this.chosenProvider = chosen
        this.goTo({ kind: 'model-picker' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  private buildModelPicker(): void {
    const catalog = this.chosenProvider!.getModels()
    const items: SettingItem[] = catalog.map(candidate => ({
      id: candidate.id,
      label: candidate.id,
      currentValue: candidate.name,
      values: [candidate.id],
    }))
    this.attachList(
      `Backing model for ${this.chosenProvider!.name}`,
      'Type to search · Enter picks the model · Esc goes back.',
      items,
      id => {
        const chosen = catalog.find(candidate => candidate.id === id)
        const providerId = this.chosenProvider?.id
        if (chosen === undefined || providerId === undefined) return
        const model = this.draft!.models[0]!
        if (model.backends.some(backend =>
          backend.providerId === providerId && backend.modelId === chosen.id)) {
          this.pageError = 'That provider model is already a backend.'
          this.enterPage()
          return
        }
        model.backends.push({ providerId, modelId: chosen.id, weight: 1 })
        this.goTo({ kind: 'menu' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  private buildBackendActions(): void {
    const backend = this.draft!.models[0]!.backends[this.activeBackendIndex]!
    const items: SettingItem[] = [
      this.menuItem('toggle', backend.enabled === false ? 'Enable' : 'Disable'),
      this.menuItem('weight', 'Set weight'),
      this.menuItem('remove', 'Remove'),
    ]
    this.attachList(
      `${backend.providerId} · ${backend.modelId}`,
      'Enter selects · Esc goes back.',
      items,
      id => {
        if (id === 'toggle') {
          backend.enabled = backend.enabled === false
        } else if (id === 'weight') {
          this.inputBackPage = { kind: 'menu' }
          this.inputInitial = String(backend.weight ?? 1)
          this.goTo({ kind: 'input', purpose: 'weight' })
        } else if (id === 'remove') {
          this.draft!.models[0]!.backends.splice(this.activeBackendIndex, 1)
        } else return
        this.goTo({ kind: 'menu' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  private buildInput(): void {
    const purpose = this.page.kind === 'input' ? this.page.purpose : 'model-id'
    const title = purpose === 'provider-id'
      ? 'Virtual provider id'
      : purpose === 'model-id' ? 'Virtual model id (shown in /model)' : 'Set weight'
    this.addHeading(title, 'Enter confirms · Esc goes back.')
    const input = new Input()
    input.setValue(this.inputInitial)
    input.onSubmit = () => this.applyInput(purpose, input.getValue())
    input.onEscape = () => this.goTo(this.inputBackPage)
    this.activeInput = input
    this.pageContainer.addChild(input)
  }

  private applyInput(purpose: 'provider-id' | 'model-id' | 'weight', raw: string): void {
    const value = raw.trim()
    if (purpose === 'provider-id') {
      if (!VIRTUAL_ID_PATTERN.test(value) || !this.isProviderIdAvailable(value)) {
        this.pageError = 'Provider id is invalid or already registered.'
        this.inputInitial = value
        this.enterPage()
        return
      }
      this.createProviderId = value
      this.inputInitial = value
      this.goTo({ kind: 'input', purpose: 'model-id' })
      return
    }
    if (purpose === 'model-id') {
      if (!VIRTUAL_ID_PATTERN.test(value)) {
        this.pageError = 'Use letters, numbers, dots, dashes, or underscores for the model id.'
        this.inputInitial = value
        this.enterPage()
        return
      }
      if (this.draft === undefined) {
        this.draft = {
          id: this.createProviderId!,
          label: this.createProviderId!,
          models: [{ id: value, backends: [] }],
        }
        this.pageError = 'Add at least one enabled backing provider model, then choose "Save and apply".'
      } else {
        this.draft.models[0]!.id = value
      }
      this.goTo({ kind: 'menu' })
      return
    }
    const parsed = Number(value)
    const backend = this.draft!.models[0]!.backends[this.activeBackendIndex]
    if (!Number.isInteger(parsed) || parsed < 1 || backend === undefined) {
      this.pageError = 'Weight must be an integer ≥ 1.'
      this.inputInitial = value
      this.enterPage()
      return
    }
    backend.weight = parsed
    this.goTo({ kind: 'menu' })
  }
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
      const candidates = uniqueProviders(ctx, baseProviders)
        .filter(provider => !virtualProviders.has(provider.id) && provider.getModels().length > 0)
      const ref = args.trim().toLowerCase()
      const existing = ref === '' ? undefined : stored.find(candidate => candidate.id.toLowerCase() === ref)
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
