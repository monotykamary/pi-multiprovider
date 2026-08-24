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

export type AuthKind = 'api-key' | 'oauth' | 'service-account' | 'custom'
export type SelectionPolicy = 'round-robin' | 'weighted-round-robin' | 'least-inflight' | 'priority'
export type FailureKind = 'rate-limit' | 'quota' | 'auth' | 'transient' | 'fatal'

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
  ) => FailureDisposition
  managementHint?: string
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
  managementHint?: string
  accounts: PublicAccountSnapshot[]
}

export interface MultiProviderSnapshot { providers: PublicPoolSnapshot[] }

export interface SchedulerOptions {
  defaultPolicy?: SelectionPolicy
  affinity?: boolean
  rateLimitCooldownMs?: number
  quotaCooldownMs?: number
  authCooldownMs?: number
  transientBaseCooldownMs?: number
  maxCooldownMs?: number
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
}

export interface MultiProviderIntegration<TApi extends Api = Api, TCredentialRef = unknown>
  extends ProviderRegistration<TCredentialRef>, LiftProviderOptions<TApi, TCredentialRef> {}

export const MULTIPROVIDER_REGISTER_EVENT = 'pi-multiprovider:register'
