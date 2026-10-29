# Kubernetes managed Deployment provider

This provider installs one fixed Opensteer server topology per Kubernetes namespace. It is intended
for a Standard GKE cluster. It does not support GKE Autopilot: the main Runner requires `/dev/fuse`
and `SYS_ADMIN` to mount PortableFS workspaces. Its setuid FUSE helper also receives
`DAC_READ_SEARCH` so it can traverse the Runner user's private mountpoint ancestors while installing
the mount; the directories remain mode `0700`.

## Cluster prerequisites

- A device plugin advertises the configured extended resource (for example `opensteer.com/fuse`)
  and grants its allocated Runner container access to `/dev/fuse`. The Runner is not privileged and
  uses no host path, host networking, or host PID/IPC namespace. It receives `SYS_ADMIN`,
  `DAC_READ_SEARCH`, and an unconfined AppArmor profile only inside the allocated container, and it
  sets `allowPrivilegeEscalation: true` because the setuid FUSE helper cannot run under a `no_new_privs`
  process. Creating a deployment fails when no node advertises the resource.
- Every node that can run these pods carries the seccomp profiles `opensteer/runner.json` and
  `opensteer/chromium.json` under the kubelet seccomp root. The Runner and browser containers
  reference them as `Localhost` profiles, so their pods do not start on a node that lacks the files.
- The configured storage class supports `ReadWriteOnce` persistent volumes and has reclaim policy
  `Delete`; a retaining storage class is rejected the same way.
- `kubernetesApiServer` is the separate hosting cluster's bare HTTPS API origin and `kubernetesCa`
  is that cluster's CA certificate. The Account runtime must have private network reachability to the
  endpoint. It authenticates with short-lived OAuth tokens from its GKE Workload Identity metadata
  server; no static Kubernetes or Google credential is stored in the template.
- A shared HTTPS router reaches each namespace's `host` Service on port `4310` and validates the
  canonical managed hostname before selecting that Service. NetworkPolicy admits the router only
  when its namespace has `opensteer.dev/role=hosting-system` and its pod has
  `app.kubernetes.io/name=hosting-router`. `ingressSourceCidrs` may additionally identify genuine
  load-balancer or proxy sources and can be empty; it must never contain a shared tenant Pod CIDR.
- The cluster network plugin enforces Kubernetes NetworkPolicy. The default tenant policy admits
  only same-namespace traffic, DNS, the public Internet excluding private/link-local ranges, and
  configured ingress sources. A second egress policy admits the configured PortableFS manager CIDRs
  for the `host`, `runner`, and `managed-teardown` pods, because the mount daemon renews its own
  enrollment with Manager directly.
- Every image in the template is pinned by a full `@sha256:<64 hex digits>` digest.
  `portableFsMountImage` is a small materializer image built by infrastructure from the verified
  PortableFS release capsule. It provides a shell, `sha256sum`, and the capsule's
  `hosted/bin/portablefs` at `/portablefs/portablefs`. The init container verifies it against
  `portableFsMountSha256` before copying it into the Runner's private executable volume. The
  `portablefs-files` release image cannot fill this role because its scratch root contains only the
  files service binary.
- The PortableFS product identity belongs to the trusted Opensteer platform Host tier. Its manager
  client key and product signing key are projected only into the Host pod. Runner and browser
  containers, including user-created processes, never receive those keys.

These prerequisites are checked per create request, not at process start: `validateConfiguration`
runs inside the create path, so a cluster that loses the FUSE resource or gains a retaining storage
class refuses new deployments while existing ones keep reconciling.

The control-plane service account needs cluster-scoped `get`, `create`, `patch`, and `delete` on
Namespaces, plus `get` on StorageClasses and `list` on Nodes for that prerequisite validation.
Within namespaces matching the configured prefix it needs the same verbs on Secrets,
Services, PersistentVolumeClaims, Deployments, NetworkPolicies, and teardown Jobs, plus `patch` on
the `deployments/scale` subresource that deletion uses to stop workloads, and `list` on
Pods so teardown waits for terminating workload processes. Native
RBAC cannot restrict namespace creation by name prefix, so the provider must run under a dedicated
service account and admission policy must enforce the prefix and managed-by label.

## Activation and readiness

`OPENSTEER_CLOUD_TEMPLATE_PATH` points to the strict version 1 JSON template. The provider is absent
when that setting is absent; the portal must not advertise managed Cloud in that state. Applying the
same operation is idempotent through Kubernetes server-side apply.

The template has two halves. The operation's encrypted snapshot pins only its _placement_: the
hosting cluster endpoint and CA, the namespace prefix, the immutable PVC storage class, the
cluster's FUSE resource name, the PostgreSQL image (a major-version bump would refuse the existing
data directory), and the PortableFS product issuer and service ID that name its existing volumes.
Everything else is the _release_ and is re-applied from the loaded template on every reconcile: all
Opensteer images, the PortableFS mount image and its digest, the PortableFS manager endpoint,
CIDRs, CA, client certificate and keys, and the ingress source CIDRs. Credentials and endpoints
that rotate must be allowed to rotate; a pinned client certificate would eventually expire against
its own deployment. Snapshots written before this split carry a whole template; the extra fields
are stripped, never honoured. The template file itself is read once, when the process builds the
provider, so editing it takes a control-plane restart to reach running reconciles.

