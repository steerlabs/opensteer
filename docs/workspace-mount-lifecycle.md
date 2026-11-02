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
