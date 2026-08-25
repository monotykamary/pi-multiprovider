// Pool manager view for /multilogin, built on the pi-fabric settings pattern:
// a searchable SettingsList root whose rows cycle inline (strategy, toggles)
// or drill into section submenus (upstream auth, each account, scheduler).
import type { Api, AuthType, Provider } from '@earendil-works/pi-ai'
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { Container, SettingsList, type SettingItem, Spacer, Text } from '@earendil-works/pi-tui'
import {
  type MultiAuthAccount,
  type MultiAuthAccountSettings,
  type MultiAuthPoolSettings,
  type MultiAuthUpstreamPreferences,
  SCHEDULER_DEFAULTS,
  SCHEDULER_SETTING_KEYS,
  type SchedulerSettings,
  type SelectionPolicy,
} from '../src/index.ts'
import {
  BOOLEANS,
  DynamicBorder,
  formatMs,
  integerInputSubmenu,
  markDrillIn,
  sectionSubmenu,
  SelectSubmenu,
  setting,
  settingsListTheme,
  stringInputSubmenu,
} from './settings-ui.ts'

export const UPSTREAM_DEFAULT_LABEL = 'Pi default'

export type SchedulerSettingKey = keyof SchedulerSettings

export interface PoolManagerState {
  poolExists: boolean
  policy: SelectionPolicy
  affinity: boolean
  includeUpstream: boolean
  upstream: MultiAuthUpstreamPreferences
  accounts: MultiAuthAccount[]
  scheduler: SchedulerSettings
}

export interface PoolManagerCallbacks {
  loadState(): Promise<PoolManagerState>
  updatePool(settings: MultiAuthPoolSettings): Promise<void>
  updateAccount(accountId: string, settings: MultiAuthAccountSettings): Promise<void>
  removeAccount(accountId: string): Promise<void>
  updateScheduler(key: SchedulerSettingKey, valueMs: number | undefined): Promise<void>
}

export interface PoolManagerAuthMethod {
  label: string
  value: AuthType
}

export type PoolManagerResult = { type: 'closed' } | { type: 'add'; authType: AuthType }

const POLICIES: readonly SelectionPolicy[] = [
  'round-robin',
  'weighted-round-robin',
  'least-inflight',
  'priority',
]

const REMOVE_SENTINEL = '__remove__'
const ADD_SENTINEL_PREFIX = '__add__:'

const RATE_LIMIT_OPTIONS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000]
const QUOTA_OPTIONS = [300_000, 900_000, 1_800_000, 3_600_000, 7_200_000]
const AUTH_OPTIONS = [60_000, 300_000, 900_000, 1_800_000]
const TRANSIENT_OPTIONS = [100, 250, 500, 1_000, 2_000, 5_000, 15_000]
const MAX_COOLDOWN_OPTIONS = [300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000]

function upstreamLabel(state: PoolManagerState): string {
  const label = state.upstream.label?.trim()
  return label === undefined || label === '' ? UPSTREAM_DEFAULT_LABEL : label
}

function upstreamSummary(state: PoolManagerState): string {
  if (!state.includeUpstream) return 'not pooled'
  return `pooled · weight ${state.upstream.weight ?? 1} · priority ${state.upstream.priority ?? 0}`
}

function accountSummary(account: MultiAuthAccount): string {
  if (!account.enabled) return 'disabled'
  return `weight ${account.weight} · priority ${account.priority}`
}

function schedulerSummary(scheduler: SchedulerSettings): string {
  const rateLimit = scheduler.rateLimitCooldownMs ?? SCHEDULER_DEFAULTS.rateLimitCooldownMs
  const quota = scheduler.quotaCooldownMs ?? SCHEDULER_DEFAULTS.quotaCooldownMs
  const auth = scheduler.authCooldownMs ?? SCHEDULER_DEFAULTS.authCooldownMs
  return `${formatMs(rateLimit)} rate-limit · ${formatMs(quota)} quota · ${formatMs(auth)} auth`
}

function mergeUpstream(
  current: MultiAuthUpstreamPreferences,
  field: 'label' | 'weight' | 'priority',
  value: string,
): MultiAuthUpstreamPreferences {
  const next: MultiAuthUpstreamPreferences = { ...current }
  if (field === 'label') {
    delete next.label
    const label = value.trim()
    if (label !== '' && label !== UPSTREAM_DEFAULT_LABEL) next.label = label
  } else if (field === 'weight') {
    delete next.weight
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed >= 1) next.weight = parsed
  } else {
    delete next.priority
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed >= 0) next.priority = parsed
  }
  return next
}

