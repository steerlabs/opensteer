# Message attachments

The Host owns uploaded bytes. PostgreSQL stores the reservation, checksum, state,
uploader, workspace, and eventual message binding. The Host data directory stores
immutable originals at `attachments/originals/<attachment-id>`; user-supplied
filenames never become paths. Back up the database and Host data directory as one
deployment. A database restore without matching originals makes affected files
unavailable; the Host checks length and SHA-256 before every download.

An uploader reserves an ID through `commands.dispatch` with
`attachment.upload.create`, transfers exactly the reserved byte count through the
typed `attachment.upload` RPC, and sends that ID as an `artifact` content part.
The Host validates image bytes and computes the checksum before marking the row
ready. Finalization links a temporary file to the canonical path while holding
the attachment row lock. A ready original is never overwritten. The send claims
ready rows inside the same transaction that creates the message, after exact
idempotency replay has already returned. A claimed original belongs to one
human message and cannot be discarded.

Editing a queued message withdraws it and creates a new send. The new send may
transfer the same attachment IDs only when the old input was explicitly
withdrawn while pending, with no confirmed delivery or unresolved claim. The
original bytes and old cancelled message stay immutable. A refused steer can
return a queued input to pending before withdrawal; a delivery with an unknown
outcome cannot. The new send rechecks the current engine's attachment support.

Upload reservations expire after 24 hours. Discard and expiry first mark an
unbound row deleting, then remove its bytes. Startup and periodic cleanup finish
interrupted deletion and remove old temporary files. A bound attachment is kept
with its message. Pending reservations count against the workspace pending-byte
quota of 250 MiB, and all retained originals count against a 2 GiB workspace
limit. One message has its own count and byte limits. The cleanup pass also
removes canonical files with no database row after a 24-hour grace period, so
workspace deletion and interrupted finalization do not leak bytes forever.

Web, desktop, and mobile use the same `@opensteer/client` operations. Desktop
spools bounded binary chunks through its authenticated preload bridge; mobile
uses its authenticated Expo fetch port and keeps picked files in private draft
storage. Neither sends a client filesystem path to a remote Host. Uploads are
limited to 25 MiB each, 10 files and 50 MiB per message. Other files are
delivered as readable files for the engine's tools; uploading a document does
not promise that every model or engine can interpret its format.

Images are stored at full resolution. The Host accepts single-frame PNG, JPEG,
and WebP of at most 100 million decoded pixels, a bound on its own resources
rather than on any model. It refuses other image types at reservation, before
any bytes move, and checks an upload from its header outward: a label its bytes
contradict, an animated image (including APNG), or an oversized one is refused
with the reason, and an image that passes is proven to decode completely. The
stored width and height are the upright size. Clients name a file by its bytes
before reserving it (`detectImageMediaType` in `@opensteer/core`). The web and
desktop composer converts HEIC to JPEG in the page at full resolution with
`heic-to` (LGPL-3.0), whose decoder runs in a blob worker; the web and desktop
content security policies allow `worker-src blob:` for it and nothing else. The
iOS photo picker converts HEIC itself; the mobile app refuses other HEIC with
the reason.

An image needs both a native image transport in the selected engine and a
catalog-confirmed image-capable model. The Host checks the selected Run's
capabilities again when dispatching or steering. Unknown capability is a clear
refusal, not an implicit conversion or model switch. Codex, Claude, Pi and
OpenCode have native image adapters; Cursor's print interface currently accepts
file paths only, so image input is refused.

Each driver guarantees every stored image reaches its engine on every path it
offers, and fits what it sends to that engine's own input limits with
`prepareNativeImage` in `@opensteer/harness`. An image already inside them is
delivered as the original; any other becomes an upright sRGB copy without photo
metadata. Engines still fit images to each model themselves, so Opensteer keeps
no model tables. The limits, and why, live beside each driver: Claude Code and
Pi fit a turn's first prompt but send images added to a running turn as they
are, and Pi's and Codex's protocol lines carry at most 4 MiB, so a delivery's
images share one byte budget. `pnpm test:engines` sends full-resolution photos
through every engine on both paths.

The exact send command is persisted before dispatch, partitioned by the stable
Deployment ID, signed-in user and Thread. An unanswered send retains its key and
content across retries; a definite Host refusal returns it to the draft. The
bootstrap Deployment ID is mandatory in Host API epoch 19, so mixed app/Host
versions receive the normal upgrade message rather than guessing identity from
a URL. Upgrade the Host and apps together.

Session RPCs enforce current workspace membership. Runner downloads use a signed
capability for the current Run and recheck its live execution binding. Inventory
contains delivered historical message references and current Run inputs that
have been selected or admitted for steering. Pending queue entries and unselected
reports remain invisible. Runner inventory is paged independently of bounded
transcript history, so a later Run can restore older admitted files.

Runner copies are disposable and checksum-verified in the Runner OS user's
cache, partitioned by canonical Runner data directory and Thread. Each file is
`<Thread>/<attachment ID>/<name>`: the immutable ID keeps paths unique, and the
leaf keeps the uploaded name, reduced to one safe path segment, because upload
forms, models and commands take a file's name and type from its path. They stay
outside the private Runner data directory, Workspace and temporary directories:
provider sandboxes deny private state, and sandbox temporary directories are
remapped. Custom data-volume mounts therefore do not require a writable sibling
directory. The cache is cleared after a Run and rebuilt from the Host for the
next one; its stable paths also survive provider continuation.

Linux service Runners expose only the current Thread's cache as a read-only
mount. Codex and Claude on macOS service Runners use verified provider sandbox
rules for the same scope. Windows service Runners do not advertise attachment
support until that boundary is verified there. Personal desktop Runners retain
their existing native-user access boundary.
