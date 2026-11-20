# Opensteer Cloud Computer Operations

This runbook is for the Opensteer operator who runs Opensteer Cloud Computer.

## What runs where

Three components run the managed service:

1. **Account service** (`apps/control-plane`) runs in Kubernetes (`opensteer-system`, two replicas by default) backed by PostgreSQL. It owns customer billing, Stripe webhooks, desired state, the backup target pool, the egress endpoint pool, the reconciler lease, and automatic claiming of each new Home.
2. **Home reconciler** (`apps/home-provisioner`) runs in Kubernetes (`opensteer-system`) as a single replica (`replicas: 1`, `Recreate` strategy) using a dedicated Google service account. It polls Account for desired state, creates and powers Hetzner VMs, manages Cloudflare DNS records, and verifies each Home's pinned identity.
3. **One VM per customer** runs on Hetzner Cloud (Ubuntu 24.04 LTS). Cloud-init downloads the signed-by-hash standalone installer, exchanges the bootstrap token with Account, starts seven Docker Compose services (`postgres`, `host`, `gateway`, `runner`, `browser-runtime`, `browser-egress`, `channel-runtime`), and calls `boot-complete`.

External provider accounts involved:

- **Google Cloud**: runs Account and the reconciler, stores runtime secrets, and provides the reconciler's workload identity token.
- **Stripe**: handles Checkout, the Billing Portal, recurring subscriptions, and webhooks.
- **Hetzner Cloud**: hosts one VM per customer and the shared `opensteer-cloud-computers` firewall.
- **Cloudflare**: hosts the DNS zone for customer Home hostnames (`OPENSTEER_CLOUD_COMPUTER_DOMAIN`).
- **S3-compatible object storage**: stores encrypted daily restic backups, with one isolated principal and non-overlapping prefix per Cloud Computer.
- **Static browser egress proxy provider**: supplies one HTTPS proxy endpoint and credential set per Cloud Computer.

```text
Customer (Desktop / Mobile / Web)
  |  /v1/account/cloud-computers/*
  v
+----------------------------------------+      Stripe webhooks
| Account service (2 replicas + Postgres)| <--- POST /v1/cloud-computers/stripe-webhook
|  - Billing reconciler (every 60 s)     | ---> Stripe API (2026-11-18.endive)
|  - Home claimer (every 5 s)            |
+----------------------------------------+
   ^                       ^     |
   | Lease, desired,       |     | POST /v1/managed-home/claim
   | check, status         |     | GET /.well-known/opensteer
   | (GCP workload JWT)    |     v
+------------------------+ |  +---------------------------------------------+
| Home reconciler (1 pod)| |  | Customer VM on Hetzner (Ubuntu 24.04)       |
|  - Hetzner API         |-|--|  - cloud-init -> opensteer-home-managed     |
|  - Cloudflare API      | +--|  - POST /v1/cloud-computers/:id/boot        |
|  - Pinned TLS probe    |    |  - POST /v1/cloud-computers/:id/boot-complete
+------------------------+    |  - Docker Compose: postgres, host, gateway, |
                              |    runner, browser-runtime, browser-egress, |
                              |    channel-runtime                          |
                              |  - Daily backup -> exclusive S3 prefix      |
                              |  - Browser traffic -> exclusive egress proxy|
                              +---------------------------------------------+
```

## First-time setup

### Account service environment

Cloud Computer turns on in Account as soon as any `OPENSTEER_CLOUD_COMPUTER_*` variable is present. Every `OPENSTEER_CLOUD_COMPUTER_*` variable also accepts a `<NAME>_FILE` variant that reads the value from a file and trims trailing whitespace. Setting both `<NAME>` and `<NAME>_FILE` fails startup.

In the Kubernetes manifest, put non-secret settings in the `account-env` ConfigMap and Stripe secrets in the existing `opensteer-account-runtime` JSON secret. Use the base names as JSON keys, such as `OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY`. The init container stages present `OPENSTEER_CLOUD_COMPUTER_*` and `OPENSTEER_ORGANIZATION_*` keys as mode `0600` files. Account uses the file when there is no explicit environment or `_FILE` setting for that key. Publish a new version of the runtime secret and point the manifest's SecretProviderClass to it when the values change.

To enable organization seats, set `OPENSTEER_ORGANIZATION_STRIPE_PRICE_ID` to a recurring price distinct from the personal price, plus `OPENSTEER_ORGANIZATION_CURRENCY` and `OPENSTEER_ORGANIZATION_PRICE_MINOR`. `OPENSTEER_ORGANIZATION_PRICE_INTERVAL` defaults to `month`. Organization billing uses the same Stripe credentials and webhook as personal Cloud Computers. Set `OPENSTEER_ORGANIZATION_STRIPE_PORTAL_CONFIGURATION_ID` to a separate, non-default portal configuration that enables only payment method updates and invoice history.

When an organization admin creates an invitation, the website shows a link for the admin to share with the invitee. Sending the link is manual. The invitee accepts while signed in with the invited, verified email address.

Account also requires its core variables to be valid for Cloud Computer: `OPENSTEER_CONTROL_PLANE_DATABASE_URL`, `OPENSTEER_CONTROL_PLANE_PUBLIC_URL` (must be `https://`), `OPENSTEER_PORTAL_ORIGIN` (must be `https://` and differ from the Account origin), and `OPENSTEER_ADOPTION_OPERATION_KEY` (seals pool credentials, bootstrap tokens, setup codes, at rest). `OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL` must differ from `OPENSTEER_HOSTED_TEAMS_PROVISIONER_EMAIL`.

| Env var                                                   | Meaning                                                                                         | Required | Default | Secret source          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------- | ------- | ---------------------- |
| `OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL`              | Google service account email (`*.iam.gserviceaccount.com`) allowed to call reconciler routes    | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_DOMAIN`                         | DNS suffix for Home hostnames (lowercase DNS name, max 214 chars)                               | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_REGION`                         | Hetzner location assigned to new Cloud Computers                                                | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE`                    | Hetzner server type assigned to new Cloud Computers                                             | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_RELEASE_JSON`                   | JSON release manifest (`version`, `installerUrl`, `installerSha256`, `images`)                  | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL`           | Public HTTPS feed for digest-pinned in-place updates                                            | No       | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY`              | Stripe secret or restricted key (`sk_live_...`, `rk_live_...`, `sk_test_...`, or `rk_test_...`) | Yes      | None    | Secret (`_FILE` mount) |
| `OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET`          | Stripe webhook signing secret (`whsec_...`)                                                     | Yes      | None    | Secret (`_FILE` mount) |
| `OPENSTEER_CLOUD_COMPUTER_STRIPE_PRICE_ID`                | Recurring Stripe Price ID (`price_...`) used in Checkout                                        | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_STRIPE_PORTAL_CONFIGURATION_ID` | Dedicated Stripe Customer Portal configuration (`bpc_...`)                                      | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_PLAN_NAME`                      | Customer-visible plan name (1–120 chars)                                                        | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_CURRENCY`                       | Three-letter lowercase ISO currency code (for example `usd`)                                    | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_PRICE_MINOR`                    | Positive integer price in minor currency units (for example `2000` for `$20.00`)                | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_PRICE_INTERVAL`                 | Billing interval (`day`, `week`, `month`, or `year`)                                            | No       | `month` | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_IPV6`                           | Publish IPv6 `AAAA` records and enable IPv6 Compose ports (`off` or `on`)                       | No       | `off`   | ConfigMap / non-secret |