function cooldownRow(
  theme: Theme,
  state: PoolManagerState,
  key: SchedulerSettingKey,
  label: string,
  description: string,
  options: readonly number[],
): SettingItem {
  const configured = state.scheduler[key]
  const fallback = SCHEDULER_DEFAULTS[key]
  const currentValue = configured === undefined
    ? `${formatMs(fallback)} · default`
    : formatMs(configured)
  return setting(`scheduler.${key}`, label, currentValue, {
    description,
    submenu: (_currentValue, done) => {
      const items = [
        { value: 'default', label: `Default (${formatMs(fallback)})` },
        ...options.map((ms) => ({ value: String(ms), label: formatMs(ms) })),
      ]
      let selectedValue = configured === undefined ? 'default' : String(configured)
      if (!items.some((option) => option.value === selectedValue)) {
        items.push({ value: selectedValue, label: formatMs(configured ?? fallback) })
        selectedValue = String(configured ?? fallback)
      }
      return new SelectSubmenu(theme, label, description, items, selectedValue, (value) => done(value), () => done())
    },
  })
}

interface PoolManagerView {
  title: string
  subtitle: string
  items: SettingItem[]
}

function buildView(
  theme: Theme,
  provider: Provider<Api>,
  state: PoolManagerState,
  methods: readonly PoolManagerAuthMethod[],
  persist: (id: string, value: string) => void,
): PoolManagerView {
  const label = upstreamLabel(state)
  const items: SettingItem[] = [
    setting('pool.policy', 'Strategy', state.policy, {
      description: 'How the pool picks the next account for each request.',
      values: POLICIES,
    }),
    setting('pool.affinity', 'Session affinity', state.affinity ? 'true' : 'false', {
      description: 'Keep a healthy account pinned to this session instead of re-selecting on every request.',
      values: BOOLEANS,
    }),
    setting('upstream', `${label} (upstream)`, upstreamSummary(state), {
      description: "Pi's normal /login, auth.json, environment, or ambient credential, participating in the pool like a stored account.",
      submenu: sectionSubmenu(
        theme,
        `${label} (upstream auth)`,
        "Pi's own credential resolves live on every request; these settings tune how the pool schedules it.",
        [
          setting('upstream.enabled', 'Include in pool', state.includeUpstream ? 'true' : 'false', {
            description: 'Treat /login, auth.json, environment, and ambient auth as a pool account. Off makes this pool multilogin-only.',
            values: BOOLEANS,
          }),
          setting('upstream.label', 'Label', label, {
            description: `Shown in /accounts and selectors. Empty restores "${UPSTREAM_DEFAULT_LABEL}".`,
            submenu: stringInputSubmenu(theme, 'Upstream label', `Empty restores "${UPSTREAM_DEFAULT_LABEL}".`),
          }),
          setting('upstream.weight', 'Weight', String(state.upstream.weight ?? 1), {
            description: 'Relative share under the weighted round robin strategy.',
            submenu: integerInputSubmenu(theme, 'Upstream weight', 'Relative share under weighted round robin (1 or more).', 1),
          }),
          setting('upstream.priority', 'Priority', String(state.upstream.priority ?? 0), {
            description: 'Lower runs first under the priority failover strategy.',
            submenu: integerInputSubmenu(theme, 'Upstream priority', 'Lower runs first under the priority strategy (0 or more).', 0),
          }),
        ],
        persist,
      ),
    }),
    ...state.accounts.map((account) =>
      setting(`account.${account.id}`, account.label, accountSummary(account), {
        description: `${account.authKind} credential stored in multiprovider-auth.json.`,
        submenu: sectionSubmenu(
          theme,
          account.label,
          'Stored multilogin account. Values apply to the next selection.',
          [
            setting(`account.${account.id}.label`, 'Label', account.label, {
              description: 'Non-secret display label for this credential.',
              submenu: stringInputSubmenu(theme, 'Account label', 'Non-secret display label for this credential.'),
            }),
            setting(`account.${account.id}.enabled`, 'Enabled', account.enabled ? 'true' : 'false', {
              description: 'Disabled accounts are skipped by selection and failover.',
              values: BOOLEANS,
            }),
            setting(`account.${account.id}.weight`, 'Weight', String(account.weight), {
              description: 'Relative share under the weighted round robin strategy.',
              submenu: integerInputSubmenu(theme, 'Account weight', 'Relative share under weighted round robin (1 or more).', 1),
            }),
            setting(`account.${account.id}.priority`, 'Priority', String(account.priority), {
              description: 'Lower runs first under the priority failover strategy.',
              submenu: integerInputSubmenu(theme, 'Account priority', 'Lower runs first under the priority strategy (0 or more).', 0),
            }),
            setting(`account.${account.id}.remove`, 'Remove account', '', {
              description: 'Permanently deletes this stored credential.',
              submenu: (_currentValue, done) =>
                new SelectSubmenu(
                  theme,
                  `Remove ${account.label}?`,
                  "The stored credential is deleted; Pi's normal /login credential is unchanged.",
                  [
                    { value: 'keep', label: 'Cancel' },
                    { value: 'remove', label: `Remove ${account.label}` },
                  ],
                  'keep',
                  (value) => (value === 'remove' ? done(REMOVE_SENTINEL) : done()),
                  () => done(),
                ),
            }),
          ],
          persist,
        ),
      }),
    ),
    ...(methods.length === 0
      ? []
      : [
          setting('pool.add-account', 'Add account', methods.map((method) => method.label).join(' · '), {
            description: 'Run the provider login flow and store a new pooled credential.',
            submenu: (_currentValue, done) =>
              new SelectSubmenu(
                theme,
                `Add ${provider.name} account`,
                'Choose the login method for the new account.',
                methods.map((method) => ({ value: method.value, label: method.label })),
                methods[0]!.value,
                (value) => done(`${ADD_SENTINEL_PREFIX}${value}`),
                () => done(),
              ),
          }),
        ]),
    setting('scheduler', 'Scheduler', schedulerSummary(state.scheduler), {
      description: 'Global failure cooldowns applied to every pool. Saves immediately.',
      submenu: sectionSubmenu(
        theme,
        'Scheduler cooldowns',
        'Global failure cooldowns applied to every pool. Changes save and apply immediately.',
        [
          cooldownRow(theme, state, 'rateLimitCooldownMs', 'Rate-limit cooldown', 'Cooldown after HTTP 429 / rate-limit failures. Default 60s.', RATE_LIMIT_OPTIONS),
          cooldownRow(theme, state, 'quotaCooldownMs', 'Quota cooldown', 'Cooldown after quota or credit exhaustion (HTTP 402). Default 15m.', QUOTA_OPTIONS),
          cooldownRow(theme, state, 'authCooldownMs', 'Auth cooldown', 'Cooldown after 401/403 or invalid/expired credentials. Default 5m.', AUTH_OPTIONS),
          cooldownRow(theme, state, 'transientBaseCooldownMs', 'Transient base cooldown', 'Base for exponential backoff on transient (5xx/408/425) failures; doubles per consecutive failure. Default 1s.', TRANSIENT_OPTIONS),
          cooldownRow(theme, state, 'maxCooldownMs', 'Max cooldown', 'Upper bound applied to every cooldown. Default 60m.', MAX_COOLDOWN_OPTIONS),
        ],
        persist,
      ),
    }),
  ]
  return {
    title: `${provider.name} pool`,
    subtitle: state.poolExists
      ? `${state.accounts.length} stored ${state.accounts.length === 1 ? 'account' : 'accounts'} · changes save immediately`
      : 'No pool yet · pool and upstream settings apply once the first account is added',
    items: markDrillIn(items),
  }
}

