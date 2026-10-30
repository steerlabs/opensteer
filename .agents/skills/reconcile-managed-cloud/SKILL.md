---
name: reconcile-managed-cloud
description: Inspect managed Kubernetes operations and apply template changes when operating Opensteer Cloud.
---

# Reconcile managed Cloud

Read [cloud constraints](../../../apps/control-plane/src/cloud/README.md) and the
provider/lifecycle code before changing managed infrastructure. Do not create
credentials or read key material; the operator supplies the template and operation
key. Preserve placement and the separate release configuration.

Inspect the explicit hosting context and namespace, never an implicit current context:

```sh
kubectl --context HOSTING_CONTEXT -n MANAGED_NAMESPACE get deployments,pods,pvc,jobs
kubectl --context HOSTING_CONTEXT -n MANAGED_NAMESPACE describe deployment WORKLOAD
kubectl --context HOSTING_CONTEXT -n MANAGED_NAMESPACE logs job/TEARDOWN_JOB
```

Check named rollout failures before the lifecycle deadline, then verify public
signed discovery against the pinned identity. Pod availability alone is not proof.
After an authorized template change, restart the control-plane through its actual
deployment manager: the file is loaded once. Inspect reconciliation of both new
and already-ready operations. Retry failed operations through the Account lifecycle
so they use the current release. Do not delete namespaces or PVCs to clear a
failure: teardown must stop workloads and destroy PortableFS before namespace
removal. Keep failed teardown material for retry.