Set `OPENSTEER_CLOUD_COMPUTER_BACKUP_KEY_PROJECT` to a dedicated Google Cloud project before enabling sales. Enable Secret Manager and grant the Account workload identity permission to create secrets, add/access versions, and delete secrets there. PostgreSQL records the key version. The repository passwords live in Secret Manager and on the owning VM. Per-Home secrets use the `opensteer-backup-cc_…` prefix and are destroyed with all versions on final deletion. Keep historical repository passwords out of operational exports and database backups.

### Home reconciler environment

Run `apps/home-provisioner` with `deploy/home-provisioner/deployment.yaml` (`replicas: 1`, `strategy.type: Recreate`). The pod authenticates to Account with a Google workload identity token fetched from `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity` for the Account origin audience. `OPENSTEER_HOME_HETZNER_TOKEN` and `OPENSTEER_HOME_CLOUDFLARE_TOKEN` each accept a `_FILE` variant.

| Env var                               | Meaning                                                                       | Required | Default  | Secret source                 |
| ------------------------------------- | ----------------------------------------------------------------------------- | -------- | -------- | ----------------------------- |
| `OPENSTEER_ACCOUNT_URL`               | Bare `https://` origin of the Account service                                 | Yes      | None     | Deployment secret/env         |
| `OPENSTEER_HOME_DEFAULT_REGION`       | Fallback Hetzner location when a desired record has `region: null`            | Yes      | None     | Deployment secret/env         |
| `OPENSTEER_HOME_DEFAULT_SERVER_TYPE`  | Fallback Hetzner server type when a desired record has `serverType: null`     | Yes      | None     | Deployment secret/env         |
| `OPENSTEER_HOME_IMAGE`                | Hetzner OS image name or numeric ID (Ubuntu 24.04 LTS)                        | Yes      | None     | Deployment secret/env         |
| `OPENSTEER_HOME_HETZNER_TOKEN`        | Hetzner Cloud API token                                                       | Yes      | None     | Secret (`_FILE` or SecretRef) |
| `OPENSTEER_HOME_CLOUDFLARE_TOKEN`     | Cloudflare API token                                                          | Yes      | None     | Secret (`_FILE` or SecretRef) |
| `OPENSTEER_HOME_CLOUDFLARE_ZONE_ID`   | Cloudflare 32-character hex zone ID for `OPENSTEER_CLOUD_COMPUTER_DOMAIN`     | Yes      | None     | Deployment secret/env         |
| `OPENSTEER_HOME_PROVISIONER_REPLICAS` | Safety guard; must equal `"1"` or the process refuses to start                | No       | `1`      | Deployment manifest           |
| `OPENSTEER_HOME_INTERVAL_MS`          | Poll interval in milliseconds (`1000`–`300000`)                               | No       | `10000`  | Deployment secret/env         |
| `OPENSTEER_HOME_REQUEST_TIMEOUT_MS`   | Per-HTTP-request timeout in milliseconds (`100`–`60000`)                      | No       | `15000`  | Deployment secret/env         |
| `OPENSTEER_HOME_ACTION_TIMEOUT_MS`    | Hetzner server action timeout in milliseconds (`1000`–`600000`)               | No       | `90000`  | Deployment secret/env         |
| `OPENSTEER_HOME_READINESS_TIMEOUT_MS` | Max wait for a Home to become ready in milliseconds (`1000`–`3600000`)        | No       | `600000` | Deployment secret/env         |
| `OPENSTEER_HOME_ORPHAN_GRACE_MS`      | Grace period before deleting orphaned VMs or DNS records (`60000`–`86400000`) | No       | `300000` | Deployment secret/env         |
| `OPENSTEER_HOME_CONCURRENCY`          | Max Cloud Computers reconciled in parallel (`1`–`16`)                         | No       | `4`      | Deployment secret/env         |

### Home VM environment (on each VM)

Managed VMs receive their configuration automatically during boot and store it under `/etc/opensteer-home/` (`config.env`, `images.env`, `secrets/*`). The variables below are used by `opensteer-home` on the VM for maintenance or manual recovery.

| Env var                               | Meaning                                                                                | Required | Default                                                                                        | Secret source                    |
| ------------------------------------- | -------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| `OPENSTEER_HOME_DIR`                  | Home configuration directory on the VM (root-owned, mode `0700`)                       | No       | `/etc/opensteer-home`                                                                          | Local shell / systemd unit       |
| `OPENSTEER_HOME_RELEASE_MANIFEST_URL` | HTTPS release manifest URL checked by `opensteer-home scheduled-update` (hourly timer) | No       | Unset                                                                                          | `/etc/opensteer-home/config.env` |
| `OPENSTEER_HOME_RESTIC_IMAGE`         | Restic container image used by `backup` and `restore`                                  | No       | `restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76` | Local shell                      |
| `RESTIC_REPOSITORY_FILE`              | Override path to restic repository URL file for manual `backup` / `restore`            | No       | `/etc/opensteer-home/secrets/backup_repository`                                                | Local root-only file             |
| `RESTIC_PASSWORD_FILE`                | Override path to restic encryption password file                                       | No       | `/etc/opensteer-home/secrets/backup_password`                                                  | Local root-only file             |
| `AWS_ACCESS_KEY_ID_FILE`              | Override path to S3 access key ID file                                                 | No       | `/etc/opensteer-home/secrets/backup_accessKeyId`                                               | Local root-only file             |
| `AWS_SECRET_ACCESS_KEY_FILE`          | Override path to S3 secret access key file                                             | No       | `/etc/opensteer-home/secrets/backup_secretAccessKey`                                           | Local root-only file             |

### Provider and release setup

