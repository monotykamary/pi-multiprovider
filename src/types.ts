import type {
  Api,
  AssistantMessage,
  AuthResult,
  Context,
  Model,
  Provider,
  ProviderAuth,
  StreamOptions,
} from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

export type AuthKind = 'api-key' | 'oauth' | 'service-account' | 'custom'
export type SelectionPolicy = 'round-robin' | 'weighted-round-robin' | 'least-inflight' | 'priority'
export type FailureKind = 'rate-limit' | 'quota' | 'auth' | 'transient' | 'fatal'

// How plain round-robin breaks ties when no session pin exists. 'first-account'
// always starts at the first healthy account in pool order (the "main"
// account) and only spills over while earlier accounts are unavailable;
// 'none' rotates evenly across accounts.
export type SelectionBias = 'first-account' | 'none'

export interface ProviderAttemptFailure {
  message: string
  status?: number
  headers?: Readonly<Record<string, string>>
  assistantMessage?: AssistantMessage
  cause?: unknown
  outputStarted: boolean
}

export interface ProviderAccount<TCredentialRef = unknown> {
  id: string
  label: string
  authKind: AuthKind
  credentialRef: TCredentialRef
  enabled?: boolean
  weight?: number
  priority?: number
  metadata?: Readonly<Record<string, string | number | boolean | null>>
}

export interface FailureDisposition {
  kind: FailureKind
  retryable: boolean
  cooldownMs?: number
}

export interface ProviderRegistration<TCredentialRef = unknown> {
  id: string
  label: string
  accounts: () => readonly ProviderAccount<TCredentialRef>[] | Promise<readonly ProviderAccount<TCredentialRef>[]>
  classifyFailure?: (
    failure: ProviderAttemptFailure,
    account: ProviderAccount<TCredentialRef>,
  ) => FailureDisposition | undefined
  managementHint?: string
  selectionBias?: SelectionBias
}

export interface AccountPreference {
  accountId: string
  enabled: boolean
  weight: number
  priority: number
}

export interface PoolPreference {
  providerId: string
  policy: SelectionPolicy
  affinity: boolean
  accounts: AccountPreference[]
}

// A session's pinned account. Explicit pins are set through pinAccount() and
// override the pool's affinity setting until cleared; implicit pins are the
// scheduler's own stickiness while pool affinity is enabled.
export interface AffinityPin {
  accountId: string
  explicit: boolean
}

export interface AcquireOptions {
  providerId: string
  affinityKey?: string
  excludeAccountIds?: Iterable<string>
}

export interface LeaseOutcomeSuccess { status: 'success' }
export interface LeaseOutcomeFailure { status: 'failure'; error: ProviderAttemptFailure }
export interface LeaseOutcomeCancelled { status: 'cancelled' }
export type LeaseOutcome = LeaseOutcomeSuccess | LeaseOutcomeFailure | LeaseOutcomeCancelled

export interface AccountLease<TCredentialRef = unknown> {
  readonly id: string
  readonly providerId: string
  readonly accountId: string
  readonly account: ProviderAccount<TCredentialRef>
  readonly credentialRef: TCredentialRef
  readonly acquiredAt: number
  release(outcome?: LeaseOutcome): FailureDisposition | undefined
}

export type PublicAccountStatus = 'ready' | 'cooldown' | 'disabled'

export interface PublicAccountSnapshot {
  id: string
  label: string
  authKind: AuthKind
  enabled: boolean
  weight: number
  priority: number
  status: PublicAccountStatus
  inFlight: number
  consecutiveFailures: number
  cooldownUntil?: number
  lastSelectedAt?: number
  lastFailureKind?: FailureKind
  metadata: Readonly<Record<string, string | number | boolean | null>>
}

export interface PublicPoolSnapshot {
  id: string
  label: string
  policy: SelectionPolicy
  affinity: boolean
  firstAccountBias: boolean
  managementHint?: string
  accounts: PublicAccountSnapshot[]
}

export interface MultiProviderSnapshot { providers: PublicPoolSnapshot[] }

/**
 * Fired when a pooled account is abandoned after its final tolerated error
 * and the stream is about to move to another account. Returning true tells
 * the stream to surface the buffered error instead of rotating accounts
 * inline — an external handler (e.g. compact-then-retry) will re-enter the
 * pool with fresh context.
 */
export interface FailoverInfo {
  providerId: string
  fromAccountId: string
  failure: ProviderAttemptFailure
  errorsOnAccount: number
}

export interface SchedulerSettings {
  rateLimitCooldownMs?: number
  quotaCooldownMs?: number
  authCooldownMs?: number
  transientBaseCooldownMs?: number
  maxCooldownMs?: number
  // Pre-output retryable errors absorbed on the same account before the
  // scheduler fails over to the next account. 1 reproduces the original
  // switch-on-first-error behavior.
  errorsBeforeSwitch?: number
}

// Patch form of SchedulerSettings where an explicitly undefined key clears
// the stored override under exactOptionalPropertyTypes.
export type SchedulerSettingsPatch = {
  [K in keyof SchedulerSettings]?: SchedulerSettings[K] | undefined
}

