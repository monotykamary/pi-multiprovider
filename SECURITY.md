# Security Policy

## Supported versions

Security fixes are applied to the latest published release.

## Credential storage

`pi-multiprovider` stores additional provider credentials in `multiprovider-auth.json` under Pi's agent directory. Like Pi's own `auth.json`, this file contains plaintext credentials and relies on local filesystem protections:

- the file is created and rewritten with mode `0600`
- writes use an atomic same-directory rename
- mutations use a cross-process lock directory with uniquely named owner records; only confirmed-dead local owners are reclaimed, and live owners are never expired by age
- credentials never appear in public scheduler snapshots

After upgrading from a version that used a regular `.lock` file, stop all Pi processes before removing any leftover `multiprovider-auth.json.lock` file. The new lock protocol fails closed on legacy lock files rather than risking another process's credentials. A lock owned by another host or a reused PID is not automatically reclaimed; confirm the owner has stopped before manually removing it. Run the same extension version in processes sharing an auth store.

Do not commit this file, copy it into bug reports, or expose it to untrusted local users. Set `PI_CODING_AGENT_DIR` to a private directory when running in shared or ephemeral environments.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, auth files, request headers, OAuth tokens, or reproducible secret material.

Include the affected version, provider/auth type, impact, and a redacted reproduction. Synthetic credentials are preferred.