1. **Stripe**:
   - Create one active recurring Stripe Price with `usage_type: licensed` and `interval_count: 1`. Its `currency`, `unit_amount`, and `recurring.interval` must match `OPENSTEER_CLOUD_COMPUTER_CURRENCY`, `OPENSTEER_CLOUD_COMPUTER_PRICE_MINOR`, and `OPENSTEER_CLOUD_COMPUTER_PRICE_INTERVAL`. Account verifies this against Stripe at startup and every 60 seconds; checkout returns HTTP `503` until the offer validates.
   - Account pins Stripe API version `2026-11-18.endive` and creates Checkout Sessions with `allowed_payment_method_types[0]=card` and `payment_method_collection=always`.
   - Create a dedicated non-default Stripe Customer Portal configuration. Enable payment-method updates and subscription cancellation. Disable subscription changes, customer updates and invoice history. Set its ID in Account configuration.
   - Create a webhook endpoint pointing to `https://<account-origin>/v1/cloud-computers/stripe-webhook` subscribed to these seven events:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.expired`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.paid`
     - `invoice.payment_failed`
   - Store the webhook signing secret in `OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET_FILE` and the API key in `OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY_FILE`.
2. **Hetzner Cloud**:
   - Use a dedicated Hetzner Cloud project for Cloud Computers.
   - Create a Read & Write API token for that project (the reconciler manages `/v1/servers`, `/v1/actions`, and `/v1/firewalls`).
   - Pick a valid location (for example `fsn1`), server type, and Ubuntu 24.04 LTS image (`OPENSTEER_HOME_IMAGE`). Ubuntu 24.04 LTS lets the managed installer install missing Docker and tool packages automatically.
   - On first run, the reconciler creates and maintains firewall `opensteer-cloud-computers` (label `opensteer.com/managed-by=home-provisioner`) allowing inbound TCP `80` and `443` from `0.0.0.0/0` and `::/0`.
3. **Cloudflare**:
   - Create or choose the DNS zone for `OPENSTEER_CLOUD_COMPUTER_DOMAIN` and record its 32-hex zone ID in `OPENSTEER_HOME_CLOUDFLARE_ZONE_ID`.
   - Create an API token with `Zone:DNS:Edit` restricted to that single zone.
   - The reconciler creates unproxied (`proxied: false`, `ttl: 1`) `A` records (and `AAAA` records only when `OPENSTEER_CLOUD_COMPUTER_IPV6=on`) stamped with the comment `Opensteer Cloud Computer`. Keep customer subdomains free of pre-existing `CNAME`, `A`, or `AAAA` records.
4. **Release (installer and container images)**:
   - Build and push the six Home container images from `deploy/container/docker-bake.hcl` (`home` group: `host`, `runner`, `browser-runtime`, `browser-egress`, `channel-runtime`, `gateway`) and collect their immutable `@sha256:<64-hex>` digests.
   - Package the standalone installer:

     ```bash
     bash deploy/home/package-installer.sh /path/to/opensteer-home-installer.sh
     sha256sum /path/to/opensteer-home-installer.sh
     ```

   - Host `opensteer-home-installer.sh` at a clean HTTPS URL with no credentials, query string, or fragment.
   - Set `OPENSTEER_CLOUD_COMPUTER_RELEASE_JSON` to a JSON object with this exact shape:

     ```json
     {
       "version": "1.2.3",
       "installerUrl": "https://releases.opensteer.com/home/1.2.3/opensteer-home-installer.sh",
       "installerSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
       "images": {
         "host": "ghcr.io/steerlabs/opensteer-home-host@sha256:...",
         "runner": "ghcr.io/steerlabs/opensteer-home-runner@sha256:...",
         "browser-runtime": "ghcr.io/steerlabs/opensteer-home-browser-runtime@sha256:...",
         "browser-egress": "ghcr.io/steerlabs/opensteer-home-browser-egress@sha256:...",
         "channel-runtime": "ghcr.io/steerlabs/opensteer-home-channel-runtime@sha256:...",
         "gateway": "ghcr.io/steerlabs/opensteer-home-gateway@sha256:..."
       }
     }
     ```

5. **Pools**:
   - Before opening sales, add backup targets and browser egress endpoints using the commands in the next section. Checkout fails immediately if no unreserved, rotation-clean backup target is free.

## Filling the pools

The operator CLI lives in the Account image as `dist/cloud-computer-operator-main.js`. Run it with the full Account environment loaded (including `OPENSTEER_CONTROL_PLANE_DATABASE_URL`, `OPENSTEER_ADOPTION_OPERATION_KEY`, and all `OPENSTEER_CLOUD_COMPUTER_*` variables):

```bash
node dist/cloud-computer-operator-main.js <command> [args...]
```

Commands print JSON to stdout. Invalid operations print an error to stderr and exit `1`. Run `node dist/cloud-computer-operator-main.js --help` for command syntax.

### Diagnostics and recovery

| Command                     | What it shows or changes                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list` / `show <id>`        | Account and work assignment IDs, desired state and observed phase, generation and revision, hostname, current and previous provider server IDs, IPs, pinned deployment ID and key fingerprint, bootstrap expiry and completion, deletion intent and tombstone, billing and egress status, claim attempt/receipt/error, and last reconciler error. |
| `lease-show`                | Holder UUID, expiry, and whether the lease expired. Returns `null` if no lease is recorded.                                                                                                                                                                                                                                                       |
| `lease-release <holder>`    | Removes the named holder's lease only after expiry. A renewed lease or a different holder is refused.                                                                                                                                                                                                                                             |
| `checkout-list`             | Open attempts known to be paid and deferred webhook completions, with Account and Stripe IDs for investigation. Checkout URLs and raw event bodies are omitted.                                                                                                                                                                                   |
| `billing-reconcile`         | Runs the same personal and organization billing reconciliation as the Account worker. `ran: false` means another worker holds the billing lock. Inspect the `errors` array even when `ran: true`.                                                                                                                                                 |
| `claim-retry <computer-id>` | Clears a recorded claim failure on an active, provisioned Home, starts a fresh claim deadline, and queues it for the worker. Run after diagnosing the error. The existing Home identity and generation are retained.                                                                                                                              |

Claim error codes are `timeout`, `setup-failed`, and `claim-failed`. The operator output omits credentials and raw failure payloads.

### Reuse rule for released entries

After the provider confirms the VM and disk are gone, Account quarantines its egress endpoint and records every backup target to purge. A backup target shows `purgeComputerId` until Account confirms that prefix empty. During purge, rotation and removal are refused.

- A row with `needsRotation: true` is **never assigned** to another Cloud Computer.
- An unassigned, unreserved row can be removed even when `needsRotation: true`. Revoke its credentials upstream before removal. Removal retires the old backup prefix and prevents re-registering a removed proxy with its former password.
- Before rotating a released entry back into service:
  - For an **egress endpoint**, change the proxy password at the provider first, then run `egress-rotate` with the new password.
  - For a **backup target**, wait for Account to confirm object removal then revoke the previous S3 principal. Create a new principal scoped to a fresh, non-overlapping prefix. Run `backup-rotate` with the new `prefix`, `accessKeyId`, and `secretAccessKey`.

### Egress endpoints

Put the proxy password in a root-only file (`chmod 0600`) so it stays out of shell arguments. The CLI trims trailing whitespace.

- **List**:

  ```bash
  node dist/cloud-computer-operator-main.js egress-list
  ```

  Shows the endpoint ID, URL, username, optional public IP, assignment, and rotation status. Passwords are omitted.

- **Add** (`url` must be a bare `https://host:port` origin without credentials, path, query, or fragment; `username` and password max 255 chars):

  ```bash
  node dist/cloud-computer-operator-main.js egress-add https://egress-01.example.net:8443 proxyuser /path/to/egress-password.txt
  ```

  Returns `{"id":"<uuid>"}`.

