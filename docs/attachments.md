# Message attachments

## Storage and ownership

The Host owns immutable originals; PostgreSQL owns authorization and message
binding. Back up the database and Host data directory together. A database-only
restore leaves files unavailable; downloads verify length and checksum.
User filenames never become Host paths. Sources: `packages/database/src/attachment-store.ts`
and `apps/host/src/attachments`.

Only ready originals can be claimed, atomically with message creation and after
idempotency replay. One original belongs to one human message; a claimed original
cannot be discarded or overwritten. Editing queued input may transfer IDs only
after explicit withdrawal while pending, with no confirmed delivery or unresolved
claim. Unknown delivery cannot be treated as withdrawal. Recheck the new engine's
support; old cancelled messages and bytes stay immutable.

Cleanup cannot delete bound originals. Reservation/deletion state and row locking
must survive interrupted finalization and cleanup. Quotas include pending bytes;
see the source for limits rather than maintaining a second list here.

Clients upload bytes, never a local filesystem path to the remote Host. Mobile
keeps picked files in private draft storage. Pending-send identity and retry rules
follow [mobile drafts](mobile.md).

## Image admission and engine delivery

Keep full-resolution originals. Validate actual bytes, complete decoding and
resource bounds; refuse mislabeled, animated or unsupported images before delivery.
Web/desktop convert HEIC locally; iOS photo picker converts it, while other mobile
HEIC input is refused. The web decoder uses `heic-to` (LGPL-3.0) in a blob worker;
CSP permits blob workers for this reason.

Image support requires both native engine transport and catalog-confirmed model
support, rechecked at Run dispatch/steer. Unknown capability refuses, never converts
silently or switches models. A document upload does not promise format support.
`packages/harness` and engine drivers own limits and `prepareNativeImage`.

Each engine path must deliver every admitted image within its own limits, including
images added during a Run. Preserve originals when already within those limits;
otherwise send an upright sRGB copy without metadata. Opensteer maintains no
per-model size tables because engines perform their own model fitting.

## Runner boundary

Session downloads enforce current workspace membership. Runner downloads use a
signed capability and recheck the current Run's execution binding. Inventory exposes
only delivered history and admitted current inputs, never pending queue items or
unselected reports. Its pagination is independent of transcript history.

Runner copies are disposable and checksum-verified, partitioned by canonical Runner
data directory and Thread. Immutable attachment IDs make paths unique; a sanitized
filename leaf preserves the name/type models and upload forms infer from paths.
Keep the cache outside private Runner state, Workspaces and remapped sandbox temp
folders. Stable paths survive continuation; clear copies after a Run and restore
from the Host for the next one.

Linux service Runners mount only the current Thread cache read-only. macOS Codex
and Claude service Runners require verified provider sandbox rules for the same
scope. Windows service Runners must not advertise attachment support until that
boundary is verified. Personal desktop Runners retain native-user access.
