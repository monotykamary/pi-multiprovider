// Provider shapes and endpoint choices are adapted from QuotaBar (MIT,
// Copyright (c) 2026 GiantAccel, LLC). The implementation is TypeScript-native
// and accepts only auth already resolved by pi-multiprovider.
import type { AuthResult } from '@earendil-works/pi-ai'
import type {
  ProviderUsageSnapshot,
  UsageFetchContext,
  UsageFetcher,
  UsageUnit,
  UsageWindow,
} from './types.ts'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function time(value: unknown, now = Date.now()): number | undefined {
  const raw = number(value)
  if (raw !== undefined) {
    if (raw <= 0) return undefined
    return raw > 10_000_000_000 ? raw : raw * 1_000
  }
  const text = string(value)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) return parsed
  const seconds = Number(text)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000
  return undefined
}

function percent(value: unknown, ratio = false): number | undefined {
  const raw = number(value)
  if (raw === undefined) return undefined
  const expanded = ratio && raw >= 0 && raw <= 1 ? raw * 100 : raw
  return Math.min(100, Math.max(0, expanded))
}

function usedPercent(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) return undefined
  return Math.min(100, Math.max(0, used / limit * 100))
}

function windowLabel(seconds: number | undefined, fallback = 'Usage'): string {
  if (seconds === undefined) return fallback
  if (seconds % 604_800 === 0) return `${seconds / 604_800} week`
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day`
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour`
  return fallback
}

function cleanWindow(input: UsageWindow): UsageWindow {
  return {
    ...input,
    ...(input.usedPercent === undefined
      ? {}
      : { usedPercent: Math.min(100, Math.max(0, input.usedPercent)) }),
  }
}

function headersFrom(resolution: AuthResult, extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(resolution.auth.headers ?? {})) {
    if (typeof value === 'string') result[name] = value
  }
  const hasAuthorization = Object.keys(result).some(name => name.toLowerCase() === 'authorization')
  if (!hasAuthorization && resolution.auth.apiKey !== undefined) {
    result.Authorization = `Bearer ${resolution.auth.apiKey}`
  }
  return { Accept: 'application/json', ...result, ...extra }
}

function tokenFrom(resolution: AuthResult): string | undefined {
  if (resolution.auth.apiKey?.trim()) return resolution.auth.apiKey.trim()
  for (const [name, value] of Object.entries(resolution.auth.headers ?? {})) {
    if (name.toLowerCase() !== 'authorization' || typeof value !== 'string') continue
    const match = /^(?:bearer|token)\s+(.+)$/i.exec(value.trim())
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

function headerFrom(resolution: AuthResult, wanted: string): string | undefined {
  for (const [name, value] of Object.entries(resolution.auth.headers ?? {})) {
    if (name.toLowerCase() === wanted.toLowerCase() && typeof value === 'string') return value
  }
  return undefined
}

function jwtStringClaim(token: string, namespace: string, claim: string): string | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const decoded = object(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown)
    return string(object(decoded?.[namespace])?.[claim])
  } catch {
    return undefined
  }
}

async function requestJson(
  url: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<unknown> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`usage endpoint returned HTTP ${response.status}`)
  try {
    return await response.json() as unknown
  } catch {
    throw new Error('usage endpoint returned malformed JSON')
  }
}

function snapshot(windows: UsageWindow[], plan?: string): ProviderUsageSnapshot {
  if (windows.length === 0) throw new Error('usage endpoint returned no quota windows')
  return {
    ...(plan === undefined ? {} : { plan }),
    windows: windows.map(cleanWindow),
  }
}

function codexWindow(value: unknown, labelPrefix?: string, active = false): UsageWindow | undefined {
  const item = object(value)
  if (item === undefined) return undefined
  const used = percent(item.used_percent)
  if (used === undefined) return undefined
  const seconds = number(item.limit_window_seconds)
  const resetAt = time(item.reset_at)
    ?? (number(item.reset_after_seconds) === undefined
      ? undefined
      : Date.now() + number(item.reset_after_seconds)! * 1_000)
  const base = windowLabel(seconds)
  return {
    id: labelPrefix === undefined ? base : `${labelPrefix}:${base}`,
    label: labelPrefix === undefined ? base : `${labelPrefix} · ${base}`,
    usedPercent: used,
    ...(resetAt === undefined ? {} : { resetsAt: resetAt }),
    ...(seconds === undefined ? {} : { windowSeconds: seconds }),
    ...(labelPrefix === undefined ? {} : { scope: labelPrefix }),
    active,
  }
}