Provider readiness requires PostgreSQL, Host/files, Runner, browser egress, browser, and messaging
Deployments to have observed their current generation with one updated and available replica. Every
managed Deployment sets `progressDeadlineSeconds` explicitly, so `Progressing=False` is Kubernetes'
own terminal verdict on a stuck rollout: the operation then fails immediately naming that workload
and the reason rather than waiting out the operation's wall clock, and while it is still coming up
the page says which workloads it is waiting on. Host authority is verified separately by the
lifecycle against the signed discovery document at the canonical origin, which Kubernetes cannot
judge. The lifecycle's own 20 minute wall clock is the outer bound on every operation — rollout,
publication and discovery, and deletion alike — measured from the operation's last state change and
reached only when nothing else has already named a failure.

The Runner removes its readiness marker on startup, reconnect, disconnect, and stop, and writes it
only after the Host has authenticated the WebSocket and accepted the Runner identity. Its startup
preflight also checks the PortableFS mount executable before connecting. The probe validates that the
marker belongs to the current process, so readiness proves the current Host attachment and storage
preflight. It does not execute a workspace job or mount canary.

Ordinary Kubernetes Secrets are used only after the lifecycle decrypts the durable operation material.
The API client talks to the pinned hosting-cluster HTTPS endpoint with its pinned CA and a
short-lived Workload Identity OAuth token. Template changes do not redirect an operation already in
progress because the endpoint, CA, namespace prefix and storage class travel in its encrypted
configuration snapshot.
Host private material is copied to a Host-only `emptyDir` volume with mode `0600`; that volume is
disk-backed, and only the browser pod's `home` and `shm` volumes use `medium: "Memory"`. Runner,
browser, PostgreSQL, and messaging workloads receive separate least-privilege Secrets.
Workload and teardown pods disable automatic Kubernetes service-account token mounts.

A namespace that never got its `postgres-data` PersistentVolumeClaim holds no database to read, so
deletion skips the scale-down and the teardown Job and deletes the namespace directly. Otherwise
deletion first scales the Runner, Host/files, browser, browser egress, and channel Deployments to zero
while retaining PostgreSQL and all persistent material. After Kubernetes observes every workload
stopped, a Host-image Job runs `destroy-managed-main.js` with the pinned deployment ID and destroys every PortableFS volume.
The Job migrates an existing Host database before reading it with the current Host's schemas;
a provably pristine database needs neither migrations nor volume destruction.
Teardown validates only its Host and database material, so deployments created before separate
browser and messaging enrollment credentials existed can still be deleted.
Only a successful Job permits foreground namespace deletion. A failed or incomplete Job leaves the
database, Secret, and volumes intact for an idempotent retry.

## Account lifecycle

Cloud is a provisioning operation for the existing `server` / `portablefs` Deployment shape. It does
not introduce a second Host API, runner registry, or storage model. Desktop and the portal invoke the
same Account lifecycle; independent servers and local Personal deployments retain their existing
setup and authentication paths.

The Account commits a deployment identity, OAuth client, owner, encrypted credentials, and hosting
template snapshot in one transaction. The client supplies an operation UUID. Repeating that request
returns the same deployment; changing its name or Account cannot reuse the UUID. A PostgreSQL session
lock serializes each operation across Account replicas. The worker resumes committed operations after
restart, and every provider effect is idempotent. The captured snapshot fixes resource names and
placement for the lifetime of the operation; the release follows the Account.

Present deployments converge to the current release. Each operation records the release it last
applied, and the reconcile query selects operations that are creating or deleting _and_ ready
operations whose applied release differs from the one this Account runs. Server-side apply is
idempotent and Kubernetes restarts only pods whose spec changed, so re-applying an unchanged
release is a no-op and a converged deployment is never touched. A deployment being rolled forward
stays `ready` — it exists and is registered — and shows what it is waiting on. If the rollout
stalls, the operation becomes `failed` with the workload named, and Retry re-runs the converge
against the images the Account now runs, which is also how a deployment created from a broken
release recovers.

Teardown executes the Host secret-staging and destruction entrypoints from the currently deployed
provider image while retaining the captured namespace and credentials. Because the release is
live, teardown always runs the current Host image against the current PortableFS manager, so no
Host release has to keep code for destroying older template versions.

`creating` becomes `ready` only after all workloads are healthy, the Host publishes its pinned signed
authority, and public HTTPS discovery verifies that exact Host. The UI calls this durable result
“Created”; current connection availability remains the shared deployment-status policy. Membership in
an Account directory is never proof of network health.

Deletion records its intent and revokes Account entry points before teardown. It retains the operation
and credential material until external storage and namespace destruction finish, then removes the
Account registration and clears the encrypted material in one transaction. A tombstone prevents an
old create request from recreating the deployment. Removing a deployment from an Account list is a
separate visibility preference and does not destroy it or revoke Host permissions.

Activation requires both `OPENSTEER_CLOUD_TEMPLATE_PATH` and `OPENSTEER_CLOUD_OPERATION_KEY` (a separate,
canonical base64url encoding of 32 random bytes). Do not reuse the adoption or Personal Account-link
key. Without hosting configuration, existing operations remain readable and creation controls stay
absent. An Autopilot cluster is never a supported activation target, for the `/dev/fuse` and
`SYS_ADMIN` reason above.