// Host-facing metadata snapshot of a backing model, captured when the backend
// is picked in /vprovider. Virtual models fall back to it while the backing
// provider is not registered yet — pi snapshots enabled/resumed-session
// models right after extension load, so thinking-level support and context
// metadata must not depend on provider registration order.
export interface VirtualModelTemplate {
  api: Model<Api>['api']
  baseUrl: string
  reasoning: boolean
  thinkingLevelMap?: Model<Api>['thinkingLevelMap']
  input: Model<Api>['input']
  cost: Model<Api>['cost']
  contextWindow: number
  maxTokens: number
}

// One backing (provider, model) pair inside a virtual provider. Virtual
// backends are scheduler accounts; the credentialRef carries the pair.
export interface VirtualBackend {
  providerId: string
  modelId: string
  enabled?: boolean
  weight?: number
  template?: VirtualModelTemplate
}

export interface VirtualModelConfig {
  id: string
  label?: string
  backends: VirtualBackend[]
}

// A virtual provider maps one virtual model (or several) to backing provider
// models so sessions round-robin across providers while keeping per-session
// cache affinity.
export interface VirtualProviderConfig {
  id: string
  label: string
  models: VirtualModelConfig[]
}

export const SCHEDULER_SETTING_KEYS = [
  'rateLimitCooldownMs',
  'quotaCooldownMs',
  'authCooldownMs',
  'transientBaseCooldownMs',
  'maxCooldownMs',
  'errorsBeforeSwitch',
] as const satisfies readonly (keyof SchedulerSettings)[]

export interface SchedulerOptions {
  defaultPolicy?: SelectionPolicy
  affinity?: boolean
  rateLimitCooldownMs?: number
  quotaCooldownMs?: number
  authCooldownMs?: number
  transientBaseCooldownMs?: number
  maxCooldownMs?: number
  errorsBeforeSwitch?: number
  now?: () => number
  randomId?: () => string
}

export interface AccountRequestContext<TApi extends Api = Api> {
  provider: Provider<TApi>
  model: Model<TApi>
  context: Context
  requestOptions: Readonly<StreamOptions & Record<string, unknown>>
  signal: AbortSignal
}

export interface AccountAttemptContext<TApi extends Api = Api, TCredentialRef = unknown>
  extends AccountRequestContext<TApi> {
  account: ProviderAccount<TCredentialRef>
  resolution: AuthResult
}

export interface LiftProviderOptions<TApi extends Api = Api, TCredentialRef = unknown> {
  auth?: ProviderAuth
  resolveAuth: (
    account: ProviderAccount<TCredentialRef>,
    signal: AbortSignal,
    request: AccountRequestContext<TApi>,
  ) => AuthResult | Promise<AuthResult>
  excludeAccountIds?: (
    request: AccountRequestContext<TApi>,
  ) => Iterable<string> | Promise<Iterable<string>>
  sanitizeRequestOptions?: (
    attempt: AccountAttemptContext<TApi, TCredentialRef>,
  ) => StreamOptions & Record<string, unknown>
  affinityKey?: (input: {
    provider: Provider<TApi>
    model: Model<TApi>
    context: Context
  }) => string | undefined
  disableProviderRetries?: boolean
  maxAccountAttempts?: number
  onFailover?: (info: FailoverInfo) => boolean | void
}

export interface MultiProviderIntegration<TApi extends Api = Api, TCredentialRef = unknown>
  extends ProviderRegistration<TCredentialRef>, LiftProviderOptions<TApi, TCredentialRef> {}

export const MULTIPROVIDER_REGISTER_EVENT = 'pi-multiprovider:register'

// Cross-extension service announcement. The bundled extension emits this event
// with a MultiProviderServiceAnnouncement so sibling extensions can follow the
// session's active pooled account (for example, to refresh account-scoped
// subscription usage views after /switch-account).
export const MULTIPROVIDER_SERVICE_EVENT = 'pi-multiprovider:service'

// Context slice consumers pass to the announcement; the affinity key and base
// provider lookups need only these fields.
export type MultiProviderServiceContext = Pick<
  ExtensionContext,
  'modelRegistry' | 'model' | 'sessionManager'
>

export interface ActiveAccount {
  id: string
  label: string
  authKind: AuthKind
}

export interface ActiveAccountAuth {
  accessToken: string
  label: string
  source?: string
}

export interface ActiveAccountChangedEvent {
  providerId: string
  account: ActiveAccount | undefined
  ctx: ExtensionContext
}

export interface MultiProviderServiceAnnouncement {
  getActiveAccount(
    providerId: string,
    ctx: MultiProviderServiceContext,
  ): Promise<ActiveAccount | undefined>
  resolveActiveAccountAuth(
    providerId: string,
    ctx: MultiProviderServiceContext,
    signal?: AbortSignal,
  ): Promise<ActiveAccountAuth | undefined>
  onActiveAccountChanged(
    providerId: string,
    callback: (event: ActiveAccountChangedEvent) => void,
  ): () => void
}