export function parseCodexUsage(value: unknown): ProviderUsageSnapshot {
  const root = object(value)
  if (root === undefined) throw new Error('usage endpoint returned malformed JSON')
  const windows: UsageWindow[] = []
  const rate = object(root.rate_limit)
  for (const field of ['primary_window', 'secondary_window']) {
    const parsed = codexWindow(rate?.[field], undefined, true)
    if (parsed !== undefined) windows.push(parsed)
  }
  for (const raw of Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : []) {
    const extra = object(raw)
    const name = string(extra?.limit_name) ?? string(extra?.metered_feature) ?? 'Additional limit'
    const extraRate = object(extra?.rate_limit)
    for (const field of ['primary_window', 'secondary_window']) {
      const parsed = codexWindow(extraRate?.[field], name)
      if (parsed !== undefined) windows.push(parsed)
    }
  }
  const rawPlan = string(root.plan_type)
  const plan = rawPlan === 'prolite'
    ? 'Pro 5x'
    : rawPlan === 'pro' ? 'Pro 20x' : rawPlan?.replaceAll('_', ' ')
  return snapshot(windows, plan)
}

export function parseClaudeUsage(value: unknown): ProviderUsageSnapshot {
  const root = object(value)
  if (root === undefined) throw new Error('usage endpoint returned malformed JSON')
  const windows: UsageWindow[] = []
  const limits = Array.isArray(root.limits) ? root.limits : []
  for (const raw of limits) {
    const limit = object(raw)
    if (limit === undefined) continue
    const kind = string(limit.kind) ?? string(limit.group) ?? 'quota'
    const used = percent(limit.percent)
    if (used === undefined) continue
    const seconds = kind === 'session' ? 18_000 : kind.startsWith('weekly') ? 604_800 : undefined
    const scopeRecord = object(limit.scope)
    const model = object(scopeRecord?.model)
    const scope = string(model?.display_name) ?? string(model?.id)
    const label = scope === undefined ? windowLabel(seconds, kind.replaceAll('_', ' ')) : `${windowLabel(seconds)} · ${scope}`
    windows.push({
      id: kind + (scope === undefined ? '' : `:${scope}`),
      label,
      usedPercent: used,
      ...(time(limit.resets_at) === undefined ? {} : { resetsAt: time(limit.resets_at)! }),
      ...(seconds === undefined ? {} : { windowSeconds: seconds }),
      ...(scope === undefined ? {} : { scope }),
      active: limit.is_active === true,
    })
  }
  const legacy = [
    ['five_hour', '5 hour', 18_000],
    ['seven_day', '1 week', 604_800],
  ] as const
  if (windows.length === 0) {
    for (const [key, label, seconds] of legacy) {
      const item = object(root[key])
      const used = percent(item?.utilization)
      if (item === undefined || used === undefined) continue
      windows.push({
        id: key,
        label,
        usedPercent: used,
        ...(time(item.resets_at) === undefined ? {} : { resetsAt: time(item.resets_at)! }),
        windowSeconds: seconds,
        active: key === 'five_hour',
      })
    }
  }
  return snapshot(windows)
}

export function parseGeminiUsage(value: unknown): ProviderUsageSnapshot {
  const root = object(value)
  const buckets = Array.isArray(root?.buckets) ? root.buckets : []
  return snapshot(buckets.slice(0, 20).flatMap((raw, index) => {
    const bucket = object(raw)
    const remaining = number(bucket?.remainingFraction ?? bucket?.remaining_fraction)
    if (bucket === undefined || remaining === undefined) return []
    const label = string(bucket.modelId ?? bucket.model_id) ?? `Model quota ${index + 1}`
    return [{
      id: label,
      label,
      usedPercent: Math.min(100, Math.max(0, (1 - remaining) * 100)),
      ...(time(bucket.resetTime ?? bucket.reset_time) === undefined
        ? {}
        : { resetsAt: time(bucket.resetTime ?? bucket.reset_time)! }),
      scope: label,
    } satisfies UsageWindow]
  }))
}