- **Rotate** (only when `computerId` is `null` and `needsRotation` is `true`; password must differ from the previous password):

  ```bash
  node dist/cloud-computer-operator-main.js egress-rotate <endpoint-uuid> proxyuser /path/to/new-egress-password.txt
  ```

  Returns `{"rotated":true}`.

- **Remove** (only when unassigned; revoke the old proxy password with the provider first):

  ```bash
  node dist/cloud-computer-operator-main.js egress-remove <endpoint-uuid>
  ```

  Returns `{"removed":true}`.

- **Assign after boot** (requires an active, booted Home and a free endpoint):

  ```bash
  node dist/cloud-computer-operator-main.js egress-assign <computer-id>
  ```

  Returns the assigned endpoint ID and recorded public address. Repeating it returns the same assignment. A Home with egress refresh support consumes the assignment on its next refresh.

### Backup targets

Each backup target must have a unique S3 `accessKeyId` and a prefix that does not equal or nest inside any registered or retired target's prefix on the same `endpoint` and `bucket`. The existing credential must be able to list object versions and remove versions and delete markers under that exact prefix. Use S3-compatible storage that supports these operations, including on unused targets, and avoid retention locks that deny deletion. The optional `region` is the SigV4 signing region and defaults to `us-east-1`.

- **List**:

  ```bash
  node dist/cloud-computer-operator-main.js backup-list
  ```

  Shows the location, assignment, and rotation status. `reserved: true` marks a Checkout reservation. `reservation` shows its Account, request and Stripe session IDs, expiry and paid time when available.

- **Add**: write a mode `0600` JSON file containing these required fields and the optional signing region (`endpoint` is a bare `https://` origin, `bucket` is 3–63 lowercase characters, `prefix` matches `^[a-z0-9_-]+(?:/[a-z0-9_-]+)*$`, credentials max 255 chars):

  ```json
  {
    "endpoint": "https://s3.example.net",
    "bucket": "opensteer-home-backups",
    "prefix": "slot-0001",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "..."
  }
  ```

  ```bash
  node dist/cloud-computer-operator-main.js backup-add /path/to/backup-target.json
  ```

  Returns `{"id":"<uuid>"}`. Delete the temporary JSON file afterward.

- **Rotate** (only when `computerId` is `null`, not reserved by an open checkout, and `needsRotation` is `true`; `accessKeyId` must differ from the previous principal): write a mode `0600` JSON file containing a new prefix and new credentials:

  ```json
  {
    "prefix": "slot-0001-rotation-0002",
    "accessKeyId": "AKIA_NEW...",
    "secretAccessKey": "..."
  }
  ```

  ```bash
  node dist/cloud-computer-operator-main.js backup-rotate <target-uuid> /path/to/backup-rotate.json
  ```

  Returns `{"rotated":true}`. Delete the temporary JSON file afterward.

- **Remove** (only when unassigned and unreserved; revoke its S3 principal first):

  ```bash
  node dist/cloud-computer-operator-main.js backup-remove <target-uuid>
  ```

  Returns `{"removed":true}`.

## The life of one Cloud Computer

### Provisioning and first claim

1. **Checkout**:
   - The customer starts checkout through `POST /v1/account/cloud-computers/checkout` with a UUID `requestId`.
   - Account validates the Stripe offer and reserves capacity before creating a Checkout Session. Personal Checkout reserves one backup target. Organization Checkout reserves a target per unassigned seat, and a seat increase reserves the additional targets before it can charge.
   - Customer sees the checkout page in their browser; the app polls `GET /v1/account/cloud-computers` every 5 seconds.
2. **Desired state**:
   - Stripe sends `checkout.session.completed` (or `checkout.session.async_payment_succeeded`) to `POST /v1/cloud-computers/stripe-webhook`.
   - Account creates the `cc_<uuid>` record (`state: active`, `phase: provisioning`, `generation: 1`, `revision: 1`), binds the reserved backup target, generates a hostname `<token>.<OPENSTEER_CLOUD_COMPUTER_DOMAIN>`, generates a setup code and backup encryption password, and seals a bootstrap token.
   - Customer sees `status: "preparing"` ("Setting up") and `egress: "pending"`.
   - Operator can run `node dist/cloud-computer-operator-main.js show <id>` and see `phase: "provisioning"`.
3. **Server created**:
   - On its next poll (`GET /v1/cloud-computers/desired`), the reconciler sees the active record with no VM, verifies the revision via `POST /v1/cloud-computers/:id/check`, ensures the `opensteer-cloud-computers` firewall exists, creates Hetzner server `os-cc-<uuid>-1` (`start_after_create: false`) with labels `opensteer.com/cloud-computer=<id>` and `opensteer.com/generation=1`, powers it on, writes the Cloudflare `A` record (and `AAAA` if `ipv6Enabled`), and reports `phase: "booting"` with `providerServerId` and IP to `POST /v1/cloud-computers/:id/status`.
   - Reporting `providerServerId` starts the 20-minute bootstrap token timer in Account.
   - Customer still sees `status: "preparing"`.
