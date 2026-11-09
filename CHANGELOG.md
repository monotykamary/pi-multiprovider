# Changelog

## 0.12.2

- Load the login, pool-manager and virtual-provider editor UI when `/multilogin` or `/vprovider` first runs instead of at startup. Restored virtual and pooled models are still registered before readiness.
- Read each backing catalog once per virtual catalog read and refresh virtual providers once per reconcile.

## 0.10.2

- Validate Pi 1.0.0 with exact development pins and wildcard host peers.
- Extend offline real-host probes through session startup and repeated shutdown; retain native provider delegation and failover behavior.

## 0.10.1

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
