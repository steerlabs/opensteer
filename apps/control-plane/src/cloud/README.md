# Kubernetes managed Deployment provider

This provider installs one fixed Opensteer server topology per Kubernetes namespace. It is intended
for a Standard GKE cluster. Workspace bytes stay on the owning Runner's persistent disk.

## Cluster prerequisites

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
  only same-namespace traffic, DNS and the public Internet excluding private/link-local ranges.

Validate prerequisites on every create, not only startup: existing Deployments
may reconcile while new creation is refused. Native RBAC cannot restrict namespace
creation by prefix. Use a dedicated control-plane service account and admission
policy enforcing the prefix and managed-by label. The exact required verbs and
resource kinds follow [the provider](kubernetes-managed-deployment-provider.ts).
Do not omit scale-down or pod-list authority needed to prove workloads stopped.

## Activation and readiness

Activation requires both `OPENSTEER_CLOUD_TEMPLATE_PATH` and the independent
`OPENSTEER_CLOUD_OPERATION_KEY` (canonical base64url, 32 random bytes). Never reuse
adoption or Personal Account-link keys. Without hosting configuration, existing
operations stay readable and creation controls stay absent. The template is read
once at process construction; edits require a control-plane restart.

Encrypted operation snapshots pin placement: cluster endpoint/CA, namespace prefix,
PVC storage class and PostgreSQL major version.

Kubernetes readiness proves observed rollout generation and availability, not
Host authority. Signed discovery at the canonical public origin must verify the
pinned Host separately. A workload's `Progressing=False` is terminal; do not wait
for the outer lifecycle deadline to hide its named failure. Runner readiness
must belong to the current process and authenticated Host attachment, with storage
preflight; it is not a workspace job or mount canary.

Ordinary Kubernetes Secrets are used only after the lifecycle decrypts the durable operation material.
The API client talks to the pinned hosting-cluster HTTPS endpoint with its pinned CA and a
short-lived Workload Identity OAuth token. Template changes do not redirect an operation already in
progress because the endpoint, CA, namespace prefix and storage class travel in its encrypted
configuration snapshot.
Host private material is copied to a Host-only `emptyDir` volume with mode `0600`; that volume is
disk-backed, and only the browser pod's `home` and `shm` volumes use `medium: "Memory"`. Runner,
browser, PostgreSQL, and messaging workloads receive separate least-privilege Secrets.
Workload and teardown pods disable automatic Kubernetes service-account token mounts.

Deletion must stop Runner, Host, browser, browser egress and messaging
processes before destroying storage. Keep PostgreSQL and private material until
the current Host-image teardown Job succeeds. Migrate an existing database before
reading it with current schemas; pristine databases need no volume destruction.
Only then delete the namespace in foreground. Failed/incomplete teardown retains
database, Secrets and volumes for idempotent retry. A namespace with no database
PVC may be deleted directly.

## Account lifecycle

Commit identity, OAuth client, owner, encrypted credentials and placement snapshot
atomically. An operation UUID is idempotent only for its original Account/name.
Serialize each operation across Account replicas, resume after restart and keep
provider effects idempotent. Placement stays fixed; release follows the Account.
Ready operations also converge when the release changes; unchanged specs are a
no-op. A stalled rollout becomes failed with its workload named. Retry converges
to the release the Account now runs. Teardown likewise uses current provider code
with captured placement/credentials, not an obsolete image.

Ready means workloads healthy, pinned authority published and public HTTPS
discovery verified. Account directory membership is never evidence of network
health; connection status uses the shared policy.

Deletion records intent and revokes Account entry points before teardown. Retain
operation/credentials until storage and namespace destruction finish, then remove
registration and clear encrypted material atomically. A tombstone prevents replay
of the old create. Hiding a Deployment in the Account list neither destroys it
nor revokes Host permissions.

Use [reconcile-managed-cloud](../../../../.agents/skills/reconcile-managed-cloud/SKILL.md)
when inspecting or changing managed infrastructure.
