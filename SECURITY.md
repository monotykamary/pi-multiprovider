# Security Policy

## Supported versions

Security fixes are applied to the latest published release.

## Credential storage

`pi-multiprovider` stores additional provider credentials in `multiprovider-auth.json` under Pi's agent directory. Like Pi's own `auth.json`, this file contains plaintext credentials and relies on local filesystem protections:

- the file is created and rewritten with mode `0600`
- writes use an atomic same-directory rename
- mutations use a cross-process lock
- credentials never appear in public scheduler snapshots
- usage snapshots are cached in memory only and never include credentials
- usage adapter errors redact resolved API keys and credential header values

Do not commit this file, copy it into bug reports, or expose it to untrusted local users. Set `PI_CODING_AGENT_DIR` to a private directory when running in shared or ephemeral environments.

Usage refreshes send each account's resolved credential to the corresponding provider usage or billing endpoint. They do not send credentials to QuotaBar or any pi-multiprovider service. Quota-aware background refresh is disabled until it is explicitly enabled for a pool.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, auth files, request headers, OAuth tokens, or reproducible secret material.

Include the affected version, provider/auth type, impact, and a redacted reproduction. Synthetic credentials are preferred.
