# Workspace storage and mount lifecycle

## Local-directory authority

The Host owns Workspace metadata, membership, status and deletion retention.
For a local directory, the Runner named by `ownerEnvironmentId` owns the bytes
and provisions, inspects, reads and destroys them through the
[workspace-local protocol](../packages/protocol/src/workspace-local.ts).

`storageAuthorityId` identifies the disk separately from execution placement.
The Runner mints it once in its protected registry, so copying a Runner
credential to another machine cannot authorize deletion on the wrong disk or
declare the original directory missing.

`WorkspaceAuthorityUnreachableError` establishes nothing about the disk. Keep
the last verified status; reconciliation skips the row, provisioning remains
outstanding, and deletion stays `deleting` until the same storage authority
returns a durable receipt. A response from a replaced connection cannot prove
the disk's state either.

## PortableFS ownership

The Host authorizes access to a Workspace. The Runner owns its machine's mount,
and PortableFS owns that mount's renewal and filesystem coherence. There is one
renewal loop, inside PortableFS; Opensteer never extends a grant locally or
retries a model's filesystem mutations.

This contract applies to every PortableFS-backed Workspace, whether the Host is
local, self-hosted, or managed. Local-directory Workspaces use their owning
Runner's local filesystem and do not enter this lifecycle.

## Connectivity and readiness

A Runner must reach the Host's grant-exchange URL, the storage authority, and the
Manager HTTPS endpoint included in its enrollment. Reaching the Host does not
prove the latter two. A self-host operator must choose a Manager URL reachable
from every enrolled Runner that uses PortableFS, including machines outside the
Host network, and provide the corresponding TLS trust and server name. Private
DNS works only for machines that can resolve and route to that private network.

Managed deployments grant egress to the declared Manager CIDRs to exactly the
Host, the Runner, and the managed-teardown job, because the mount daemon renews
its enrollment directly with Manager; the browser, browser-egress and messaging
pods do not receive this exception. The Runner uses an enrollment credential
scoped to its mount, never the Host's product credential.

PortableFS starts renewal immediately after mount creation. Opensteer accepts a
new mount only after inventory reports the expected path, volume and enrollment,
live health, and a successful automatic renewal. That proves the real
enrollment-authenticated path, rather than a separate TCP or health probe. The
check has a bounded deadline and honors cancellation; failure withdraws the
mount through PortableFS. Credentials remain intact if withdrawal fails.

## Failure and recovery

PortableFS fails closed when authorization expires or coherence cannot be
maintained. A revoked mount may still have a running daemon and a kernel mount;
process liveness alone does not make it usable.

On the next execution or trigger that needs the Workspace, the Runner serializes
mount work for that Workspace. It verifies the recorded volume and enrollment
before touching an existing mount. For its own mount whose health is reported as
revoked, credential-expired or stale, or whose daemon is no longer alive, it
requests ordinary PortableFS unmount, proves the old inventory entry is gone,
then obtains a fresh Host-authorized enrollment and proves readiness again. It
never force-unmounts or substitutes another volume.
Unknown live health states and mismatched identities remain explicit failures.

A new grant still depends on current access. Remounting therefore cannot undo a
membership revocation. Existing file handles do not migrate into a replacement
mount, and interrupted operations are not replayed. Recovery allows subsequent
work; it cannot promise completion of work interrupted by storage failure.

A release's live storage verification must observe renewal beyond the initial
authorization lifetime; initial mount/write success alone does not prove
sustained operation. No automated check enforces this.