4. **Boot**:
   - Cloud-init writes `/root/opensteer-home-boot.json` and `/run/opensteer-home-bootstrap-token`, downloads `installerUrl`, checks `installerSha256`, and runs the installer.
   - The installer stages `/etc/opensteer-home/boot/*` and starts `opensteer-home-managed.service`, which retries until completion (stopping on exit `78` if the token is rejected).
   - `managed-boot.sh boot` calls `POST /v1/cloud-computers/:id/boot` with `{ hostname, bootstrapToken }`.
   - Account validates the token, assigns one free egress endpoint (or sets `egressUnavailable` if the pool is empty), registers an OIDC client for the Home, and returns the pinned release images, setup code digest, OIDC client credentials, egress credentials (if assigned), and backup repository credentials.
   - The VM pulls the six images, applies AppArmor/seccomp policies and the pod `iptables`/`ip6tables` firewall, and starts all seven Compose containers.
   - Customer sees `status: "preparing"` and `egress: "assigned"` (or `"unavailable"`).
5. **Boot-complete**:
   - Once all containers are healthy, the installer reads the local Host discovery document (`/.well-known/opensteer` on loopback) and calls `POST /v1/cloud-computers/:id/boot-complete` with `{ hostname, bootstrapToken, identity: { deploymentId, hostKeyFingerprint } }`.
   - Account pins that `deploymentId` and `hostKeyFingerprint`, marks `bootCompletedAt` and clears the bootstrap token. The subsequent accepted `ready` report marks the generation ready.
   - The VM enables `opensteer-home.service`, the daily backup timer, and the maintenance timer, then deletes the bootstrap token and boot result files. With installer support for `releaseManifestUrl`, a configured feed also enables the hourly update timer.
6. **Ready**:
   - On its next poll, the reconciler makes a direct HTTPS request to the VM's IP using the Home hostname as SNI and `Host`, verifies the signed `/.well-known/opensteer` envelope matches the pinned `deploymentId` and `hostKeyFingerprint`, and reports `phase: "ready"` to Account.
   - Customer still sees `status: "preparing"` until Account finishes claiming the Home.
7. **Claimed for its buyer**:
   - Account's background claimer (runs every 5 seconds) resolves the hostname once and, over one pinned TLS connection that follows no redirect, reads `https://<hostname>/.well-known/opensteer`, verifies it matches the pinned identity, signs an EdDSA managed-Home claim assertion naming the Host instance that answered, and only then sends `POST /v1/managed-home/claim` with the sealed setup code and Account link credential.
   - The Home verifies the assertion, commits the owner and Account link, and returns a Host-signed claim receipt that names the digest of the link credential it installed. The same claim again returns that receipt; with a different credential it is refused.
   - The Opensteer Account stays this Home's sign-in authority by design: the owner signs in through it, a different Account subject can never claim the Home, and the Home's link to the Account cannot be removed (deleting the Cloud Computer ends it).
   - Account verifies the receipt, registers the Home in `deployments` for the buyer, and records `bootstrapReceiptAt`.
   - Customer now sees `status: "ready"` ("Running") with `address: "https://<hostname>"`, and the Home appears in their Opensteer list.
   - Operator can run `node dist/cloud-computer-operator-main.js show <id>` (`phase: "ready"` and a non-null `claim.receiptAt`) or on the VM run `sudo opensteer-home status` (prints `Version ...`, `docker compose ps`, and `Claimed`).

### Suspend, resume, cancel, resubscribe, delete

