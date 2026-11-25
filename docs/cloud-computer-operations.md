# Opensteer Cloud Computer Operations

This runbook is for the Opensteer operator who runs Opensteer Cloud Computer.

## What runs where

Four components run the managed service:

1. **Account service** (`apps/control-plane`) runs in Kubernetes (`opensteer-system`, two replicas by default) backed by PostgreSQL. It owns customer billing, Stripe webhooks, desired state, the backup target pool, the egress endpoint pool, the reconciler lease, and automatic claiming of each new Home.
2. **Home reconciler** (`apps/home-provisioner`) runs in Kubernetes (`opensteer-system`) as a single replica (`replicas: 1`, `Recreate` strategy) using a dedicated Google service account. It polls Account for desired state, creates and powers Compute Engine VMs, manages Cloudflare DNS records, and verifies each Home's pinned identity.
3. **One VM per customer** runs on Google Compute Engine (Ubuntu 24.04 LTS, `e2-medium` with 4 GiB by default). It is the person's Home and nothing else. Cloud-init downloads the signed-by-hash standalone installer, exchanges the bootstrap token with Account, starts five Docker Compose services (`postgres`, `host`, `gateway`, `runner`, `channel-runtime`), and calls `boot-complete`. The `browser-runtime` and `browser-egress` images are selected but never started there: no browser runs in the VM. The Home sizes each service's CPU and memory limits from the VM it is on ([Home deployment guide](../deploy/home/README.md)).
4. **Browser pool hosts** are shared Compute Engine VMs (`n2-standard-8` by default) that the reconciler creates and Account places browsers on. Each person's browser is its own Firecracker micro-VM there, with its own durable profile on the host's profile disk and its own egress proxy. A Cloud Computer cannot be sold or created without the pool: Account and the reconciler both refuse to start without its settings. [deploy/home-provisioner/google-compute.md](../deploy/home-provisioner/google-compute.md#browser-pool-hosts) sets it up.

External provider accounts involved:

- **Google Cloud**: runs Account and the reconciler, stores runtime secrets, provides the reconciler's workload identity token, and hosts one Compute Engine VM per customer with its static address and the shared `opensteer-cloud-computers` firewall rules.
- **Stripe**: handles Checkout, the Billing Portal, recurring subscriptions, and webhooks.
- **Cloudflare**: hosts the DNS zone for customer Home hostnames (`OPENSTEER_CLOUD_COMPUTER_DOMAIN`).
- **S3-compatible object storage**: stores encrypted restic snapshots. Account assigns a registered principal and non-overlapping prefix; operators enforce the principal's prefix permissions in S3. The daily timer attempts a backup and reports successful scheduled snapshots to Account. An upload can succeed even when the report fails.
- **Static browser egress proxy provider**: provides HTTPS proxy endpoints and credentials for the pool. A person's browser on its pool host asks Account for its endpoint and waits without one; the Home never receives an egress password. The provider supplies the stable external IP, which nothing verifies.

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
| Home reconciler (1 pod)| |  | Customer VM on Compute Engine (Ubuntu 24.04)|
|  - Compute Engine API  |-|--|  - cloud-init -> opensteer-home-managed     |
|  - Cloudflare API      | +--|  - POST /v1/cloud-computers/:id/boot        |
|  - Pinned TLS probe    |    |  - POST /v1/cloud-computers/:id/boot-complete
+------------------------+    |  - Docker Compose: postgres, host, gateway, |
                              |    runner, channel-runtime (no browser)     |
                              |  - Daily backup -> exclusive S3 prefix      |
                              +---------------------------------------------+
                                  |  agent and relay ports (7310, 7312)
                                  v
                              +---------------------------------------------+
                              | Browser pool host (shared, n2-standard-8)   |
                              |  - one micro-VM per person's browser        |
                              |  - its profile on the host's profile disk   |
                              |  - its traffic -> exclusive egress proxy    |
                              +---------------------------------------------+
```

## Before deploying this release

Every step, in order, before the first Account or reconciler of this release starts. Each one that is missing makes that service refuse to start, or a new Cloud Computer wait at boot.

1. **Account**: set `OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL` (the feed every Home updates from), `OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST` and `OPENSTEER_CLOUD_COMPUTER_POOL_RELEASE_JSON`. Keep the pool agent and relay ports different and away from 25, 465 and 587, or leave them at 7310 and 7312.
2. **Reconciler**: set `OPENSTEER_POOL_PROVISIONER_KEY` (or `_FILE`), `OPENSTEER_POOL_HOME_CIDR` (exactly the Homes' subnet's range: the reconciler reads the subnet and refuses to start otherwise) and `OPENSTEER_POOL_PROVISIONER_CIDR`.
3. **The Homes' subnet**: nothing but Homes and pool hosts in it. In particular, not the Account's or the reconciler's own machines: every Home's Host may reach the whole subnet on the agent and relay ports.
4. **The lease**: after the new reconciler started, check that it reported the pool network: `select host(pool_network) || '/' || masklen(pool_network) from cloud_computer_provisioner_lease` names the subnet. Until it does, every new Cloud Computer's boot is answered 503 and its installer keeps retrying, which uses up its 20-minute bootstrap token (reissue it if it runs out).
5. **Cloud Computers made before this release**: each is replaced by a fresh one: delete it and create a new one. None is updated in place, none is replaced from a snapshot onto this release, and its browser profiles are not carried over. One whose browser ran on its own machine is given a pool slot by Account's missing-slot pass after the upgrade, although its Home cannot use it; that slot is erased with it when it is deleted.
6. **An Account database that ran any earlier build of this branch** is rebuilt, not upgraded. One whose last recorded migration is `0038_remove_platform_verification` (as on the test stack) upgrades normally.
7. **Pool ports**: the agent and relay ports (`OPENSTEER_CLOUD_COMPUTER_POOL_AGENT_PORT`, `OPENSTEER_CLOUD_COMPUTER_POOL_RELAY_PORT`) are fixed for running pool hosts: each host takes them when it is created, while Homes follow Account's values within five minutes: each Home asks again at its first maintenance pass after a start, then at most once every five minutes. Until a Home has asked, its firewall still opens only the old network and ports, so its browser cannot be reached; move the pool network only while replacing the pool hosts, which takes the browsers away for longer anyway. Changing them means replacing every pool host (`pool-host-replace`) at the same time; Account refuses ports that equal each other, 25, 465, 587 or the provisioner's admin port, and refuses (400) the lease of a provisioner whose admin port is one of them.

## First-time setup

### Account service environment

Cloud Computer turns on in Account as soon as any `OPENSTEER_CLOUD_COMPUTER_*` variable is present. Every `OPENSTEER_CLOUD_COMPUTER_*` variable also accepts a `<NAME>_FILE` variant that reads the value from a file and trims trailing whitespace. Setting both `<NAME>` and `<NAME>_FILE` fails startup.

In the Kubernetes manifest, put non-secret settings in the `account-env` ConfigMap and Stripe secrets in the existing `opensteer-account-runtime` JSON secret. Use the base names as JSON keys, such as `OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY`. The init container stages present `OPENSTEER_CLOUD_COMPUTER_*` keys as mode `0600` files. Account uses the file when there is no explicit environment or `_FILE` setting for that key. Publish a new version of the runtime secret and point the manifest's SecretProviderClass to it when the values change.

Account also requires its core variables to be valid for Cloud Computer: `OPENSTEER_CONTROL_PLANE_DATABASE_URL`, `OPENSTEER_CONTROL_PLANE_PUBLIC_URL` (must be `https://`), `OPENSTEER_PORTAL_ORIGIN` (must be `https://` and differ from the Account origin), and `OPENSTEER_ADOPTION_OPERATION_KEY` (seals pool credentials, bootstrap tokens, setup codes, at rest).

| Env var                                                   | Meaning                                                                                                                                                                                                                                       | Required | Default | Secret source          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ---------------------- |
| `OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL`              | Google service account email (`*.iam.gserviceaccount.com`) allowed to call reconciler routes                                                                                                                                                  | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_DOMAIN`                         | DNS suffix for Home hostnames (lowercase DNS name, max 214 chars)                                                                                                                                                                             | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_REGION`                         | Compute Engine zone (or region) assigned to new Cloud Computers                                                                                                                                                                               | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE`                    | Machine type for new Cloud Computers, or `default` to let the provisioner choose                                                                                                                                                              | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_RELEASE_JSON`                   | JSON release manifest (`version`, `installerUrl`, `installerSha256`, `images`)                                                                                                                                                                | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL`           | Public HTTPS feed for digest-pinned in-place updates; without it Account refuses to start                                                                                                                                                     | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY`              | Stripe secret or restricted key (`sk_live_...`, `rk_live_...`, `sk_test_...`, or `rk_test_...`)                                                                                                                                               | Yes      | None    | Secret (`_FILE` mount) |
| `OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET`          | Stripe webhook signing secret (`whsec_...`)                                                                                                                                                                                                   | Yes      | None    | Secret (`_FILE` mount) |
| `OPENSTEER_CLOUD_COMPUTER_STRIPE_PRICE_ID`                | Recurring Stripe Price ID (`price_...`) used in Checkout                                                                                                                                                                                      | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_STRIPE_PORTAL_CONFIGURATION_ID` | Dedicated Stripe Customer Portal configuration (`bpc_...`)                                                                                                                                                                                    | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_PLAN_NAME`                      | Customer-visible plan name (1–120 chars)                                                                                                                                                                                                      | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_CURRENCY`                       | Three-letter lowercase ISO currency code (for example `usd`)                                                                                                                                                                                  | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_PRICE_MINOR`                    | Positive integer price in minor currency units (for example `2000` for `$20.00`)                                                                                                                                                              | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_PRICE_INTERVAL`                 | Billing interval (`day`, `week`, `month`, or `year`)                                                                                                                                                                                          | No       | `month` | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_IPV6`                           | Publish IPv6 `AAAA` records and enable IPv6 Compose ports (`off` or `on`)                                                                                                                                                                     | No       | `off`   | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST`            | Browsers per pool host; without it Account refuses to start                                                                                                                                                                                   | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_POOL_RELEASE_JSON`              | Pool host installer and artifacts; without it Account refuses to start                                                                                                                                                                        | Yes      | None    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_NOT_READY_MINUTES`              | Minutes after readiness began that a paid Cloud Computer not ready and claimed, claimed before or not, is reported as `account.cloud_computer.not_ready` (`15`–`1440`; keep it above the provisioner's `OPENSTEER_HOME_READINESS_TIMEOUT_MS`) | No       | `30`    | ConfigMap / non-secret |
| `OPENSTEER_CLOUD_COMPUTER_HEARTBEAT_URL`                  | `https://` address sent a GET after each billing pass with no failure ([deploy/monitoring](../deploy/monitoring/README.md))                                                                                                                   | No       | None    | Secret (`_FILE` mount) |

The other pool settings (machine type, guest size, profile size and disk, ports) are optional and listed in [deploy/home-provisioner/google-compute.md](../deploy/home-provisioner/google-compute.md#pool-variables-and-capacity-sizing). Set `OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE=default` so the reconciler's machine type applies.

Set `OPENSTEER_CLOUD_COMPUTER_BACKUP_KEY_PROJECT` to a dedicated Google Cloud project before enabling sales. Enable Secret Manager and grant the Account workload identity permission to create secrets, add/access versions, and delete secrets there. PostgreSQL records the key version. The repository passwords live in Secret Manager and on the owning VM. Per-Home secrets use the `opensteer-backup-cc_…` prefix and are destroyed with all versions on final deletion. Keep historical repository passwords out of operational exports and database backups.

### Home reconciler environment

Run `apps/home-provisioner` with `deploy/home-provisioner/deployment.yaml` (`replicas: 1`, `strategy.type: Recreate`). The pod authenticates to Account with a Google workload identity token fetched from `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity` for the Account origin audience. The same identity's access token authorizes its Compute Engine calls. `OPENSTEER_HOME_CLOUDFLARE_TOKEN` accepts a `_FILE` variant. [deploy/home-provisioner/google-compute.md](../deploy/home-provisioner/google-compute.md) sets up the project, the network and the provisioner's permissions.

| Env var                                    | Meaning                                                                                                                      | Required | Default                       | Secret source                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------- | ----------------------------- |
| `OPENSTEER_ACCOUNT_URL`                    | Bare `https://` origin of the Account service                                                                                | Yes      | None                          | Deployment secret/env         |
| `OPENSTEER_HOME_GCP_PROJECT`               | Compute Engine project for Cloud Computer VMs                                                                                | Yes      | None                          | Deployment secret/env         |
| `OPENSTEER_HOME_GCP_ZONE`                  | Compute Engine zone (for example `us-central1-a`); also selects the region                                                   | Yes      | None                          | Deployment secret/env         |
| `OPENSTEER_HOME_GCP_NETWORK`               | VPC network name                                                                                                             | Yes      | None                          | Deployment secret/env         |
| `OPENSTEER_HOME_GCP_SUBNET`                | Subnet name                                                                                                                  | Yes      | None                          | Deployment secret/env         |
| `OPENSTEER_HOME_GCP_MACHINE_TYPE`          | Machine type when a desired record has `serverType: null`                                                                    | No       | `e2-medium` (4 GiB)           | Deployment secret/env         |
| `OPENSTEER_HOME_GCP_IMAGE`                 | Ubuntu 24.04 LTS image or image family resource path                                                                         | No       | Ubuntu 24.04 LTS amd64 family | Deployment secret/env         |
| `OPENSTEER_HOME_GCP_DISK_TYPE`             | Boot disk type (`pd-balanced`, `pd-standard`, `pd-ssd`)                                                                      | No       | `pd-balanced`                 | Deployment secret/env         |
| `OPENSTEER_HOME_GCP_DISK_SIZE_GB`          | Boot disk size in GB                                                                                                         | No       | `30`                          | Deployment secret/env         |
| `OPENSTEER_HOME_CLOUDFLARE_TOKEN`          | Cloudflare API token                                                                                                         | Yes      | None                          | Secret (`_FILE` or SecretRef) |
| `OPENSTEER_HOME_CLOUDFLARE_ZONE_ID`        | Cloudflare 32-character hex zone ID for `OPENSTEER_CLOUD_COMPUTER_DOMAIN`                                                    | Yes      | None                          | Deployment secret/env         |
| `OPENSTEER_HOME_CLOUD_COMPUTER_DOMAIN`     | Account's `OPENSTEER_CLOUD_COMPUTER_DOMAIN`; the only names in the zone the reconciler lists, writes or deletes              | Yes      | None                          | Deployment secret/env         |
| `OPENSTEER_HOME_PROVISIONER_REPLICAS`      | Safety guard; must equal `"1"` or the process refuses to start                                                               | No       | `1`                           | Deployment manifest           |
| `OPENSTEER_HOME_INTERVAL_MS`               | Poll interval in milliseconds (`1000`–`300000`)                                                                              | No       | `10000`                       | Deployment secret/env         |
| `OPENSTEER_HOME_REQUEST_TIMEOUT_MS`        | Per-HTTP-request timeout in milliseconds (`100`–`60000`)                                                                     | No       | `15000`                       | Deployment secret/env         |
| `OPENSTEER_HOME_ACTION_TIMEOUT_MS`         | Compute Engine operation timeout in milliseconds (`1000`–`600000`)                                                           | No       | `90000`                       | Deployment secret/env         |
| `OPENSTEER_HOME_READINESS_TIMEOUT_MS`      | Max wait for a Home to become ready in milliseconds (`1000`–`3600000`)                                                       | No       | `600000`                      | Deployment secret/env         |
| `OPENSTEER_HOME_ORPHAN_GRACE_MS`           | Grace period before deleting orphaned VMs or DNS records (`60000`–`86400000`)                                                | No       | `300000`                      | Deployment secret/env         |
| `OPENSTEER_HOME_CONCURRENCY`               | Max Cloud Computers reconciled in parallel (`1`–`16`)                                                                        | No       | `4`                           | Deployment secret/env         |
| `OPENSTEER_POOL_PROVISIONER_KEY`           | Ed25519 key that signs the reconciler's calls to pool hosts; without it the reconciler refuses to start                      | Yes      | None                          | Secret (`_FILE` or SecretRef) |
| `OPENSTEER_POOL_HOME_CIDR`                 | Subnet range of the Cloud Computer VMs and pool hosts; a private network, which each Home's firewall opens to the pool ports | Yes      | None                          | Deployment secret/env         |
| `OPENSTEER_POOL_PROVISIONER_CIDR`          | Range of the reconciler's own pods or nodes, allowed to reach pool hosts' admin port                                         | Yes      | None                          | Deployment secret/env         |
| `OPENSTEER_HOME_PROVISIONER_HEARTBEAT_URL` | `https://` address sent a GET after each tick with no failure; accepts `_FILE`                                               | No       | None                          | Secret (`_FILE` or SecretRef) |

### Home VM environment (on each VM)

Managed VMs receive their configuration automatically during boot and store it under `/etc/opensteer-home/` (`config.env`, `secrets/*`, and each release with its `images.env` in `releases/<id>`, the running one named by `current`). The variables below are used by `opensteer-home` on the VM for maintenance or manual recovery.

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
2. **Google Compute Engine**:
   - Use a dedicated Compute project and VPC for Cloud Computers, and grant the provisioner's service account the permissions listed in [deploy/home-provisioner/google-compute.md](../deploy/home-provisioner/google-compute.md).
   - Pick a zone (for example `us-central1-a`), a machine type and the Ubuntu 24.04 LTS image. Ubuntu 24.04 LTS lets the managed installer install missing Docker and tool packages automatically.
   - On first run, the reconciler creates and maintains firewall rule `opensteer-cloud-computers-v4` (and `opensteer-cloud-computers-v6` on a dual-stack subnet) on the VPC, allowing inbound TCP `80` and `443` from `0.0.0.0/0` (and `::/0`) to instances tagged `opensteer-cloud-computers`.
3. **Cloudflare**:
   - Create or choose the DNS zone for `OPENSTEER_CLOUD_COMPUTER_DOMAIN` and record its 32-hex zone ID in `OPENSTEER_HOME_CLOUDFLARE_ZONE_ID`.
   - Give the reconciler the same domain in `OPENSTEER_HOME_CLOUD_COMPUTER_DOMAIN`. A zone token can edit every record in the zone, and the orphan sweep removes Cloud Computer records whose computer its Account does not know: limited to that domain, two environments that share a zone never delete each other's records.
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

| Command                     | What it shows or changes                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list` / `show <id>`        | Account ID, desired state and observed phase, generation and revision, hostname, current and previous provider server IDs, IPs, pinned deployment ID and key fingerprint, bootstrap expiry and completion, deletion intent and tombstone, billing and egress status, claim attempt/receipt/error, and last reconciler error. |
| `lease-show`                | Holder UUID, expiry, and whether the lease expired. Returns `null` if no lease is recorded.                                                                                                                                                                                                                                  |
| `lease-release <holder>`    | Removes the named holder's lease only after expiry. A renewed lease or a different holder is refused.                                                                                                                                                                                                                        |
| `checkout-list`             | Open attempts known to be paid and deferred webhook completions, with Account and Stripe IDs for investigation. Checkout URLs and raw event bodies are omitted.                                                                                                                                                              |
| `billing-reconcile`         | Runs the same billing reconciliation as the Account worker. `ran: false` means another worker holds the billing lock. Inspect the `errors` array even when `ran: true`.                                                                                                                                                      |
| `claim-retry <computer-id>` | Clears a recorded claim failure on an active, provisioned Home, starts a fresh claim deadline, and queues it for the worker. Run after diagnosing the error. The existing Home identity and generation are retained.                                                                                                         |

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

  Returns the assigned endpoint ID and the recorded public address, which can be null. Repeating it returns the same assignment. The Cloud Computer's pool host receives it on its browser's next egress request; the Home never does.

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

### Rolling out a pool release

A pool host runs the pool release its row holds (`pool-host-list` and `pool-host-show` show it as `release`). A new `OPENSTEER_CLOUD_COMPUTER_POOL_RELEASE_JSON` reaches only new host rows until each existing host is replaced by an operator; a replacement the reconciler makes on its own (an unenrolled host that missed its readiness window) keeps the release the host had.

1. Set the new `OPENSTEER_CLOUD_COMPUTER_POOL_RELEASE_JSON` and restart Account.
2. For each host, one at a time: `node dist/cloud-computer-operator-main.js pool-host-replace <host-id>`. The answer's `release` is the release it will boot. Wait until `pool-host-show <host-id>` reports `phase: "ready"` on the new generation before the next host.
3. **What a person on that host sees**: for the few minutes the replacement takes, their browser is unavailable (Opensteer says it is being prepared). Every browser on the host is stopped so the durable profile disk can move to the new instance; each starts again cold on the new release with its profile (sign-ins, cookies, saved data) intact. Open pages and anything only in memory are lost and reported lost, as after a host failure: a guest's saved memory state lives on the old instance's Local SSD and was made by the old release's guest, so it is never resumed.

## The life of one Cloud Computer

### Provisioning and first claim

1. **Checkout**:
   - The customer starts checkout through `POST /v1/account/cloud-computers/checkout` with a UUID `requestId`.
   - Account validates the Stripe offer and reserves capacity before creating a Checkout Session. Checkout reserves one backup target.
   - Customer sees the checkout page in their browser; the app polls `GET /v1/account/cloud-computers` every 5 seconds.
2. **Desired state**:
   - Stripe sends `checkout.session.completed` (or `checkout.session.async_payment_succeeded`) to `POST /v1/cloud-computers/stripe-webhook`.
   - Account creates the `cc_<uuid>` record (`state: active`, `phase: provisioning`, `generation: 1`, `revision: 1`), binds the reserved backup target, generates a hostname `<token>.<OPENSTEER_CLOUD_COMPUTER_DOMAIN>`, generates a setup code, and seals a bootstrap token.
   - Customer sees `status: "preparing"` ("Setting up") and `egress: "pending"`.
   - Operator can run `node dist/cloud-computer-operator-main.js show <id>` and see `phase: "provisioning"`.
3. **Server created**:
   - On its next poll (`GET /v1/cloud-computers/desired`), the reconciler sees the active record with no VM, verifies the revision via `POST /v1/cloud-computers/:id/check`, ensures the `opensteer-cloud-computers` firewall rules exist, reserves the static external address `os-cc-<uuid>-1-ip`, creates Compute Engine instance `os-cc-<uuid>-1` with the network tag `opensteer-cloud-computers` and the labels `opensteer-cloud-computer=<id>`, `opensteer-generation=1` and `opensteer-managed-by=home-provisioner`, writes the Cloudflare `A` record (and `AAAA` if `ipv6Enabled`), and reports `phase: "booting"` with `providerServerRef` and IP to `POST /v1/cloud-computers/:id/status`.
   - Reporting `providerServerId` starts the 20-minute bootstrap token timer in Account.
   - Customer still sees `status: "preparing"`.
4. **Boot**:
   - Cloud-init writes `/root/opensteer-home-boot.json` and `/root/opensteer-home-bootstrap-token` and enables a systemd download unit. The unit fetches `installerUrl`, checks `installerSha256`, and runs the installer with those files.
   - The installer stages `/etc/opensteer-home/boot/*` and starts `opensteer-home-managed.service`, which retries until completion (stopping on exit `78` if the token is rejected).
   - `managed-boot.sh boot` calls `POST /v1/cloud-computers/:id/boot` with `{ hostname, bootstrapToken }`.
   - Account validates the token, registers an OIDC client for the Home, creates or reads its repository password in Secret Manager, and returns the pinned release images, setup code digest, OIDC client credentials, backup repository credentials and `browserPool: true`. It returns no egress: the person's browser runs on a pool host, which asks for its own endpoint.
   - The boot answer also carries `browserPoolNetwork`: the subnet the reconciler reported with its lease (its `OPENSTEER_POOL_HOME_CIDR`, where it creates both Homes and pool hosts) and Account's pool agent and relay ports. Without a reported subnet the answer has none, and the Home reaches nothing private.
   - The VM pulls the six images, applies AppArmor/seccomp policies and the pod `iptables`/`ip6tables` firewall, and starts the five Compose containers that run on a Cloud Computer, with limits sized from the VM. The firewall rejects every private range except TCP to the pool network on those two ports; `deploy/home/firewall.sh` says why that is narrow enough.
   - Customer sees `status: "preparing"` and `egress: "pending"` until the pool host has asked for its endpoint.
5. **Boot-complete**:
   - Once all containers are healthy, the installer reads the local Host discovery document (`/.well-known/opensteer` on loopback) and calls `POST /v1/cloud-computers/:id/boot-complete` with `{ hostname, bootstrapToken, identity: { deploymentId, hostKeyFingerprint } }`.
   - Account pins that `deploymentId` and `hostKeyFingerprint`, marks `bootCompletedAt`, and revokes the bootstrap token. A matching completion replay only acknowledges the same identity. The subsequent accepted `ready` report marks the generation ready.
   - The installer removes the local token and boot result files before enabling `opensteer-home.service`, the daily backup timer, and the maintenance timer. The hourly update timer is enabled on every Home; at each check it asks Account for the current feed. On terminal refusal the installer removes the files and stops a configured pod. Provider instance user data and cloud-init's cached copy can still contain the spent token; neither provides new boot authority after completion.
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
  - Reconciler removes the Cloudflare DNS record, stops the Compute Engine instance (`instances.stop`, a graceful guest shutdown), and reports `phase: "suspended"`. Data and disks stay intact.
  - Customer sees `status: "suspended"` with the reason (`"You paused this Cloud Computer."`, `"Your subscription ended."`, `"Your subscription needs attention."`, or the operator's reason text).
- **Resume**:
  - Owner calls `POST /v1/account/cloud-computers/:id/resume` (clears `ownerSuspended`), operator runs `node dist/cloud-computer-operator-main.js unsuspend <id>` (clears `operatorSuspension`), or Stripe reports `active` billing again.
  - Only when all three conditions are clear (no owner pause, no operator suspension, active billing) does Account move `state` back to `active`.
  - Reconciler starts the existing Compute Engine instance, restores the Cloudflare DNS record, verifies the pinned Home identity, and reports `phase: "ready"`.
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
  - Account marks `deletionRequestedAt` and cancels the Stripe subscription at once, whether or not a checkout for that computer or person is open: a checkout keeps its own path (expired, and a payment on it cancelled and refunded). Once Stripe confirms cancellation, Account transitions `state: "deleted"`, `phase: "deleting"`, removes the Home from `deployments` and deletes its OIDC client.
  - Reconciler removes the Cloudflare DNS record, stops the Compute Engine instance (`instances.stop`, a graceful guest shutdown), and reports `phase: "suspended"`. Data and disks stay intact.
  - Customer sees `status: "suspended"` with the reason (`"You paused this Cloud Computer."`, `"Your subscription ended."`, `"Your subscription needs attention."`, or the operator's reason text).
- **Resume**:
  - Owner calls `POST /v1/account/cloud-computers/:id/resume` (clears `ownerSuspended`), operator runs `node dist/cloud-computer-operator-main.js unsuspend <id>` (clears `operatorSuspension`), or Stripe reports `active` billing again.
  - Only when all three conditions are clear (no owner pause, no operator suspension, active billing) does Account move `state` back to `active`.
  - Reconciler starts the existing Compute Engine instance, restores the Cloudflare DNS record, verifies the pinned Home identity, and reports `phase: "ready"`.
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
  - Reconciler removes the Cloudflare DNS record, deletes the Compute Engine instance and releases its static address, waits until the instance is absent, and reports `phase: "deleted"`.
  - Account records the provider confirmation, then destroys the Home's Secret Manager secret. It records the tombstone and reports `status: "deleted"` only when both facts are confirmed.
  - Account purges stored object versions and delete markers using the corresponding Home's own S3 credential, including retired targets. It confirms removal with a fresh empty listing before releasing the target for rotation. A durable purge reservation holds each target through failures. The provisioner never receives storage credentials.
  - The Cloud Computer page shows **Computer and disk destroyed**, **Backups made unreadable**, and **Stored backup data removed** with separate dates.
  - **Settling with Stripe**: this is the same whether the owner deleted the Cloud Computer or deleted their Account. The 60-second billing pass settles each personal row with `deletionRequestedAt` set and `billingSettledAt` empty, in a few Stripe calls, retried every pass:
    - `cancel`: if the row isn't deleted yet, the pass cancels its subscription (`invoice_now=false`, `prorate=false`). It won't renew, and the rest of the period already paid isn't refunded. A failed attempt sets `cancelFailedAt`. Then Stripe must show the subscription cancelled.
    - `customer`: the Stripe customer that subscription belongs to is deleted, with the payment details saved on it, unless Stripe lists another subscription on it that is not cancelled. Stripe keeps its own records of past payments.
    - `record`: `billingSettledAt` is set. Rows deleted before this release were marked settled by the migration and are never revisited.
    - Nothing is refunded automatically. If the first cancel failed, settling logs `account.billing.cancelled_late` (error type `CloudComputerCancelledLate`) with the `computerId` and `waitedMs` (request to cancellation). Look in Stripe for a renewal charged in that time and refund it by hand.
    - A row still unsettled an hour after its request is logged as `account.billing.deletion_unsettled` (`CloudComputerDeletionUnsettled`) with the `computerId` and the `step` that is failing. Removing its stored backups, when that is what remains, is logged as `account.backup.erasure_pending`.
- **Account deletion**:
  - The account deletion page says the person's Cloud Computer goes with the Account, with the same billing words as the Cloud Computer's own Delete.
  - `AccountDeletionService.delete` contacts no Cloud Computer before the Account's own transaction. When the Account's row goes, the database records each of its Cloud Computers' deletion requests in that same transaction (the `zz_cloud_computer_revision` trigger). A deletion refused because another attempt is already deleting the Account leaves the Cloud Computer as it was.
  - Right after the deletion commits, the service asks the billing pass to run now (best effort; otherwise it runs within a minute). The pass cancels and settles the row as above, and the reconciler destroys the machine, the backup key and the stored backups.
  - The page after deletion says the Account is deleted and that the Cloud Computer's deletion is being finished.

## When something goes wrong

Each failure below is logged as one stable event, `jsonPayload.event` in Cloud Logging, with the same field names everywhere (`computerId`, `code`, `phase`, `minutes`, `step`, `pool`, `free`, `codes`, `status`, and a redacted `error`). The alerts in [deploy/monitoring](../deploy/monitoring/README.md) are written against these names: three page (a person paid and has no working Cloud Computer, the account service is down, the synthetic purchase failed twice) and the rest arrive in a daily digest. The account service's names are in `apps/control-plane/src/server/events.ts`; the provisioner's are `home-provisioner.*`.

### Setup that never becomes ready

- **How to recognise it**: the page `account.cloud_computer.not_ready` (with `computerId`, `phase`, `minutes` on the clock that decided and, when known, the failure `code`) names a person who paid and has no working Cloud Computer. Two clocks decide it. `readinessStartedAt` is the provisioner's deadline for the current attempt to become ready: it starts again at purchase, a claim retry, a Resume, a reissue, a replacement and at the start of every outage, and is never kept across outages. The watch keeps its own: `down_at`, when the current outage began, and `unstable_since`, when the current run of outages began (an outage that begins after the computer stayed ready for the limit starts a new run; one sooner keeps the run's start). For a computer that was ready before, only active time counts: a Suspend, or billing that stopped, records when the computer left active (`inactive_since`), and its return moves an open run forward by that time, so a computer that never comes up again still pages after 30 active minutes however often it is suspended and resumed, and one suspended for days does not page for those days. A computer never ready (its first set-up) has no run: it is judged by its attempt clock, which a Resume starts again. So:
  - a setup failed or its claim failed: pages at once (a readiness-deadline failure is ten real minutes of this attempt or outage);
  - never ready, or ready and not yet claimed: pages `OPENSTEER_CLOUD_COMPUTER_NOT_READY_MINUTES` (default 30) after its attempt began;
  - ready before and down now: pages once its run of outages has lasted that limit and its current outage 2 minutes. So an outage shorter than 2 minutes never pages, and neither does a longer one while its run is shorter than 30 minutes, unless the provisioner fails it at its readiness deadline ten real minutes in; a computer that stays down, or keeps going down, pages. Outages that keep coming, none of them paged, are `account.cloud_computer.unstable` in the digest ("A Cloud Computer keeps going down").

  The provisioner judges its readiness deadline against the attempt it read in the desired state, and its report names that attempt. A deadline failure that names an attempt other than the computer's current one (a retried copy, one judged before a Resume or the outage after it) changes nothing, whatever the computer's phase. One that names the current attempt of a computer the Opensteer account service still has as ready is the first news of an outage (the provisioner read the clock while it was ready): it is recorded as `booting`, and the outage and a new attempt begin. One that names the current attempt of a computer already down is accepted: `failed`. What counts toward that deadline is what the provisioner observed: a server not yet running, or a Home that does not answer its discovery (a timeout, a refused connection, an error status). A discovery that could not be attempted is no observation. Neither is a read of the provider or DNS that failed: any GET of the Compute Engine or Cloudflare API, whatever its status (a 403 while a token is rotated or an IAM change takes effect, a 5xx, a timeout), observes nothing and is reported as nothing: the last phase stands and the next pass looks again. A step done once a pass for every computer (the firewall) that fails, by a read or by a refused write, is the stack's problem and fails no computer. Only what needs it waits: running computers are still read, powered on, discovered and reported as they are (a stopped one starts its outage and pages by the ordinary clocks; its firewall attachment waits for a later pass), while a new one cannot be created, is reported `provisioning` and fails at its ten-minute deadline. The provisioner's failing-pass digest names the cause, once a pass. Only a write to this computer's own resources (its instance, its address, its bootstrap, its DNS records) that the provider or DNS refused (a 4xx other than a rate limit), a machine of it in another zone, or what the provider shows (a newer generation, two machines, another Home identity) fails it. A first set-up takes a few minutes, and the provisioner reports a set-up failed at its own readiness deadline (`OPENSTEER_HOME_READINESS_TIMEOUT_MS`, 10 minutes by default), so 30 does not page during a normal one. It repeats every minute while that stays true. `account.cloud_computer.setup_failed` is logged once as the provisioner records a failure, with its `code` (`provider-failed` when Google refused the request, `readiness-timeout`, `dns-failed`, `identity-mismatch` and the rest), and `account.cloud_computer.claim_failed` ("Cloud Computer claim failed") on each failed claim attempt. `show <id>` reports `phase: "failed"` with a `lastError` or a claim error under `claim.error` after the VM reaches `ready`.

- **What the system does**: A failed read of the provider or DNS reports nothing for that computer, and a failed shared step stops only creating a machine and attaching its firewall; the error is logged (`home-provisioner.pass.failed`, the digest "The provisioner is failing a pass", with its `service` and `status`) and the next pass, ten seconds on, looks again. The reconciler reports `phase: "failed"` with `lastError` when its readiness deadline (`OPENSTEER_HOME_READINESS_TIMEOUT_MS`) passes on what it did observe (a server not yet running, a Home that does not answer), or at once when a write to the computer's own resources is refused. The claimer retries transient errors with exponential backoff (up to 60 seconds) for 60 minutes from `readinessStartedAt`, then records `claimError` and stops retrying.
- **What this does not catch**:
  - A page for an outage the watch read just before its replica died is lost if the computer recovers before another replica's next pass, a minute later; an outage that lasts is found by that pass.
  - The clocks are the Opensteer account service's wall clock: a correction of that machine's clock moves every outage's minutes with it, forward or back.
- **What the operator does**:
  1. Check `show <id>`, Account logs (`account.cloud_computer.setup_failed`, `account.cloud_computer.claim_failed`), and reconciler logs (`home-provisioner.pass.failed`) to see whether provisioning, boot, discovery, or claiming failed.
  2. If the VM is reachable by console/SSH, inspect `systemctl status opensteer-home-managed.service`, `journalctl -u opensteer-home-managed.service`, and `sudo opensteer-home status` / `sudo opensteer-home logs <service>`.
  3. If the Home has never been ready, run `node dist/cloud-computer-operator-main.js reissue-bootstrap <id>` to rebuild it with a fresh bootstrap token. A first install that failed on the VM after it wrote `config.env` (a release whose Host does not start, for example) does not recover on that VM. `opensteer-home-managed.service` keeps retrying, but with `config.env` present the installer neither asks `/boot` again nor fetches a release, and the update timer is installed only when a managed install completes, so a corrected release in the feed never reaches it. Correct the release Account boots first, then reissue. The reissue bumps the generation, so a new VM boots from a fresh answer, and the failed one is powered off. Nothing of the person is lost: a computer that was never ready was never claimed.
  4. For a `ready` Home with a claim error, fix the underlying issue and run `claim-retry <computer-id>`. If a ready replacement cannot be repaired and Account has not issued its owner a sign-in, use the staged-snapshot reissue procedure below. For other previously ready personal Homes, use snapshot replacement if they cannot be recovered in place.

### Expired bootstrap token

- **How to recognise it**: Compare a non-null `bootstrapExpiresAt` in `show <id>` to the current time. Check `lastError` and the VM's `journalctl -u opensteer-home-managed.service` for a rejected boot credential (HTTP `401`, exit code `78`).
- **What the system does**: Bootstrap tokens expire 20 minutes after the reconciler first reports `providerServerId`. `opensteer-home-managed.service` has `RestartPreventExitStatus=78`, so it stops retrying once Account rejects the token. The reconciler stops trying to create a server without a token.
- **What the operator does**:
  - Run:

    ```bash
    node dist/cloud-computer-operator-main.js reissue-bootstrap <id>
    ```

  - If no create was dispatched and no boot credential was exchanged, Account renews the token in place. Once a VM was dispatched or boot exchanged credentials, reissue bumps the generation, clears the pin, and retires the issued egress and backup credentials. An unused backup target must be available.
  - Reissue refuses a ready generation without a restore snapshot, or a generation for which Account has already issued owner access.
  - If an unverified replacement already exchanged credentials, even if it reported ready, prepare an unused registered backup target containing the named snapshot with a new repository password. Pass a mode `0600` JSON file with `{ "targetId": "<uuid>", "password": "<new repository password>" }` as the final argument to `reissue-bootstrap`. The existing repository and its credentials are then quarantined.

### Replacing a broken Home from a snapshot

- **How to recognise it**: A Home that was previously ready (`everReady`) is unrecoverable in place (corrupted disk, broken VM, failed host) and the customer needs a fresh VM restored from a known-good restic snapshot.
- **What the system does**: No automatic path replaces a ready Home. This hosted `replace` procedure replaces a person's Home.
- **What the operator does**:
  1. On the source VM, run `sudo opensteer-home snapshots` to find a restic snapshot ID (8–64 lowercase hex characters). It reads the repository using the VM's root-only credential files. Account has no snapshot list. If the source VM is unavailable, use a previously recorded snapshot ID or the existing backup recovery procedure with the repository credentials.
  2. Run:

     ```bash
     node dist/cloud-computer-operator-main.js replace <computer-id> <snapshot-id>
     ```

  3. Account bumps `generation`, stores `restoreSnapshot`, issues a fresh bootstrap token, removes the old deployment listing, clears the stored credentials, and moves the record back to `provisioning`. Normal `replace` keeps the OIDC client record and rotates its secret at boot; reissue can delete the record.
  4. The reconciler powers off the previous VM. The new VM restores the named snapshot before sending `boot-complete`. The reconciler verifies the pinned identity. Account claims the replacement using a signed assertion and matching link credential. First setup checks the enrollment code; a replacement carries the code field but checks the restored Account link instead. Once Account issues the owner a sign-in to the claimed replacement, the reconciler can delete the previous VM. Account does not wait for the Home callback to create a session. The source backup remains the way back.
  5. Watch progress with `node dist/cloud-computer-operator-main.js show <computer-id>` until `phase` is `"ready"` and `claim.receiptAt` is set.

### Upgrading the reconciler

1. Stop the old reconciler (its pod gets SIGTERM). On a clean stop it gives its lease back (`home-provisioner.lease.released`) before it exits, so nothing waits for the lease to run out. It asks to give it back whenever it sent an acquire, also when the stop cut that acquire short (the account may have committed it); the account's release changes nothing for a provisioner that is not the holder.
2. Start the new one. It takes the lease at once. While another reconciler still holds it, it waits inside its process, asking every 10 seconds (`home-provisioner.lease.waiting`, then `home-provisioner.lease.acquired` with how long it waited), instead of exiting and restarting.
3. A reconciler that crashed, or was killed without a clean stop, keeps its lease until it runs out: up to ten minutes with nothing provisioning a purchase or observing an outage. The `Recreate` strategy already stops the old pod before it starts the new one; keep that order when upgrading by hand.

A lease refused for any other reason (the admin port is one the Homes use: HTTP 400) stops the new reconciler with its error; fix its settings and start it again.

### Second reconciler started by mistake

- **How to recognise it**: Reconciler logs emit `{"event":"home-provisioner.lease.conflict","service":"Account","status":409}` on stderr, or a pod fails at startup if `OPENSTEER_HOME_PROVISIONER_REPLICAS` is not `"1"`.
- **What the system does**: Account holds a single-holder lease (`POST /v1/cloud-computers/lease`, header `x-opensteer-provisioner-lease`, 10-minute TTL). A second instance gets HTTP `409` on lease acquisition. Without the current lease the `desired`, `check`, and `status` routes return HTTP `403`.
- **What the operator does**:
  1. Scale the `home-provisioner` Deployment back to `1` replica and verify `strategy.type: Recreate` in `deploy/home-provisioner/deployment.yaml`.
  2. Terminate any stray pod or local process running `home-provisioner`.
  3. Run `lease-show`. If the previous holder died, wait until its lease expires. The surviving reconciler can then acquire it automatically. Use `lease-release <holder>` to clear the expired lease explicitly.

### Provider rate limits

- **How to recognise it**: Reconciler stderr logs `{"event":"home-provisioner.provider.rate-limited","service":"Google Compute Engine","status":429,"retryAt":...}` or `"service":"Cloudflare"`.
- **What the system does**: The HTTP client parses `retry-after` and `ratelimit-reset` headers into `retryAt`. The Compute Engine adapter sends nothing more until `retryAt`; a rate-limited write was not carried out and is retried later. If rate limiting persists, the reconciler fails the current item (`"The Cloud Computer provider operation failed."` or `"The Cloud Computer DNS operation failed."`) and retries on the next 10-second pass.
- **What the operator does**:
  1. Lower `OPENSTEER_HOME_CONCURRENCY` (default `4`, minimum `1`) or raise `OPENSTEER_HOME_INTERVAL_MS` (default `10000`) if bulk churn is saturating Compute Engine or Cloudflare quotas.
  2. Verify no runaway loop or external tool is sharing the provisioner's Compute Engine quota or the same Cloudflare API token.

### Account refusing the reconciler

- **How to recognise it**: Reconciler stderr logs `{"event":"home-provisioner.account.refused","service":"Account","status":401}` or `403`.
- **What the system does**: On Account `401` or `403`, the reconciler aborts the pass immediately, does not run the orphan sweep, and retries on the next interval.
- **What the operator does**:
  1. Check that the `home-provisioner` Kubernetes ServiceAccount is bound to the Google service account email configured in `OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL`.
  2. Check that `OPENSTEER_ACCOUNT_URL` in `home-provisioner` exactly matches `OPENSTEER_CONTROL_PLANE_PUBLIC_URL` in Account (the workload identity JWT audience must match).
  3. Confirm `OPENSTEER_CLOUD_COMPUTER_*` is still enabled in Account.

### DNS or identity mismatch

- **How to recognise it**:
  - `show <id>` shows `lastError: "The Cloud Computer DNS operation failed."` (Cloudflare rejected a pre-existing `CNAME` or an `A`/`AAAA` record lacking the `Opensteer Cloud Computer` comment, or another DNS error occurred).
  - Or `show <id>` shows `"The Cloud Computer reported a different Home identity for this generation."` (reconciler probed the VM IP with SNI/Host and saw a different `deploymentId` or `hostKeyFingerprint` than the one pinned at `boot-complete`).
  - Or Account logs `Cloud Computer claim failed` with `The Cloud Computer answered as a different Home` and sets `status: "needs_attention"`, reason `"Your Cloud Computer couldn’t be set up for your Account. Contact support."`.
- **What the system does**: On an identity mismatch, the reconciler deletes the Cloudflare DNS record so traffic does not reach the wrong host, reports `phase: "failed"`, and stops publishing DNS. On a pre-existing foreign DNS record, Cloudflare calls fail closed without overwriting the foreign record.
- **What the operator does**:
  1. For a DNS conflict, inspect the hostname in the Cloudflare zone and remove the conflicting non-managed record if it is stale. The next reconciler pass will create the managed record.
  2. For an identity mismatch, do not point DNS back manually. Inspect the Compute Engine instance (`os-cc-<uuid>-<gen>`) and its `/etc/opensteer-home` state to find why its Host key or deployment ID changed.
  3. Rebuild the Home with `reissue-bootstrap <id>` (if never ready) or `replace <computer-id> <snapshot-id>` (if previously ready).

### Stripe outage during delete

- **How to recognise it**: `show <id>` has a `deletionRequestedAt` timestamp while billing has yet to reach `"canceled"`. The customer view reports that deletion is waiting for Stripe cancellation.
- **What the system does**: Account records `deletionRequestedAt` and refuses to delete the VM until Stripe confirms the subscription is canceled. Account's 60-second billing reconciler retries canceling the Stripe subscription on every pass. After Stripe confirms cancellation, the reconciler removes DNS and destroys the VM and disk. Account then destroys the repository password and records the tombstone. The backup target stays held until Account confirms removal of the stored backup objects.
- **What the operator does**:
  1. Check Stripe's status page and Account's outbound network connectivity and `OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY`.
  2. Once Stripe is reachable again, wait up to 60 seconds for the billing reconciler to finish the cancellation, or re-run `node dist/cloud-computer-operator-main.js delete <id>` to trigger the cancellation immediately.
  3. Confirm `show <id>` reaches `phase: "deleted"` and has a `tombstonedAt` timestamp. Check the separate stored-data removal timestamp before rotating the backup target.

### Interrupted provider writes

- For an interrupted provider mutation, Account records the write before it can be sent. An unsent write can be recovered after three minutes. A dispatched write can be recovered after fifteen minutes if a fresh deterministic provider lookup confirms the outcome. Suspend and delete reports remain fenced until pending writes are resolved.

### Missed webhook

- **How to recognise it**: A customer completed Checkout, paid a past-due invoice, or canceled in Stripe, but `show <id>` (or `list`) has not updated after a minute, or Account logs `account.billing.failed` ("Cloud Computer billing reconciliation failed").
- **What the system does**: Account's background billing reconciler runs at startup and every 60 seconds. It reconciles open checkouts against Stripe, processes deferred checkouts, and refreshes every active or suspended subscription directly from Stripe. Missed webhooks self-heal within 60 seconds as long as Account can reach Stripe.
- **What the operator does**:
  1. Check Stripe Dashboard -> Developers -> Webhooks for delivery errors to `/v1/cloud-computers/stripe-webhook` (HTTP `401` indicates a mismatched `OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET`; HTTP `404` indicates Cloud Computer is disabled on Account).
  2. Check Account logs for `account.billing.failed` and its redacted `error` field. Use `checkout-list` to find deferred or unresolved payments and `billing-reconcile` to run a pass now.
  3. Fix the webhook secret or Stripe connectivity; the 60-second reconciler catches up automatically (and you can also resend failed events in Stripe, which are deduplicated by event ID).

### No free backup target or egress endpoint

- **How to recognise it**:
  - **Before it is empty**: the billing pass logs `account.pool.low` with `pool` (`backup` or `egress`) and `free` while fewer than two entries are free.
  - **Backup pool empty**: Customer checkout fails with HTTP `503` (`"Cloud Computer checkout is not available right now"`). `node dist/cloud-computer-operator-main.js backup-list` shows every row is assigned or reserved (`computerId` or `reserved`), awaiting purge (`purgeComputerId`), or marked `needsRotation`.
  - **Egress pool empty**: `show <id>` shows `egressUnavailable: true` (customer sees Browser IP: "Browsing paused"). `node dist/cloud-computer-operator-main.js egress-list` shows every row has a non-null `computerId` or `needsRotation: true`.
- **What the system does**:
  - With no free backup target, Account refuses new checkouts.
  - With no free egress endpoint, the Home comes up, and its browser on the pool host has no upstream proxy: the customer sees browsing paused.
- **What the operator does**:
  1. Add new entries with `backup-add` / `egress-add`, or rotate released entries (`needsRotation: true`) with `backup-rotate` / `egress-rotate`.
  2. New checkouts succeed immediately once a backup target is free.
  3. Run `egress-assign <computer-id>`. The pool host receives the endpoint on its browser's next egress request.

### The account service is down

- **How to recognise it**: the page "The account service is down": the uptime check on `https://<account-origin>/healthz` has failed from more than one region for two minutes (`deploy/monitoring/policies/page-account-down.yaml`).
- **What the system does**: Nothing reaches it: sign-in, checkout, the Stripe webhook (Stripe retries for three days), the provisioner (its pass fails with `home-provisioner.pass.failed` and retries) and the Homes' reports all wait. Running Cloud Computers keep working for people already signed in to them.
- **What the operator does**:
  1. `kubectl -n opensteer-system get pods -l app.kubernetes.io/name=account` and `kubectl -n opensteer-system logs deploy/account`: a pod failing its `/healthz` probe, a crash at startup (a migration refused, as in the section on `0037_remove_organizations` below), or the database unreachable.
  2. Check the load balancer and the certificate for the account origin.
  3. Once it answers, the billing pass catches up within a minute; check `account.billing.failed` stops.

### The synthetic purchase failed

- **How to recognise it**: the page "The synthetic purchase failed twice": two runs in a row of `scripts/synthetic-cloud-computer.mjs` (the CronJob in `deploy/monitoring/synthetic-cronjob.yaml`, every six hours against the staging account service in Stripe test mode) logged `synthetic.run.failed`. Its `step` says where: `sign-in`, `leftover`, `checkout`, `payment`, `ready`, `home`, `delete`, `gone` or `configuration`; the exit code matches (10 to 17, or 2).
- **What the system does**: The run signs in to its own Account (`OPENSTEER_SYNTHETIC_SIGN_IN_EMAIL` on the account service, which refuses the App Review account), so every Cloud Computer in that Account is one a run made. It first deletes any an earlier run left (`synthetic.run.leftover-deleted`), then buys, paying on Stripe's own hosted Checkout page in a headless Chromium with the test card. Whatever happens after it signed in, it deletes every Cloud Computer that was not there when it began, including one that appeared late, and waits until the machine and its DNS name are gone; `synthetic.run.cleanup-failed` says that delete did not finish, and the next run deletes it first. It refuses a Checkout Session that is not `cs_test_`, so it cannot charge a real card.
- **What the operator does**:
  1. Read the last two `synthetic.run.failed` lines: the `step`, the `detail` and the `computerId`.
  2. `payment`: Stripe's Checkout page did not take the test card or did not send the browser back (its page changed, or the test-mode offer is wrong), or no Cloud Computer appeared within 5 minutes of paying (the webhook and the 60-second pass both failed: see "Missed webhook"). `ready`: follow "Setup that never becomes ready" with that `computerId`; production may be broken the same way. `home`: the Home answered at its address but not as the Home the account claimed. `leftover`, `delete` or `gone`: follow "Stripe outage during delete".

### A Cloud Computer reports a problem

- **How to recognise it**: from the daily digest. `account.cloud_computer.unhealthy` (with `computerId` and the problem `codes`) when a Cloud Computer's health report names a problem that needs someone; `account.cloud_computer.report_missing` (with `minutes`) when a ready Cloud Computer has sent no health report for an hour; `account.cloud_computer.backup_overdue` (with `minutes` since the last backup) when it has reported no backup for 36 hours.
- **What the system does**: Every 15 minutes each Cloud Computer sends its health report (version, each service healthy or not, a disk bucket, its last backup and update and its problem codes with counts, nothing else; [architecture](architecture.md#problems-and-reports)). The account keeps only the latest report per computer, and its owner sees that same report on their Cloud Computer page.
- **What the operator does**:
  1. `node dist/cloud-computer-operator-main.js show <id>` shows the latest report under `health`, with when it arrived.
  2. A service unhealthy or a failed update: on the VM, `sudo opensteer-home status` and `sudo opensteer-home logs <service>`; see "Failed update and its rollback". A failed or overdue backup: `journalctl -u opensteer-home-backup.service`. No report at all: the VM may be off or the Host down; check the instance in Compute Engine.

### A Cloud Computer keeps going down

- **How to recognise it**: from the daily digest, `account.cloud_computer.unstable` (with `computerId` and `minutes`, how long its run of outages has lasted): a Cloud Computer whose run of outages has lasted 30 minutes, measured from the start of its first outage to now while it is down, or to the end of its last outage once it is ready again, and of which no single outage is being paged now. It is said while the computer is down for less than 2 minutes, or ready again for less than 30 minutes. That may be many short outages, or one long outage that was paged and has since ended.
- **What the system does**: Nothing more: the watch says it every minute while that holds, and the digest at most once a day. An outage in such a run that lasts 2 minutes is paged instead (`account.cloud_computer.not_ready`).
- **What the operator does**:
  1. `node dist/cloud-computer-operator-main.js show <id>`: `phase`, `lastError`, `readinessStartedAt` and the latest health report under `health`.
  2. Provisioner logs (`home-provisioner.pass.failed`) for a discovery or provider write that keeps failing; on the VM, `sudo opensteer-home status` and `journalctl -u opensteer-home-managed.service` for a service that keeps restarting, and `journalctl -u opensteer-home-update.service` for an update loop.

### Managed Home installer contract

- **Release feed.** Every Cloud Computer's boot answer carries `releaseManifestUrl` (Account refuses to start without one). It must be HTTPS without credentials, a query, or a fragment and resolve only to public addresses. The installer saves it in root-only `config.env` as `OPENSTEER_HOME_RELEASE_MANIFEST_URL` and enables the hourly update timer on every Home, feed or not. At each check the Home asks Account for the current feed (`GET /v1/cloud-computers/<id>/release-feed`, HTTP Basic with its OIDC client credentials, refused before boot-complete and for a suspended or deleting Home), checks it exactly as boot does, and rewrites the `config.env` line when it changed: changing `OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL` in Account moves every Home made by this release to the new feed at its next hourly check (one made before it is replaced, not updated: see [Before deploying this release](#before-deploying-this-release)). When Account does not answer, the Home uses the feed it has and logs `The Opensteer account did not answer for its update feed`; an address that fails the checks is never used. The updater checks DNS again and pins the fetch to the checked addresses without a proxy or redirects. Boot uses the six digests in the pinned `release`; a managed update refuses tags. A release is its version and its six digests: the same release is `Already on this release`, the same version with other digests is `Same version, different build: updating`, and a scheduled update refuses an older version (`older: refused`). Changing other Account settings does not change an installed VM's configuration. **A release is one directory**: the release-feed answer also names the Home's installer, `recipe: {url, sha256}`, from Account's own `OPENSTEER_CLOUD_COMPUTER_RELEASE_JSON` (`installerUrl`, `installerSha256`, the installer new Cloud Computers boot with): that pin is the only place a managed Home takes root code from; there is no signature. Move the installer in Account's release config with the feed's images. An update unpacks the installer into a new `releases/<id>` beside the running release, with the manifest's selector, lets that release's own code pull and check its images (PostgreSQL's too), sandbox policies and units, dumps the database into it, and only then switches: the running release stops, the new one starts and passes one maintenance check, and `current` is renamed to it ([Home deployment guide](../deploy/home/README.md)). Both halves name their release: the installer's own `version` file (written from the same build as the images' release stamps) must equal the feed manifest's version, or the Home changes nothing and says `The release is still being published`; when the same mismatch is still there at a later check, the Home records its update as `waiting` since the first one, which its health report carries (`update.failed`, `updateResult: waiting`) until an update goes through. One forgotten move of either half therefore shows. A Cloud Computer installed before this release has an updater that swaps images in place and a bootstrap that copies its boot recipe over the Home at every boot; it is not supported: replace it once (see [Before deploying this release](#before-deploying-this-release)). A rollback leaves `current` on the running release and starts it; it deliberately keeps the database as the new release's migrations left it (they are expand-only, so the previous Host runs on it; the dump stays in the failed release's directory for manual recovery until another release commits, never replayed); a release that failed its check is not tried again by itself and the feed address Account gave, which stands whether or not the new release passed. **Disk**: a Home keeps the running release and the one before it, with their images, and removes older ones after each update. Before it fetches anything, an update needs room for one more release's images where Docker keeps them, measured on Nov 25 (0.1.219, amd64) as unpacked plus compressed: host 702 + 164 MB, runner 1,940 + 487, channel-runtime 410 + 93, gateway 143 + 38, PostgreSQL about 540, so about 4.6 GB on a Cloud Computer (no browser images), and with browser-runtime 3,780 + 1,008 and browser-egress 429 + 98 about 9.9 GB on a Home that runs its browser; and room for the database's dump beside the Home.
- **Late browser egress.** A Cloud Computer's Home runs no browser and Account answers its egress request with `{}`, so it never writes the files below; the person's browser gets its egress on its pool host. The rest of this paragraph is how a managed Home with its browser in the VM behaved, which no Cloud Computer is any more. While a managed Home has no upstream, root maintenance calls `GET /v1/cloud-computers/<id>/egress` on the configured Account origin. The timer fires 15 seconds after maintenance last became inactive. It sends HTTP Basic using `OPENSTEER_HOME_OIDC_CLIENT_ID` and `secrets/oidc_client_secret` through stdin, not process arguments. A successful response is `{}` or `{"egress":{"url":"…","username":"…","password":"…"}}`. On assignment, maintenance writes three `0444` secret files in the root-only Home directory for the egress mounts and recreates the proxy. Chromium's public page loads fail closed with no working upstream; this is a browser setting, not a firewall boundary against a task shell or an agent controlling Chromium. Account rejects a revoked or superseded credential and a suspended or deleting Home.

### Restoring a backup by hand on the VM

- **How to recognise it**: You need to restore a Home directly on a VM (for example after in-place data corruption when you are keeping the same VM, or on a prepared replacement VM outside the `replace` command).
- **What the system does**: `opensteer-home restore` requires `--source-stopped` and verifies the snapshot in staging volumes and PostgreSQL. It checks destination claim state after stopping the gateway but while the Host still runs, and refuses a destination that reports claimed unless `--replace` is passed. The check is not an atomic fence against an in-flight claim. Restore swaps `volumes.env` atomically and rolls back if the restored pod fails health checks. If recovery cannot reconcile the journal and selector, it stops for an operator and keeps both sets.
- **What the operator does**:
  1. Permanently stop the source Home first so two VMs never run with the same Host identity. Prevent claims on the destination during cutover, including claims already in flight.
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

- **How to recognise it**: `systemctl status opensteer-home-update.service` or `journalctl -u opensteer-home-update.service` (or a manual `sudo opensteer-home update`) prints:
  - `Home <new_version> did not pass its check. Restoring <old_version>.`
  - `The update was rolled back. The database dump taken before it is kept in /etc/opensteer-home/releases/<id>/database.dump until the next update.`
  - If an update was interrupted before its switch (for example by a reboot) and recovered on restart or maintenance: `An update stopped before it switched releases: the Home runs its previous release.`
  - If the previous release did not start again: `The update failed, and <old_version> did not start again`. The next start through systemd (or a reboot, or the maintenance timer) starts it; check `sudo opensteer-home logs host`.
  - Any failure while preparing: `… Nothing was changed.` The Home kept running; the next check tries again.
  - At later checks offered the same release: `Release <new_version> did not start here: waiting for the next one`. A release that failed its check is not tried again by itself (`/etc/opensteer-home/update.failed`), and the health report carries `update.failed` with `updateResult: not-retried` since the failure. Its directory and the dump taken before its first attempt stay until another release commits.
  - A managed Home whose account gave no recipe pin: `The Opensteer account gave no recipe for this release: not updating now; the next check tries again.` It does not update until Account answers with the pin.
  - If a feed points to an older version during a scheduled run: `The feed's release <new_version> is older than the running <old_version>: older: refused.`
- **What the system does**: `update.sh` prepares the whole release in `/etc/opensteer-home/releases/<id>` (its files, selector, images, sandbox policies, units, and a consistent dump of the database as it was before) while the running release keeps running, then switches: `current` names the new release only after it started and passed its check. A failed check or a stop before that rename leaves `current` on the running release: the new release's containers are stopped with the running release's Compose files under the Home's own project, so a release whose files do not parse cannot block it, and the running release starts again; schema and data are not reverted. The rollback is reported only once the previous release has started. A release is "already this release" only if its selector and its installer's identity (`recipe.sha256`) both match. Migrations must be expand-only and compatible with the previous Host. The dump is a last-resort manual recovery point and does not include writes made after it was taken. Managed Homes update only from the HTTPS feed the Account supplied; a local manifest is for bring-your-own installs.
- **What the operator does**:
  1. Inspect logs from the failed update: `journalctl -u opensteer-home-update.service` and `sudo opensteer-home logs <service>` (`postgres`, `host`, `gateway`, `runner`, `browser-runtime`, `browser-egress`, `channel-runtime`).
  2. Confirm the Home recovered on the previous release with `sudo opensteer-home status`.
  3. Publish a fixed release (it is tried at the next hourly check), or, when what failed was the machine and not the release, run `sudo opensteer-home update --retry` to try the same release once more.
  4. If the previous release cannot run on the migrated database, restore the failed release's `/etc/opensteer-home/releases/<id>/database.dump` (kept until another release commits) or restore from the latest restic snapshot with `sudo opensteer-home restore --source-stopped --replace [SNAPSHOT_ID]`.

### Migrations from this release

Account `0039_problem_reports` (the `cloud_computer_health` table; the `cloud_computers.ready_at`, `cloud_computers.down_at`, `cloud_computers.unstable_since`, `cloud_computers.inactive_since` and `users.synthetic_at` columns) and Home `0118_problem_reports` (three partial indexes) are final from this release on; no stack has applied an earlier shape of either (the test Opensteer account service is at `0038`). 0039 also starts the watch's clocks for the rows it finds, so its first pass pages nobody for time that passed under the old rules: a computer ready as it runs gets `ready_at` from its last report (its last change when it never reported); an active computer that was ready before (`ever_ready`) and is not now has its outage, its run and its attempt start at the migration, and a readiness-deadline failure of it is `booting` again, for the provisioner to fail after ten real minutes if it is truly down. A first set-up already past its limit and a terminal failure still page. Run again, it changes nothing.

### Account startup refused by `0037_remove_organizations`

- **How to recognise it**: `apps/control-plane` fails to start during `migrateControlPlaneToLatest` (`apps/control-plane/src/server/runtime.ts`) with `Organizations cannot be removed while these exist; an operator must decide what becomes of them first: …`, rolling back `0037_remove_organizations` with no schema or data changed.
- **What it means**: Organizations were removed; it is the owner's belief that organizations were never enabled in production, so every organization endpoint, portal page, offboarding worker, and Stripe seat helper was deleted and no operator CLI command exists to wind one down. To confirm before deploying, check that `public.organizations`, `public.organization_checkouts`, and `public.work_assignments` are empty and that `public.cloud_computers` has zero rows with `work_assignment_id is not null`, any `work:%` placeholder in `stripe_subscription_id`/`stripe_customer_id`/`stripe_checkout_id`/`stripe_price_id`, or `account_id is null and state <> 'deleted' and deletion_requested_at is null and tombstoned_at is null`. `0037_remove_organizations` locks those tables and refuses while any such row exists.
- **What the operator does to resolve one organization-paid Cloud Computer by hand**:
  - **Rule**: A Home is never handed to anyone other than its assignee — it holds that person's sessions, sign-ins, and tasks. Either hand it to its assignee (if the assignee already has another live personal Cloud Computer under `cloud_computer_one_live_per_account`, retire this work computer instead unless the assignee retires their other one first) or retire it.
  1. **Stripe (Dashboard, by hand)**: Cancel the organization's seat subscription (`organizations.stripe_subscription_id`), void or refund any open or unpaid seat-change invoices (`organization_seat_changes.invoice_id`), and expire or refund any in-flight organization checkouts (`organization_checkouts.session_id`). If the Cloud Computer is being kept by its assignee, create or identify a real personal Stripe customer (`cus_…`), subscription (`sub_…`), checkout reference (`cs_…`), and price (`price_…`) for the assignee.
  2. **Account database (SQL, in one transaction before restarting `apps/control-plane`)**:
     - **If kept by its assignee**: Update the `public.cloud_computers` row (`id = '<cc_id>'`): set `work_assignment_id = null`, set `account_id = '<assignee_account_id>'` (the assignee — never another account), and replace every `work:` placeholder with the assignee's real personal billing values: `stripe_checkout_id = 'cs_…'` (unique), `stripe_customer_id = 'cus_…'`, `stripe_subscription_id = 'sub_…'` (unique), `stripe_price_id = 'price_…'`, `billing_currency = 'usd'` (or the subscription's currency), and `billing_status = 'active'` (matching Stripe). Leaving any `work:` ID behind causes `0037` to keep refusing and would make the 60-second billing reconciler (`#refreshSubscription` / `#settleDeletion`) fail forever on Stripe token validation. Confirm `public.deployments.owner_account_id` matches the assignee (Account enforces that match when a Home is claimed).
     - **If retired (not kept — already deleted/tombstoned, assignee gone, or assignee already has another live Cloud Computer)**: Decommission any live VM, DNS record, backup target, and egress endpoint first, then update the `public.cloud_computers` row (`id = '<cc_id>'`): set `work_assignment_id = null`, `account_id = null`, `state = 'deleted'`, `phase = 'deleted'`, `deletion_requested_at = coalesce(deletion_requested_at, now())`, `deleted_at = coalesce(deleted_at, now())`, `tombstoned_at = coalesce(tombstoned_at, now())`, `billing_settled_at = coalesce(billing_settled_at, now())`, `billing_status = 'canceled'`, and replace all four `work:` placeholder columns (`stripe_checkout_id`, `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`) with a unique non-`work:` marker such as `'retired-work:' || id`. **Never** write a made-up `cus_`/`sub_`/`cs_`/`price_` Stripe ID: `billing_settled_at` and `tombstoned_at` keep the 60-second billing reconciler from calling Stripe for the row, whereas a fake Stripe ID on any unsettled or non-tombstoned row would call Stripe and fail on every pass.
     - Delete the organization rows in foreign-key order: `work_audit_batches`, `work_audit_records`, `work_assignments`, `organization_seat_changes`, `organization_checkouts`, `organization_invitations`, `organization_members`, `organizations`. Any `cloud_computer_backup_targets` row held only by `reserved_organization_id` becomes a free backup target when `0037` drops its organization reservation columns.
  3. **Restart Account and let the reconciler run**: Start `apps/control-plane`. `0037_remove_organizations` succeeds and drops the empty organization tables and columns while keeping the Cloud Computer row intact; `apps/home-provisioner` reconciles it normally with no organization fields.
  4. **What the Home's own migration (`0110_remove_organizations_contract`) then does**: When that Cloud Computer's Home upgrades and starts, `0110_remove_organizations_contract` drops `work_home_policy`, `work_audit_outbox`, `work_audit_head`, and the work triggers and columns, turning the Home into an ordinary personal Home of its one person without widening any connected agent's authority: open connections above `externalMaxMode` are narrowed to the cap, open connections refused by `allowEverything` / `allowTasks` (or on a closing work Home) are revoked through the full Disconnect set, already-expired connections are left untouched, and chats ended for retired organization or closing reasons keep no reason ("This chat has ended.").

### A Cloud Computer made before its browser moved to the pool

- **What happened to it**: `0040_browser_always_pooled` moved every row that said `browser_mode = 'local'` into the pool, dropping none. A live one is given a browser pool slot by Account's next pool reconciliation, at the size Account is configured with; one already deleted or being deleted was marked as having no slot to erase. `browser_mode` now only accepts `pool`.
- **What it means**: its VM still runs the Home it was installed with, its own browser included. It is not updated to this release's recipe, and its browser profiles are not moved into the pool.
- **What the operator does**: replace it by a fresh Cloud Computer, as [Before deploying this release](#before-deploying-this-release) says: delete it and create a new one. Its pool slot, if Account gave it one, is erased with it; its deletion settles even if it never had one.

## What has never been run for real

The automated test suite and local Colima proof (`scripts/verify-home-deployment.mjs`) exercise the Account store, reconciler, Stripe client, and Home container stack against local mocks and containers only. None of the following has been run in production or against live third-party services:

- **A Cloud Computer's browser end to end**: nothing on this branch shows a person using their browser in the pool from their Cloud Computer; the Host's side of the pool is built on another branch. The Home's pod firewall lets the pod reach the pool network on the agent and relay ports, but no real Home has reached a real pool host through it. Any process in the pod (a Run's shell too) can open a connection to those two ports but holds no key: what protects the pool is the slot's keys, which only the Host holds, and each Home's capped share at the pool host (16 connections at the agent port, 64 at the relay).
- **A 4 GiB Home under load**: the limits `home_limits` sets on an `e2-medium` come from one measured Run (OpenCode 1.18.32 writing a 500-word essay on a scratch Cloud Computer, Nov 25; [Home deployment guide](../deploy/home/README.md)). The other engines, and a Run of the person's own agents under heavier work, have not been measured.
- **Live Stripe**: Checkout Sessions (`2026-11-18.endive` with `allowed_payment_method_types[0]=card`), Billing Portal sessions, real webhook signing and delivery to `/v1/cloud-computers/stripe-webhook`, and live `validateOffer` / 60-second billing reconciliation.
- **The live Compute Engine adapter**: the reconciler's instance creation with a reserved static address, cloud-init on the instance it created, firewall rules `opensteer-cloud-computers-v4`/`-v6`, stop and start, dual-stack addressing, and instance and address deletion. Its tests run against a stand-in for the Compute Engine API.
- **Live Cloudflare DNS**: creating, updating, and deleting unproxied `A` / `AAAA` records with the `Opensteer Cloud Computer` comment, and orphan DNS cleanup.
- **Live backup erasure**: Secret Manager workload permissions and irreversible key deletion, S3-compatible version listing and deletion with prefix-scoped credentials, and principal rotation after deletion. Real restic backup and restore over the public internet remain unverified.
- **`linux/amd64` Home VMs at a provider**: the verifier has run in local mode on pristine AMD64 Ubuntu 24.04 Compute Engine instances without an external address (2026-11-21): the `linux/amd64` build and all 34 checks passed, including AppArmor, seccomp, the Runner bubblewrap sandbox this release later removed, Chromium, and the managed installer with a claim signed by a stand-in for the Opensteer account and OIDC sign-in against it. The `linux/arm64` build-only half did not run there.
- **Production systemd units and timers**: The Colima proof uses `--prepare` and invokes `opensteer-home` directly for bring-your-own installs, but waits for the managed installer and Home systemd services for managed boot and restore. It does not qualify the scheduled timers end-to-end on a production VM.
- **Production restore from a named snapshot**: `replace <computer-id> <snapshot-id>` driving a fresh Compute Engine VM through `managed-restore`, `boot-complete`, DNS cutover, identity verification, old-VM deletion, and re-claim has never been executed end-to-end against real infrastructure.

## Left for a later release

- **Only the Host's process reaches the pool** (taken out of this release after two faults found on a real container in two tries). A Host with its own uid (not the Runner's 10001) would let `firewall.sh` match the pool allow on that uid, so a Run's shell could not even open a connection to the pool ports. Before it returns it needs: the Host image's data directory and a passwd entry made for that uid (the image's `/var/lib/opensteer` is 10001's, and Docker copies it, ownership included, into an empty volume at the Host's first mount, which undid the chown pass made before it); a volume's first-mount ownership decided before the Host container exists; restore and rollback across the uid change; and a check that starts the real Home images as that uid, on an empty volume in `start_pod`'s order, before any purchase can reach them. That check is the operator's throwaway pod; its script would live at `scripts/verify-home-pooled-pod.sh`, next to `scripts/verify-home-deployment.mjs`, and run on the images a release build makes before they go into a feed. The image build guard (`deploy/container/assert-readable-tree.sh`) is not that check: it skips symbolic links and accepts a file only others can read, which is enough for this release (no uid other than an image's own runs it, and our build makes neither); the real-image check covers both if the split returns.