export function parseZaiUsage(value: unknown): ProviderUsageSnapshot {
  const root = object(value)
  const data = object(root?.data)
  const limits = Array.isArray(data?.limits) ? data.limits : []
  const unitMinutes: Record<number, number> = { 0: 1, 1: 60, 2: 1_440, 3: 10_080, 4: 43_200, 5: 43_800 }
  return snapshot(limits.flatMap((raw, index) => {
    const limit = object(raw)
    if (limit === undefined) return []
    const minutes = (number(limit.number) ?? 0) * (unitMinutes[number(limit.unit) ?? -1] ?? 0)
    const usage = number(limit.usage)
    const remaining = number(limit.remaining)
    const total = usage !== undefined && remaining !== undefined ? usage + remaining : undefined
    const usagePercent = percent(limit.percentage) ?? usedPercent(usage, total)
    const label = minutes > 0 ? windowLabel(minutes * 60) : string(limit.type) ?? `Quota ${index + 1}`
    return [{
      id: string(limit.type) ?? label,
      label,
      ...(usagePercent === undefined ? {} : { usedPercent: usagePercent }),
      ...(usage === undefined ? {} : { used: usage }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(total === undefined ? {} : { limit: total }),
      unit: 'requests' as const,
      ...(time(limit.nextResetTime ?? limit.next_reset_time) === undefined
        ? {}
        : { resetsAt: time(limit.nextResetTime ?? limit.next_reset_time)! }),
      ...(minutes <= 0 ? {} : { windowSeconds: minutes * 60 }),
    } satisfies UsageWindow]
  }))
}

function flexibleWindow(raw: unknown, id: string, label: string, seconds?: number): UsageWindow | undefined {
  const item = object(raw)
  if (item === undefined) return undefined
  const direct = percent(item.percent ?? item.percentUsed ?? item.usage_percent ?? item.used_percent)
  const limit = number(item.limit ?? item.total)
  const remaining = number(item.remaining ?? item.left)
  const used = number(item.used) ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)
  const computed = direct ?? usedPercent(used, limit)
  if (computed === undefined && used === undefined && remaining === undefined) return undefined
  return {
    id,
    label,
    ...(computed === undefined ? {} : { usedPercent: computed }),
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(time(item.resetsAt ?? item.reset_at ?? item.resetTime) === undefined
      ? {}
      : { resetsAt: time(item.resetsAt ?? item.reset_at ?? item.resetTime)! }),
    ...(seconds === undefined ? {} : { windowSeconds: seconds }),
  }
}

export function parseFlexibleUsage(value: unknown): ProviderUsageSnapshot {
  const root = object(value)
  if (root === undefined) throw new Error('usage endpoint returned malformed JSON')
  const container = object(root.usage) ?? root
  const windows: UsageWindow[] = []
  for (const [keys, id, label, seconds] of [
    [['rolling', 'rollingUsage', 'rolling_usage'], 'rolling', 'Rolling window', undefined],
    [['weekly', 'weeklyUsage', 'weekly_usage'], 'weekly', '1 week', 604_800],
    [['monthly', 'monthlyUsage', 'monthly_usage'], 'monthly', '30 day', 2_592_000],
  ] as const) {
    const key = keys.find(candidate => container[candidate] !== undefined)
    const parsed = key === undefined ? undefined : flexibleWindow(container[key], id, label, seconds)
    if (parsed !== undefined) windows.push(parsed)
  }
  if (windows.length === 0) {
    const usages = object(root.usages)
    for (const [key, seconds] of [['limit_5h', 18_000], ['limit_7d', 604_800], ['limit_month_total', 2_592_000]] as const) {
      const item = object(usages?.[key])
      const ratio = number(item?.used_ratio)
      if (item === undefined || ratio === undefined) continue
      windows.push({
        id: key,
        label: windowLabel(seconds),
        usedPercent: percent(ratio, true)!,
        ...(time(item.reset_time) === undefined ? {} : { resetsAt: time(item.reset_time)! }),
        windowSeconds: seconds,
      })
    }
  }
  return snapshot(windows, string(object(root.user)?.plan ?? root.plan))
}