export class PoolManagerComponent extends Container {
  settingsList: SettingsList
  private readonly theme: Theme
  private readonly titleText: Text
  private readonly subtitleText: Text
  private readonly listContainer: Container

  constructor(
    theme: Theme,
    private readonly buildCurrentView: () => PoolManagerView,
    private readonly onChangeHandler: (id: string, newValue: string) => void,
    private readonly onCancelHandler: () => void,
    private readonly requestRender: () => void,
  ) {
    super()
    this.theme = theme
    this.addChild(new DynamicBorder((text) => theme.fg('border', text)))
    const view = this.buildCurrentView()
    this.titleText = new Text(theme.bold(theme.fg('accent', view.title)), 1, 0)
    this.subtitleText = new Text(theme.fg('muted', view.subtitle), 1, 0)
    this.addChild(this.titleText)
    this.addChild(this.subtitleText)
    this.addChild(new Spacer(1))
    this.listContainer = new Container()
    this.settingsList = this.createList(view.items)
    this.listContainer.addChild(this.settingsList)
    this.addChild(this.listContainer)
    this.addChild(new Spacer(1))
    this.addChild(new DynamicBorder((text) => theme.fg('border', text)))
  }

  private createList(items: SettingItem[]): SettingsList {
    return new SettingsList(
      items,
      Math.min(Math.max(items.length, 1), 12),
      settingsListTheme(this.theme),
      this.onChangeHandler,
      this.onCancelHandler,
      { enableSearch: true },
    )
  }

