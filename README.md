<div align="center">

# 🔀 pi-multiprovider

**Multi-account credential pooling and safe same-provider failover for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_One provider ID. One model ID. As many API-key or OAuth accounts as you need._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-multiprovider/main/media/cover.svg" alt="Animated abstract artwork: violet, indigo, cyan, and teal credential streams converge into a glowing scheduler nexus and leave as one luminous current — one stream briefly flares and cools down while the rest carry the load" width="1100">
</p>

[![npm version](https://img.shields.io/npm/v/pi-multiprovider?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-multiprovider)
[![checks](https://img.shields.io/github/actions/workflow/status/monotykamary/pi-multiprovider/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/monotykamary/pi-multiprovider/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![Node 22](https://img.shields.io/badge/node-%E2%89%A522.19-339933?style=for-the-badge&logo=node.js)](package.json)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

---

Pi normally owns **one stored credential per provider**. `pi-multiprovider` adds a second, provider-scoped credential store and lifts the provider's native stream in place. Each request leases an account, resolves that account's auth, and delegates to the original provider without inventing aliases such as `zro-2` or changing the selected model.

If an account fails before visible output, the lift can cool it down and retry another account inside the same logical stream. Once text, thinking, or a tool call is visible, replay stops—duplicate output is worse than a surfaced error.

## Why multiprovider?

| | Capability | What it does |
| :-: | --- | --- |
| 🔐 | **Multiple credentials** | Store API keys and provider-native OAuth credentials per provider. |
| 🪄 | **`/multilogin`** | Reuses Pi's searchable provider selector and login dialog, then opens a searchable settings-style pool manager for drilling into every row inline. |
| 🔀 | **Four pool strategies** | Round robin, weighted round robin, least in flight, or priority failover. |
| 🧬 | **Upstream merge** | Optionally treats Pi's normal `/login`, `auth.json`, environment, or ambient credential as another account—editable inline like any stored account. |
| 🩺 | **Health-aware leases** | Tracks in-flight work, failures, cooldowns, session affinity, and retry exclusions. |
| 🛡️ | **Stream-safe failover** | Suppresses a rejected attempt's start/error events and retries only before user-visible output. |
| 🪪 | **Stable identity** | Provider ID, model ID, model picker entries, routing, and session history remain unchanged. |

## Install

Requires Node.js 22.19+ and Pi 0.84.3+.

```bash
pi install npm:pi-multiprovider
```

The npm package registers the extension automatically. Install the provider extension you want to pool as usual; for example:

```bash
pi install npm:pi-zro-provider
pi install npm:pi-multiprovider
```

<details>
<summary>Other install methods</summary>

From the new GitHub repository:

```bash
pi install git:github.com/monotykamary/pi-multiprovider
```

From a local checkout:

```bash
pnpm install
pnpm build
pi install /absolute/path/to/pi-multiprovider
```

For one development run:

```bash
pi -e /absolute/path/to/provider-extension \
   -e /absolute/path/to/pi-multiprovider/extensions/multiprovider.ts
```

</details>

## Quick start

Start Pi after installing both extensions, then run:

```text
/multilogin
```

The flow:

1. Searches providers and authentication methods exactly where Pi's `/login` UI does.
2. Opens the pool manager, a settings view mirroring Pi's `/settings`: fuzzy search, inline value cycling, and drill-in submenus.
3. The **Add account** row asks for a non-secret label and runs the provider's own login implementation—including pasting an API key for providers without an interactive flow—then returns to the manager.
4. Every other row edits live settings: pool strategy and session affinity, the **Pi default** upstream entry, each stored account, and scheduler cooldowns.

Add as many accounts as you need from the same manager. Remove credentials from an account's submenu or with `/multilogout`; Pi's regular `/logout` and `auth.json` remain independent.

### Commands

| Command | Purpose |
| --- | --- |
| `/multilogin [provider]` | Open the pool manager: strategy, affinity, upstream, account, and scheduler settings, plus adding or removing accounts. |
| `/multilogout [provider]` | Remove an account saved by `/multilogin`. |
| `/accounts` | Inspect pool policy, account status, in-flight leases, failures, and cooldowns. |

## Pool strategies

| Strategy | Selection behavior | Good for |
| --- | --- | --- |
| **Round robin** | Rotates through healthy account IDs. | Even distribution across similar accounts. |
| **Weighted round robin** | Uses smooth weighted scheduling. | Accounts with different quotas or spend limits. |
| **Least in flight** | Selects the healthy account with the least active work. | Concurrent agents and uneven request duration. |
| **Priority failover** | Uses the lowest-priority number until it becomes unhealthy. | Primary/backup credentials. |

Session affinity can pin a healthy account to the current Pi session. Explicit retry exclusions always win, so a rejected account is not selected twice for the same logical request. Switch strategies, affinity, and per-account weight and priority at any time inside `/multilogin`.

## How auth merging works

Pi still owns its one normal provider credential. Multiprovider owns additional credentials:

```text
~/.pi/agent/auth.json                    Pi /login and normal credential
~/.pi/agent/multiprovider-auth.json      extra pooled credentials
```

`PI_CODING_AGENT_DIR` relocates both files in the usual way. The multiprovider file is:

- created with mode `0600`
- written through same-directory atomic renames
- protected by a cross-process lock with stale-lock recovery
- versioned for future migrations
- never included in `/accounts` snapshots or logs

API-key credentials use the provider's native `resolve()` method, including provider-scoped environment values. OAuth credentials use the provider's native `login()`, `refresh()`, and `toAuth()` methods; refresh runs under the account-store lock with Pi's five-minute validity window.

When **Pi default** is enabled, the lifted auth method first lets Pi resolve its normal credential. Multiprovider marks only the names—not values—of credential-specific headers and environment fields. If a stored account is selected, stale upstream auth fields and credential-specific base URLs are removed before transport.

The **Pi default** entry is editable inside `/multilogin` like any pooled account: relabel it, raise or lower its weight (default 1) and priority (default 0), or exclude it from the pool entirely so only multilogin accounts run. Pool, account, upstream, and scheduler settings persist alongside the credentials in `multiprovider-auth.json`. The manager's **Scheduler** section overrides the global failure cooldowns live: rate limit (60s), quota (15m), auth (5m), transient base (1s, doubling per consecutive failure), and the 60m cap.

## Failover semantics

An account can be retried when all of these are true:

1. The provider failed before text, thinking, or tool-call output became visible.
2. The failure is account-local or transient.
3. Another enabled account is healthy and has not been attempted.

Default retry classes include:

- HTTP `401`/`403`, invalid keys, tokens, grants, or expired credentials
- HTTP `402`, quota exhaustion, or out-of-credit messages
- HTTP `429`, rate limits, overload, or too-many-requests responses
- HTTP `408`, `425`, and `5xx` transient failures

The lift sets provider-local retries to zero by default so there is one retry owner. Provider integrations can override classification and cooldown duration.

### Real ZRO proof

The implementation was exercised against the actual sibling `pi-zro-provider` and two independently stored LocalTerm credentials. Secret values were passed only through process environment into isolated mode-`0600` test stores and were never printed.

| Probe | Result |
| --- | --- |
| First stored ZRO API key, no `ZRO_API_KEY` environment fallback | `ZRO_FIRST_OK` |
| Second stored ZRO API key, no `ZRO_API_KEY` environment fallback | `ZRO_SECOND_OK` |
| Priority-1 synthetic invalid key → priority-2 valid key, same `zro/deepseek-v4-flash-0731` stream | `ZRO_FAILOVER_OK` |

The package also has direct Pi runtime probes and 21 deterministic tests covering scheduling, stream integrity, cancellation, secure storage, concurrent mutation, OAuth refresh locking, upstream auth scrubbing, upstream preference persistence, scheduler settings, pool-only availability, and simulated API-key/OAuth login flows.

## Provider integration API

The built-in managed store works with native providers and legacy `pi.registerProvider()` configurations composed by Pi. Providers with an existing account inventory can register their own opaque references instead:

```ts
import { registerMultiProvider } from "pi-multiprovider";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function providerExtension(pi: ExtensionAPI) {
  registerMultiProvider(pi, {
    id: "example",
    label: "Example",
    accounts: async () => [
      {
        id: "work",
        label: "Work",
        authKind: "api-key",
        credentialRef: "opaque:work",
        weight: 2,
        priority: 1,
      },
      {
        id: "backup",
        label: "Backup",
        authKind: "oauth",
        credentialRef: "opaque:backup",
        priority: 2,
      },
    ],
    async resolveAuth(account, signal) {
      return resolveProviderOwnedCredential(account.credentialRef, signal);
    },
  });
}
```

Credential references are intentionally opaque. Account inventory, refresh, billing, quota, and provider-specific metadata remain provider-owned. Re-announce after a provider re-registers dynamically; the bundled extension also reconciles its lift before every agent run.

For direct composition, the public package exports `MultiProviderService`, `liftProvider`, `MultiAuthStore`, `createManagedIntegration`, `mergeProviderAuth`, and all scheduler/integration types.

## Safety boundaries

- **No replay after output.** A failure after any content event is surfaced unchanged.
- **No secret snapshots.** Public account state contains labels and health only, never credential references or credential values.
- **Case-insensitive header replacement.** Selected auth replaces matching headers and can remove obsolete auth fields.
- **Lease lifetime equals stream lifetime.** Success, failure, and cancellation release capacity exactly once.
- **Provider re-registration is expected.** The extension re-lifts current provider objects before agent execution, covering dynamic model refreshes used by provider packages.
- **Health is in memory.** Cooldowns and affinity reset when Pi reloads or replaces the extension runtime; credentials and pool settings persist.

Current limits:

- Deferred fetch/cancel operations are not lifted yet; `stream` and `streamSimple` are the supported failover paths.
- A broken or revoked OAuth credential in Pi's primary `auth.json` can fail during Pi's pre-stream refresh before account selection. Run `/logout` for that provider or repair the primary login; extra pooled OAuth refreshes are independently isolated.
- If both a stored pool and a provider-owned integration register for one ID, the stored pool wins and Pi displays a warning.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

The full release gate is:

```bash
pnpm run check
npm pack --dry-run
```

See [SECURITY.md](SECURITY.md) for the local credential threat model and private vulnerability reporting.

## Acknowledgments

- Inspired by [hjanuschka/pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass), while keeping one provider identity and moving retries down to the stream boundary.
- Scheduler and credential-ownership semantics mirror the lift used by [`dsh-multiprovider`](../dsh-multiprovider) during local development.
- Built on Pi's native `Provider`, auth interaction, and TUI component APIs.

## License

MIT