export function parseMiniMaxUsage(value: unknown): ProviderUsageSnapshot {
  const root = object(value)
  const data = object(root?.data)
  const rawRemains = data?.model_remains ?? data?.modelRemains
  const remains: unknown[] = Array.isArray(rawRemains) ? rawRemains : []
  const windows: UsageWindow[] = []
  for (const raw of remains) {
    const item = object(raw)
    if (item === undefined) continue
    const scope = string(item.model_name ?? item.modelName) ?? 'Model'
    const intervalRemaining = percent(item.current_interval_remaining_percent ?? item.currentIntervalRemainingPercent)
    if (intervalRemaining !== undefined) {
      windows.push({
        id: `${scope}:interval`, label: `${scope} · interval`, scope,
        usedPercent: 100 - intervalRemaining,
        ...(time(item.end_time ?? item.endTime) === undefined ? {} : { resetsAt: time(item.end_time ?? item.endTime)! }),
      })
    }
    const weeklyRemaining = percent(item.current_weekly_remaining_percent ?? item.currentWeeklyRemainingPercent)
    if (weeklyRemaining !== undefined) {
      windows.push({
        id: `${scope}:weekly`, label: `${scope} · 1 week`, scope,
        usedPercent: 100 - weeklyRemaining,
        ...(time(item.weekly_end_time ?? item.weeklyEndTime) === undefined
          ? {}
          : { resetsAt: time(item.weekly_end_time ?? item.weeklyEndTime)! }),
        windowSeconds: 604_800,
      })
    }
  }
  return snapshot(windows)
}

export function parseGrokUsage(value: unknown): ProviderUsageSnapshot {
  const root = object(value)
  const config = object(root?.config)
  if (config === undefined) throw new Error('usage endpoint returned malformed JSON')
  const period = object(config.currentPeriod ?? config.current_period)
  const rawType = string(period?.type)?.toLowerCase() ?? ''
  const seconds = rawType.includes('week') ? 604_800 : rawType.includes('month') ? 2_592_000 : undefined
  const label = windowLabel(seconds, 'Billing period')
  const windows: UsageWindow[] = []
  const total = percent(config.creditUsagePercent ?? config.credit_usage_percent)
  if (total !== undefined) {
    windows.push({
      id: 'credits', label, usedPercent: total,
      ...(time(period?.end ?? config.billingPeriodEnd) === undefined
        ? {}
        : { resetsAt: time(period?.end ?? config.billingPeriodEnd)! }),
      ...(seconds === undefined ? {} : { windowSeconds: seconds }),
    })
  }
  return snapshot(windows, string(config.subscriptionTier ?? root?.subscriptionTier))
}

