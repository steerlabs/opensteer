# Workspace storage and mount lifecycle

## Local-directory authority

The Host owns metadata, membership and retention; the owning Runner owns local
bytes. Its protected registry mints a disk identity separately from execution
placement, so copying Runner credentials cannot authorize deletion on another
disk or declare the original missing. See
[workspace-local protocol](../packages/protocol/src/workspace-local.ts).

An unreachable or replaced authority connection proves nothing about disk state.
Keep verified status and pending provisioning/deletion until the same storage
authority returns a durable receipt.

## PortableFS ownership

The Host authorizes Workspace access; the Runner owns its mount; PortableFS owns
renewal and coherence. Opensteer must neither extend grants locally nor replay
model filesystem mutations. This applies to all PortableFS deployment shapes,
not local-directory Workspaces. See
[mount storage](../packages/database/src/workspace-mount-store.ts) and
[Runner workspace code](../apps/runner/src/workspace).

## Connectivity and readiness

Host reachability does not prove access to storage or the enrollment's Manager
HTTPS endpoint. Self-hosted Manager DNS, routing and TLS must work from every
Runner, including those outside the Host network.

Managed Manager egress is limited to Host, Runner and managed teardown, excluding
browser and messaging pods. Mount renewal uses a mount-scoped enrollment
credential, never the Host's product credential.

Accept a mount only after inventory proves path, volume, enrollment, live health
and successful automatic renewal. A TCP probe cannot prove enrollment authority.
Readiness has a bounded deadline and honors cancellation. Failed readiness
withdraws through PortableFS; failed withdrawal retains credentials.

## Failure and recovery

PortableFS fails closed on expired authorization or lost coherence. A live daemon
and kernel mount do not prove usability. Recovery serializes per Workspace,
verifies volume/enrollment, and for an unhealthy owned mount uses ordinary
unmount and proves inventory removal before fresh enrollment and readiness.
Never force-unmount or substitute volumes. Unknown live health and mismatched
identity remain failures.

Fresh enrollment requires current access, so remount cannot undo revocation.
Open file handles do not migrate; interrupted operations are never replayed.
Recovery enables later work, not completion of interrupted work.

Release storage verification must observe renewal beyond the initial grant
lifetime. Initial mount/write success is insufficient; no automated check
enforces this duration.
