# Workspace storage and mount lifecycle

## Project trust

Projects are shared work contexts, not security sandboxes. A Run's working directory, writable roots
and instructions guide file access; they do not isolate it from the owner's computer. Members of a
shared Project must be trusted users of that computer. Project membership does not grant Main
membership or authority over its connected accounts.

## Local-directory authority

The Host owns metadata, membership and retention; the owning Runner owns local bytes. Its protected
registry mints a disk identity separately from execution placement, so copying Runner credentials
cannot authorize deletion on another disk or declare the original missing. See
[workspace-local protocol](../packages/protocol/src/workspace-local.ts).

An unreachable or replaced authority connection proves nothing about disk state. Keep verified
status and pending provisioning/deletion until the same storage authority returns a durable receipt.