- **Suspend**:
  - Owner calls `POST /v1/account/cloud-computers/:id/suspend` (sets `ownerSuspended`), operator runs `node dist/cloud-computer-operator-main.js suspend <id> <reason>` (sets `operatorSuspension`), or Stripe reports non-active billing (`past_due`, `unpaid`, `canceled`, etc.).
  - Account moves `state` to `suspended` and `phase` to `provisioning`.
  - Reconciler removes the Cloudflare DNS record, requests a graceful Hetzner shutdown (waits up to 30 seconds or `OPENSTEER_HOME_ACTION_TIMEOUT_MS`, whichever is shorter), forces `poweroff` if still running, and reports `phase: "suspended"`. Data and disks stay intact.
  - Customer sees `status: "suspended"` with the reason (`"You paused this Cloud Computer."`, `"Your subscription ended."`, `"Your subscription needs attention."`, or the operator's reason text).
- **Resume**:
  - Owner calls `POST /v1/account/cloud-computers/:id/resume` (clears `ownerSuspended`), operator runs `node dist/cloud-computer-operator-main.js unsuspend <id>` (clears `operatorSuspension`), or Stripe reports `active` billing again.
  - Only when all three conditions are clear (no owner pause, no operator suspension, active billing) does Account move `state` back to `active`.
  - Reconciler powers on the existing Hetzner VM, restores the Cloudflare DNS record, verifies the pinned Home identity, and reports `phase: "ready"`.
  - Customer sees `status: "preparing"` while it boots, then `status: "ready"`.
- **Cancel**:
  - Customer cancels in the Stripe Billing Portal (`POST /v1/account/cloud-computers/billing-portal`).
  - When Stripe sends `customer.subscription.deleted` (or the 60-second billing reconciler sees `canceled`), Account sets `billingStatus: "canceled"` and suspends the VM. Billing never deletes the VM or backups.
  - Customer sees `status: "suspended"` with reason `"Your subscription ended."`.
- **Resubscribe**:
  - While the canceled Home is still suspended (not deleted), the customer starts a new checkout (`POST /v1/account/cloud-computers/checkout`).
  - Account does not reserve a second backup target; when the new subscription completes, Account attaches the new Stripe subscription to the existing Cloud Computer and sets `state: "active"`.
  - Reconciler powers on the existing VM and restores DNS; customer sees `status: "preparing"`, then `status: "ready"`.
- **Delete**:
  - Owner calls `DELETE /v1/account/cloud-computers/:id` with `{"confirmation":"DELETE:<id>"}`, or operator runs `node dist/cloud-computer-operator-main.js delete <id>`.
  - Account marks `deletionRequestedAt`, cancels the Stripe subscription first, and once Stripe confirms cancellation transitions `state: "deleted"`, `phase: "deleting"`, removes the Home from `deployments` and deletes its OIDC client.
  - Reconciler removes the Cloudflare DNS record, deletes the Hetzner server, waits until it is absent, and reports `phase: "deleted"`.
  - Account records the provider confirmation, then destroys the Home's Secret Manager secret. It records the tombstone and reports `status: "deleted"` only when both facts are confirmed.
  - Account purges stored object versions and delete markers using the corresponding Home's own S3 credential, including retired targets. It confirms removal with a fresh empty listing before releasing the target for rotation. A durable purge reservation holds each target through failures. The provisioner never receives storage credentials.
  - The personal or organization page shows **Computer and disk destroyed**, **Backups made unreadable**, and **Stored backup data removed** with separate dates. An offboarded seat stops counting as assigned after the first two facts are confirmed. A free seat requires an independently reserved usable backup target.

## When something goes wrong

### Setup that never becomes ready

- **How to recognise it**: `show <id>` reports `phase: "failed"` with a `lastError` or a claim error under `claim.error` after the VM reaches `ready`. Account logs `Cloud Computer claim failed` on claim failures.
- **What the system does**: The reconciler retries transient provider/DNS/discovery errors on every pass until `OPENSTEER_HOME_READINESS_TIMEOUT_MS` elapses, then reports `phase: "failed"` with `lastError`. The claimer retries transient errors with exponential backoff (up to 60 seconds) for 60 minutes from `readinessStartedAt`, then records `claimError` and stops retrying.
- **What the operator does**:
  1. Check `show <id>`, Account logs (`Cloud Computer claim failed`), and reconciler logs (`home-provisioner.pass.failed`) to see whether provisioning, boot, discovery, or claiming failed.
  2. If the VM is reachable by console/SSH, inspect `systemctl status opensteer-home-managed.service`, `journalctl -u opensteer-home-managed.service`, and `sudo opensteer-home status` / `sudo opensteer-home logs <service>`.
  3. If the Home has never been ready, run `node dist/cloud-computer-operator-main.js reissue-bootstrap <id>` to rebuild it with a fresh bootstrap token.
  4. For a `ready` Home with a claim error, fix the underlying issue and run `claim-retry <computer-id>`. Use snapshot replacement if the previously ready personal Home cannot be recovered.

### Expired bootstrap token

- **How to recognise it**: Compare a non-null `bootstrapExpiresAt` in `show <id>` to the current time. Check `lastError` and the VM's `journalctl -u opensteer-home-managed.service` for a rejected boot credential (HTTP `401`, exit code `78`).
- **What the system does**: Bootstrap tokens expire 20 minutes after the reconciler first reports `providerServerId`. `opensteer-home-managed.service` has `RestartPreventExitStatus=78`, so it stops retrying once Account rejects the token. The reconciler stops trying to create a server without a token.
- **What the operator does**:
  - Run:

    ```bash
    node dist/cloud-computer-operator-main.js reissue-bootstrap <id>
    ```

  - If no create was dispatched and no boot credential was exchanged, Account renews the token in place. Once a VM was dispatched or boot exchanged credentials, reissue bumps the generation, clears the pin, and retires the issued egress and backup credentials. An unused backup target must be available.
  - A generation that reported ready must be replaced from a named backup snapshot.
  - If a never-ready replacement already exchanged credentials, prepare an unused registered backup target containing the named snapshot with a new repository password. Pass a mode `0600` JSON file with `{ "targetId": "<uuid>", "password": "<new repository password>" }` as the final argument to `reissue-bootstrap`. The existing repository and its credentials are then quarantined.

### Replacing a broken Home from a snapshot

- **How to recognise it**: A Home that was previously ready (`everReady`) is unrecoverable in place (corrupted disk, broken VM, failed host) and the customer needs a fresh VM restored from a known-good restic snapshot.
- **What the system does**: No automatic path ever replaces a ready Home.
- **What the operator does**:
  1. On the source VM, run `sudo opensteer-home snapshots` to find a restic snapshot ID (8–64 lowercase hex characters). It reads the repository using the VM's root-only credential files. Account has no snapshot list. If the source VM is unavailable, use a previously recorded snapshot ID or the existing backup recovery procedure with the repository credentials.
  2. Run:

     ```bash
     node dist/cloud-computer-operator-main.js replace <computer-id> <snapshot-id>
     ```

  3. Account bumps `generation`, stores `restoreSnapshot`, issues a fresh bootstrap token, removes the old deployment entry and OIDC client, and moves the record back to `provisioning`.
  4. The reconciler powers off the previous VM. The new VM restores the named snapshot before sending `boot-complete`. The reconciler verifies the pinned identity and Account claims the restored Home. The previous VM stays off until the owner completes a sign-in to the replacement, then the reconciler deletes it.
  5. Watch progress with `node dist/cloud-computer-operator-main.js show <computer-id>` until `phase` is `"ready"` and `claim.receiptAt` is set.

### Second reconciler started by mistake

- **How to recognise it**: Reconciler logs emit `{"event":"home-provisioner.lease.conflict","service":"Account","status":409}` on stderr, or a pod fails at startup if `OPENSTEER_HOME_PROVISIONER_REPLICAS` is not `"1"`.
- **What the system does**: Account holds a single-holder lease (`POST /v1/cloud-computers/lease`, header `x-opensteer-provisioner-lease`, 10-minute TTL). A second instance gets HTTP `409` on lease acquisition. Without the current lease the `desired`, `check`, and `status` routes return HTTP `403`.
- **What the operator does**:
  1. Scale the `home-provisioner` Deployment back to `1` replica and verify `strategy.type: Recreate` in `deploy/home-provisioner/deployment.yaml`.
  2. Terminate any stray pod or local process running `home-provisioner`.
  3. Run `lease-show`. If the previous holder died, wait until its lease expires. The surviving reconciler can then acquire it automatically. Use `lease-release <holder>` to clear the expired lease explicitly.

### Provider rate limits

- **How to recognise it**: Reconciler stderr logs `{"event":"home-provisioner.provider.rate-limited","service":"Hetzner","status":429,"retryAt":...}` or `"service":"Cloudflare"`.
- **What the system does**: The HTTP client parses `retry-after` and `ratelimit-reset` headers into `retryAt`. The Hetzner adapter sleeps until `retryAt` and retries once per request. If rate limiting persists, the reconciler fails the current item (`"The Cloud Computer provider operation failed."` or `"The Cloud Computer DNS operation failed."`) and retries on the next 10-second pass.
- **What the operator does**:
  1. Lower `OPENSTEER_HOME_CONCURRENCY` (default `4`, minimum `1`) or raise `OPENSTEER_HOME_INTERVAL_MS` (default `10000`) if bulk churn is saturating Hetzner or Cloudflare quotas.
  2. Verify no runaway loop or external tool is sharing the same Hetzner or Cloudflare API token.

### Account refusing the reconciler

- **How to recognise it**: Reconciler stderr logs `{"event":"home-provisioner.account.refused","service":"Account","status":401}` or `403`.
- **What the system does**: On Account `401` or `403`, the reconciler aborts the pass immediately, does not run the orphan sweep, and retries on the next interval.
- **What the operator does**:
  1. Check that the `home-provisioner` Kubernetes ServiceAccount is bound to the Google service account email configured in `OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL`.
  2. Check that `OPENSTEER_ACCOUNT_URL` in `home-provisioner` exactly matches `OPENSTEER_CONTROL_PLANE_PUBLIC_URL` in Account (the workload identity JWT audience must match).
  3. Confirm `OPENSTEER_CLOUD_COMPUTER_*` is still enabled in Account and that `OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL` is distinct from `OPENSTEER_HOSTED_TEAMS_PROVISIONER_EMAIL`.

### DNS or identity mismatch

- **How to recognise it**:
  - `show <id>` shows `lastError: "The Cloud Computer DNS operation failed."` (Cloudflare rejected a pre-existing `CNAME` or an `A`/`AAAA` record lacking the `Opensteer Cloud Computer` comment, or another DNS error occurred).
  - Or `show <id>` shows `"The Cloud Computer reported a different Home identity for this generation."` (reconciler probed the VM IP with SNI/Host and saw a different `deploymentId` or `hostKeyFingerprint` than the one pinned at `boot-complete`).
  - Or Account logs `Cloud Computer claim failed` with `The Cloud Computer answered as a different Home` and sets `status: "needs_attention"`, reason `"Your Cloud Computer couldn’t be set up for your Account. Contact support."`.
- **What the system does**: On an identity mismatch, the reconciler deletes the Cloudflare DNS record so traffic does not reach the wrong host, reports `phase: "failed"`, and stops publishing DNS. On a pre-existing foreign DNS record, Cloudflare calls fail closed without overwriting the foreign record.
- **What the operator does**:
  1. For a DNS conflict, inspect the hostname in the Cloudflare zone and remove the conflicting non-managed record if it is stale. The next reconciler pass will create the managed record.
  2. For an identity mismatch, do not point DNS back manually. Inspect the Hetzner server (`os-cc-<uuid>-<gen>`) and its `/etc/opensteer-home` state to find why its Host key or deployment ID changed.
  3. Rebuild the Home with `reissue-bootstrap <id>` (if never ready) or `replace <computer-id> <snapshot-id>` (if previously ready).

### Stripe outage during delete

- **How to recognise it**: `show <id>` has a `deletionRequestedAt` timestamp while billing has yet to reach `"canceled"`. The customer view reports that deletion is waiting for Stripe cancellation.
- **What the system does**: Account records `deletionRequestedAt` and refuses to delete the VM until Stripe confirms the subscription is canceled. Account's 60-second billing reconciler retries canceling the Stripe subscription on every pass. Once Stripe succeeds, Account marks `state: "deleted"`, cancels the VM and DNS via the reconciler, and releases the pools for rotation.
- **What the operator does**:
  1. Check Stripe's status page and Account's outbound network connectivity and `OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY`.
  2. Once Stripe is reachable again, wait up to 60 seconds for the billing reconciler to finish the cancellation, or re-run `node dist/cloud-computer-operator-main.js delete <id>` to trigger the cancellation immediately.
  3. Confirm `show <id>` reaches `phase: "deleted"` and has a `tombstonedAt` timestamp.

### Organization billing and offboarding

- A new work assignment requires a Stripe refresh within five minutes. Finalization failure, past-due or unpaid billing, and paused collection suspend work Homes without deleting them. A seat increase remains pending until Stripe confirms its invoice is paid and the matching quantity is applied. Use the invoice link to complete payment or the Abandon seat change action to void the pending invoice.
- The organization billing portal provides payment-method updates and invoice history. Organization closure is an explicit website action after all work Homes are offboarded. If a subscription ends separately, use **Pay for this organization again** to restore billing to the same organization.
- The offboarding worker runs separately from billing. Retention starts when suspension is confirmed. The final audit flush can fail, in which case the page shows **Final records not confirmed**.
- For an interrupted provider mutation, Account records the write before it can be sent. An unsent write can be recovered after three minutes. A dispatched write can be recovered after fifteen minutes if a fresh deterministic provider lookup confirms the outcome. Suspend and delete reports remain fenced until pending writes are resolved.

### Missed webhook

- **How to recognise it**: A customer completed Checkout, paid a past-due invoice, or canceled in Stripe, but `show <id>` (or `list`) has not updated after a minute, or Account logs `Cloud Computer billing reconciliation failed`.
- **What the system does**: Account's background billing reconciler runs at startup and every 60 seconds. It reconciles open checkouts against Stripe, processes deferred checkouts, and refreshes every active or suspended subscription directly from Stripe. Missed webhooks self-heal within 60 seconds as long as Account can reach Stripe.
- **What the operator does**:
  1. Check Stripe Dashboard -> Developers -> Webhooks for delivery errors to `/v1/cloud-computers/stripe-webhook` (HTTP `401` indicates a mismatched `OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET`; HTTP `404` indicates Cloud Computer is disabled on Account).
  2. Check Account logs for `Cloud Computer billing reconciliation failed` and its redacted `error` field. Use `checkout-list` to find deferred or unresolved payments and `billing-reconcile` to run a pass now.
  3. Fix the webhook secret or Stripe connectivity; the 60-second reconciler catches up automatically (and you can also resend failed events in Stripe, which are deduplicated by event ID).

### No free backup target or egress endpoint

- **How to recognise it**:
  - **Backup pool empty**: Customer checkout fails with HTTP `503` (`"Cloud Computer checkout is not available right now"`). `node dist/cloud-computer-operator-main.js backup-list` shows every row has a non-null `computerId`, `reserved: true`, or `needsRotation: true`.
  - **Egress pool empty**: `show <id>` shows `egressUnavailable: true` (customer sees Browser IP: "Browsing paused"). `node dist/cloud-computer-operator-main.js egress-list` shows every row has a non-null `computerId` or `needsRotation: true`.
- **What the system does**:
  - With no free backup target, Account refuses new checkouts.
  - With no free egress endpoint, boot still completes and the Home comes up, but without an upstream proxy and the customer sees browsing paused.
- **What the operator does**:
  1. Add new entries with `backup-add` / `egress-add`, or rotate released entries (`needsRotation: true`) with `backup-rotate` / `egress-rotate`.
  2. New checkouts succeed immediately once a backup target is free.
  3. Run `egress-assign <computer-id>`. The Home can then fetch its exclusive credentials without rebuilding. Installed versions without the VM refresh support still require the VM-side change below.

### Managed Home installer contract

- **Release feed.** The boot response has an optional `releaseManifestUrl`. The installer must validate it as a public HTTPS URL without credentials, query, or fragment, write it to the root-only `config.env` as the quoted `OPENSTEER_HOME_RELEASE_MANIFEST_URL`, and enable the managed update timer only when the URL is present. Boot still uses the six image digests in the pinned `release`. The update and rollback paths must require digests for all six services and must fail closed if a feed provides image tags. Publishing a feed or changing an Account setting does not modify an already installed VM's configuration.
- **Late browser egress.** From the root maintenance task, when the Home still has no upstream, call `GET /v1/cloud-computers/<id>/egress` on its configured Account origin. Use HTTP Basic with `OPENSTEER_HOME_OIDC_CLIENT_ID` and `secrets/oidc_client_secret` from installation. Pass the authorization data through a root-only file or stdin, outside the process arguments and logs. A successful response contains either `{}` or `{"egress":{"url":"…","username":"…","password":"…"}}`. Throttle polling to once a minute. When credentials arrive, write the three root-only egress secret files and apply the existing egress Compose configuration, preserving the browser egress firewall boundary. Keep browsing paused after an empty response or failed refresh, and do not overwrite working credentials on errors. Account rejects a revoked or superseded credential and a suspended or deleting Home.

### Restoring a backup by hand on the VM

- **How to recognise it**: You need to restore a Home directly on a VM (for example after in-place data corruption when you are keeping the same VM, or on a prepared replacement VM outside the `replace` command).
- **What the system does**: `opensteer-home restore` refuses to run unless `--source-stopped` is passed, verifies the snapshot into new staging Docker volumes and a staging PostgreSQL instance, re-checks whether the destination is claimed (refusing to overwrite a claimed Home unless `--replace` is passed), swaps `volumes.env` atomically, and rolls back to the previous volume set if `start_pod` fails health checks.
- **What the operator does**:
  1. Permanently stop the source Home first so two VMs never run with the same Host identity.
  2. Ensure `/etc/opensteer-home/secrets/backup_{repository,password,accessKeyId,secretAccessKey}` exist (or export `RESTIC_REPOSITORY_FILE`, `RESTIC_PASSWORD_FILE`, `AWS_ACCESS_KEY_ID_FILE`, `AWS_SECRET_ACCESS_KEY_FILE`).
  3. On the target VM as root, run:

     ```bash
     sudo opensteer-home restore --source-stopped <snapshot-id>
     ```

     Add `--replace` if overwriting an already-claimed Home on that VM:

     ```bash
     sudo opensteer-home restore --source-stopped --replace <snapshot-id>
     ```

     Omit `<snapshot-id>` to restore `latest`.

  4. Verify with `sudo opensteer-home status` that all seven services are healthy and `Claimed` is printed.

### Failed update and its rollback

- **How to recognise it**: `systemctl status opensteer-home-update.service` or `journalctl -u opensteer-home-update.service` (or a manual `sudo opensteer-home update [MANIFEST.json]`) prints:
  - `Home <new_version> did not become healthy. Restoring <old_version>.`
  - `The update was rolled back.`
  - If an update was interrupted mid-flight (for example by a reboot) and recovered on restart or maintenance: `Rolled back the interrupted update. The database checkpoint is retained.`
  - If a feed points to an older version during a scheduled run: `The update feed is older than the running Home.`
- **What the system does**: Before stopping services, `update.sh` records the running digest-pinned image references (or local `opensteer-home-rollback/<project>-<service>:<image-id>` tags on non-managed Homes), pulls the candidate images, takes a PostgreSQL dump checkpoint at `/etc/opensteer-home/update-database.dump`, and persists `previous.env`, `candidate.env`, and `phase` in `/etc/opensteer-home/update.pending`. If `start_pod` fails health checks—or if the VM crashes before commit—`update_recovery` (also invoked automatically by `opensteer-home start` and `opensteer-home maintain`) tears down the candidate, restores `/etc/opensteer-home/images.env` from `previous.env`, re-extracts sandbox policies, restarts the previous version, and leaves `/etc/opensteer-home/update-database.dump` intact. Rollback relies on database migrations staying compatible with the previous Host release; it rolls back container images, not the PostgreSQL schema.
- **What the operator does**:
  1. Inspect logs from the failed update: `journalctl -u opensteer-home-update.service` and `sudo opensteer-home logs <service>` (`postgres`, `host`, `gateway`, `runner`, `browser-runtime`, `browser-egress`, `channel-runtime`).
  2. Confirm the Home recovered on the previous release with `sudo opensteer-home status`.
  3. Fix or pull back the broken manifest at `OPENSTEER_HOME_RELEASE_MANIFEST_URL` before the next hourly `opensteer-home-update.timer` firing.
  4. If the previous release cannot run on the migrated database, restore `/etc/opensteer-home/update-database.dump` or restore from the latest restic snapshot with `sudo opensteer-home restore --source-stopped --replace [SNAPSHOT_ID]`.

## What has never been run for real

The automated test suite and local Colima proof (`scripts/verify-home-deployment.mjs`) exercise the Account store, reconciler, Stripe client, and Home container stack against local mocks and containers only. None of the following has been run in production or against live third-party services:

- **Live Stripe**: Checkout Sessions (`2026-11-18.endive` with `allowed_payment_method_types[0]=card`), Billing Portal sessions, real webhook signing and delivery to `/v1/cloud-computers/stripe-webhook`, and live `validateOffer` / 60-second billing reconciliation.
- **Live Hetzner Cloud**: server creation (`start_after_create: false`), cloud-init execution on an actual Hetzner Ubuntu 24.04 LTS image, firewall `opensteer-cloud-computers`, graceful shutdown + forced `poweroff`, IPv6 `/64` `::1` addressing, and server deletion.
- **Live Cloudflare DNS**: creating, updating, and deleting unproxied `A` / `AAAA` records with the `Opensteer Cloud Computer` comment, and orphan DNS cleanup.
- **Live S3-compatible storage with per-customer principals**: prefix-scoped IAM credentials, real restic backup/restore over the public internet, and principal rotation after deletion.
- **`linux/amd64` Home images and VMs**: the local Colima proof builds and runs `linux/arm64` images only; `linux/amd64` Home container builds and runtime sandboxing (AppArmor, seccomp, bubblewrap, Chromium) have not been executed on a real amd64 Ubuntu 24.04 VM.
- **Production systemd units and timers on a VM**: `opensteer-home-managed.service`, `opensteer-home.service`, `opensteer-home-update.timer`, `opensteer-home-backup.timer`, and `opensteer-home-maintain.timer` have not been run end-to-end on a real systemd VM (the Colima proof passes `--prepare` and invokes `opensteer-home` directly).
- **Production restore from a named snapshot**: `replace <computer-id> <snapshot-id>` driving a fresh Hetzner VM through `managed-restore`, `boot-complete`, DNS cutover, identity verification, old-VM deletion, and re-claim has never been executed end-to-end against real infrastructure.