export function parseCopilotUsage(value: unknown): ProviderUsageSnapshot {
  const root = object(value)
  if (root === undefined) throw new Error('usage endpoint returned malformed JSON')
  const snapshots = object(root.quota_snapshots) ?? {}
  const reset = time(root.quota_reset_date_utc ?? root.quota_reset_date ?? root.limited_user_reset_date)
  const labels: Record<string, string> = {
    premium_interactions: 'Premium requests', chat: 'Chat', completions: 'Completions',
  }
  const windows: UsageWindow[] = []
  for (const key of Object.keys(labels)) {
    const item = object(snapshots[key])
    if (item === undefined || item.unlimited === true) continue
    const limit = number(item.entitlement)
    const remaining = number(item.remaining)
    const percentRemaining = percent(item.percent_remaining)
      ?? (limit !== undefined && remaining !== undefined && limit > 0 ? remaining / limit * 100 : undefined)
    if (percentRemaining === undefined) continue
    windows.push({
      id: key, label: labels[key]!, usedPercent: 100 - percentRemaining,
      ...(limit === undefined ? {} : { limit }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(limit === undefined || remaining === undefined ? {} : { used: limit - remaining }),
      unit: 'requests',
      ...(reset === undefined ? {} : { resetsAt: reset }),
    })
  }
  if (windows.length === 0) {
    windows.push({ id: 'subscription', label: 'Subscription' })
  }
  return snapshot(windows, string(root.copilot_plan))
}

function parseBalance(value: unknown, label: string, unit: UsageUnit = 'usd'): ProviderUsageSnapshot {
  const root = object(value)
  const data = object(root?.data) ?? root
  if (data === undefined) throw new Error('usage endpoint returned malformed JSON')
  const entries = Array.isArray(data.balance_infos) ? data.balance_infos : undefined
  const first = object(entries?.[0])
  const total = number(data.total_credits ?? first?.topped_up_balance)
  const directUsed = number(data.total_usage)
  const statedRemaining = number(first?.total_balance ?? data.balance ?? data.available_balance)
  const remaining = statedRemaining
    ?? (total !== undefined && directUsed !== undefined ? Math.max(0, total - directUsed) : total)
  const used = directUsed ?? (total !== undefined && remaining !== undefined ? total - remaining : undefined)
  if (remaining === undefined && total === undefined && used === undefined) {
    throw new Error('usage endpoint returned no balance')
  }
  return snapshot([{
    id: 'balance', label,
    ...(usedPercent(used, total) === undefined ? {} : { usedPercent: usedPercent(used, total)! }),
    ...(used === undefined ? {} : { used }),
    ...(total === undefined ? {} : { limit: total }),
    ...(remaining === undefined ? {} : { remaining }),
    unit,
  }])
}

function endpointFetcher(
  url: string | ((context: UsageFetchContext) => string),
  parser: (value: unknown) => ProviderUsageSnapshot,
  options: { method?: 'GET' | 'POST'; extraHeaders?: Record<string, string> } = {},
): UsageFetcher {
  return async context => parser(await requestJson(
    typeof url === 'function' ? url(context) : url,
    {
      method: options.method ?? 'GET',
      headers: headersFrom(context.resolution, options.extraHeaders),
      ...(options.method === 'POST' ? { body: '{}' } : {}),
      signal: context.signal,
    },
  ))
}

const codex: UsageFetcher = async context => {
  const token = tokenFrom(context.resolution)
  const accountId = token === undefined
    ? undefined
    : jwtStringClaim(token, 'https://api.openai.com/auth', 'chatgpt_account_id')
  const headers = headersFrom(context.resolution,
    accountId === undefined ? {} : { 'ChatGPT-Account-Id': accountId })
  return parseCodexUsage(await requestJson('https://chatgpt.com/backend-api/wham/usage', {
    method: 'GET', headers, signal: context.signal,
  }))
}
const claude = endpointFetcher(
  'https://api.anthropic.com/api/oauth/usage',
  parseClaudeUsage,
  { extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' } },
)
const gemini = endpointFetcher(
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  parseGeminiUsage,
  { method: 'POST' },
)
const grok = endpointFetcher(
  'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  parseGrokUsage,
  { extraHeaders: { 'x-xai-token-auth': 'xai-grok-cli' } },
)
const openCodeGo = endpointFetcher('https://opencode.ai/zen/go/v1/usage', parseFlexibleUsage)
const deepSeek = endpointFetcher('https://api.deepseek.com/user/balance', value => parseBalance(value, 'Balance'))
const zai = endpointFetcher('https://api.z.ai/api/monitor/usage/quota/limit', parseZaiUsage)
const zaiCn = endpointFetcher('https://open.bigmodel.cn/api/monitor/usage/quota/limit', parseZaiUsage)
const minimax = endpointFetcher('https://api.minimax.io/v1/api/openplatform/coding_plan/remains', parseMiniMaxUsage)
const minimaxCn = endpointFetcher('https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains', parseMiniMaxUsage)
const copilot = endpointFetcher(
  'https://api.github.com/copilot_internal/user',
  parseCopilotUsage,
  { extraHeaders: { 'Editor-Version': 'vscode/1.96.2', 'Editor-Plugin-Version': 'copilot-chat/0.26.7' } },
)

const kimi: UsageFetcher = async context => {
  const configured = context.resolution.auth.baseUrl?.replace(/\/$/, '')
  const url = configured === undefined
    ? 'https://api.kimi.com/coding/v1/usages'
    : configured.endsWith('/coding/v1') ? `${configured}/usages` : `${configured}/coding/v1/usages`
  return parseFlexibleUsage(await requestJson(url, {
    method: 'GET', headers: headersFrom(context.resolution), signal: context.signal,
  }))
}

const moonshot: UsageFetcher = async context => {
  let lastError: unknown
  for (const host of ['https://api.moonshot.cn', 'https://api.moonshot.ai']) {
    try {
      return parseBalance(await requestJson(`${host}/v1/users/me/balance`, {
        method: 'GET', headers: headersFrom(context.resolution), signal: context.signal,
      }), 'Balance')
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

const openRouter: UsageFetcher = async context => {
  const headers = headersFrom(context.resolution, { 'X-Title': 'pi-multiprovider' })
  const [credits, key] = await Promise.all([
    requestJson('https://openrouter.ai/api/v1/credits', { method: 'GET', headers, signal: context.signal }),
    requestJson('https://openrouter.ai/api/v1/key', { method: 'GET', headers, signal: context.signal }).catch(() => undefined),
  ])
  const base = parseBalance(credits, 'Credits')
  const info = object(object(key)?.data)
  const limit = number(info?.limit)
  const remaining = number(info?.limit_remaining)
  if (limit !== undefined && limit > 0) {
    const keyRemaining = remaining ?? limit
    const keyUsed = limit - keyRemaining
    const keyUsedPercent = usedPercent(keyUsed, limit)
    base.windows.push({
      id: 'key-limit', label: 'Key limit', limit,
      remaining: keyRemaining,
      used: keyUsed,
      ...(keyUsedPercent === undefined ? {} : { usedPercent: keyUsedPercent }),
      unit: 'usd',
      ...(time(info?.limit_reset) === undefined ? {} : { resetsAt: time(info?.limit_reset)! }),
    })
  }
  return base
}

function hasCookie(resolution: AuthResult): boolean {
  return headerFrom(resolution, 'cookie') !== undefined
}

function isOAuthUsage(context: UsageFetchContext): boolean {
  return context.account.authKind === 'oauth' || /\boauth\b/i.test(context.resolution.source ?? '')
}

const xiaomi: UsageFetcher = async context => {
  if (!hasCookie(context.resolution)) return undefined
  const headers = headersFrom(context.resolution, {
    Origin: 'https://platform.xiaomimimo.com',
    Referer: 'https://platform.xiaomimimo.com/#/console/balance',
  })
  const [balance, usage] = await Promise.all([
    requestJson('https://platform.xiaomimimo.com/api/v1/balance', {
      method: 'GET', headers, signal: context.signal,
    }),
    requestJson('https://platform.xiaomimimo.com/api/v1/tokenPlan/usage', {
      method: 'GET', headers, signal: context.signal,
    }).catch(() => undefined),
  ])
  const result = parseBalance(balance, 'Account balance')
  const month = object(object(object(usage)?.data)?.monthUsage)
  const item = object(Array.isArray(month?.items) ? month.items[0] : undefined)
  const limit = number(item?.limit)
  const used = number(item?.used)
  if (limit !== undefined && limit > 0 && used !== undefined) {
    const monthPercent = usedPercent(used, limit)
    result.windows.unshift({
      id: 'token-plan-month', label: 'Token plan · month', used, limit,
      remaining: Math.max(0, limit - used),
      ...(monthPercent === undefined ? {} : { usedPercent: monthPercent }),
      unit: 'tokens', windowSeconds: 2_592_000,
    })
  }
  return result
}

const BUILT_INS: Readonly<Record<string, UsageFetcher>> = {
  'openai-codex': codex,
  anthropic: async context => isOAuthUsage(context) ? claude(context) : undefined,
  google: async context => isOAuthUsage(context) ? gemini(context) : undefined,
  xai: grok,
  'github-copilot': copilot,
  'kimi-coding': kimi,
  'opencode-go': openCodeGo,
  deepseek: deepSeek,
  zai,
  'zai-coding-cn': zaiCn,
  minimax,
  'minimax-cn': minimaxCn,
  moonshotai: moonshot,
  'moonshotai-cn': moonshot,
  openrouter: openRouter,
  'xiaomi-token-plan-ams': xiaomi,
  'xiaomi-token-plan-cn': xiaomi,
  'xiaomi-token-plan-sgp': xiaomi,
}

export function builtInUsageFetcher(providerId: string): UsageFetcher | undefined {
  return BUILT_INS[providerId]
}

export function hasUsableToken(resolution: AuthResult): boolean {
  return tokenFrom(resolution) !== undefined || hasCookie(resolution)
}