  refresh(selectAfter?: string): void {
    const view = this.buildCurrentView()
    this.titleText.setText(this.theme.bold(this.theme.fg('accent', view.title)))
    this.subtitleText.setText(this.theme.fg('muted', view.subtitle))
    this.listContainer.clear()
    this.settingsList = this.createList(view.items)
    if (selectAfter !== undefined) this.settingsList.selectItem(selectAfter)
    this.listContainer.addChild(this.settingsList)
    this.requestRender()
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data)
  }
}

function selectAfterFor(id: string): string {
  const segments = id.split('.')
  if (segments[0] === 'account' && segments.length >= 2) return `account.${segments[1]}`
  return segments[0] ?? id
}

export async function openPoolManager(
  ctx: ExtensionContext,
  provider: Provider<Api>,
  callbacks: PoolManagerCallbacks,
  methods: readonly PoolManagerAuthMethod[],
): Promise<PoolManagerResult> {
  let lastState = await callbacks.loadState()
  return ctx.ui.custom<PoolManagerResult>((tui, theme, _keybindings, done) => {
    let finished = false
    const exit = (result: PoolManagerResult) => {
      if (finished) return
      finished = true
      done(result)
    }

    const component = new PoolManagerComponent(
      theme,
      () => buildView(theme, provider, lastState, methods, persist),
      persist,
      () => exit({ type: 'closed' }),
      () => tui.requestRender(),
    )

    let queue: Promise<void> = Promise.resolve()
    function persist(id: string, value: string): void {
      queue = queue
        .then(() => dispatch(id, value))
        .catch((error: unknown) => {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
        })
        .then(async () => {
          if (finished) return
          lastState = await callbacks.loadState()
          component.refresh(selectAfterFor(id))
        })
        .catch(() => undefined)
    }

    async function dispatch(id: string, value: string): Promise<void> {
      if (id === 'pool.add-account' && value.startsWith(ADD_SENTINEL_PREFIX)) {
        exit({ type: 'add', authType: value.slice(ADD_SENTINEL_PREFIX.length) as AuthType })
        return
      }
      if (id === 'pool.policy') {
        await callbacks.updatePool({ policy: value as SelectionPolicy })
        return
      }
      if (id === 'pool.affinity') {
        await callbacks.updatePool({ affinity: value === 'true' })
        return
      }
      if (id === 'upstream.enabled') {
        await callbacks.updatePool({ includeUpstream: value === 'true' })
        return
      }
      if (id === 'upstream.label' || id === 'upstream.weight' || id === 'upstream.priority') {
        const field = id.slice('upstream.'.length) as 'label' | 'weight' | 'priority'
        await callbacks.updatePool({ upstream: mergeUpstream(lastState.upstream, field, value) })
        return
      }
      if (id.startsWith('scheduler.')) {
        const key = id.slice('scheduler.'.length)
        if (!(SCHEDULER_SETTING_KEYS as readonly string[]).includes(key)) return
        await callbacks.updateScheduler(
          key as SchedulerSettingKey,
          value === 'default' ? undefined : Number(value),
        )
        return
      }
      const accountMatch = /^account\.([^.]+)\.(label|enabled|weight|priority|remove)$/.exec(id)
      if (accountMatch === null) return
      const accountId = accountMatch[1]!
      const field = accountMatch[2]!
      if (field === 'remove') {
        if (value === REMOVE_SENTINEL) await callbacks.removeAccount(accountId)
        return
      }
      if (field === 'label') {
        const label = value.trim()
        if (label === '') {
          ctx.ui.notify('Account label must not be empty.', 'error')
          return
        }
        await callbacks.updateAccount(accountId, { label })
        return
      }
      if (field === 'enabled') {
        await callbacks.updateAccount(accountId, { enabled: value === 'true' })
        return
      }
      if (field === 'weight' || field === 'priority') {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < (field === 'weight' ? 1 : 0)) return
        await callbacks.updateAccount(accountId, { [field]: parsed })
      }
    }

    return component
  })
}
