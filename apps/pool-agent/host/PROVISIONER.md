# The pool host, from the provisioner's side

Written for whoever builds the provisioner's hosts and slots. It is taken from the code at
`browser-pool-agent` as of this page. Every claim names its file and function (round I, U7: not line numbers, which drift).

## 1. The administration interface

**Transport.**

- `POST /v1` on the admin listener: `agent.json` `admin.listen`, port `OSP_ADMIN_PORT` 7311
  (`setup-host.sh`, `OSP_ADMIN_PORT`).
- The host firewall drops it from anywhere but loopback and `OSP_PROVISIONER_CIDR`
  (`setup-host.sh`, `host_firewall`). The provisioner's side is already written:
  `callBrowserPoolAgentAdmin` (`packages/browser-runtime-core/src/browser-pool-agent-wire.ts`, `callBrowserPoolAgentAdmin`).

**Envelope** (`browser-pool-agent-wire.ts`, `BrowserPoolAgentAdminEnvelope`):

```text
{ v: 1, host, issuedAt, nonce, request }
```

- `host` is the host id the provisioner enrolled. A request naming another host is refused
  (`apps/pool-agent/src/server.ts`, `createAdminServer`).
- `issuedAt` must be within 5 minutes of the host's clock (`browserPoolAgentRequestWindowMs`,
  `browser-pool-agent-wire.ts`, `browserPoolAgentRequestWindowMs`; `server.ts`, `createAdminServer`).
- `nonce` makes each envelope distinct. **There is no nonce ledger.** Replays are made harmless
  by idempotency and terms (below), not by remembering nonces.

**Who signs what.**

- The provisioner signs `browserPoolAgentAdminBytes(envelope)`
  (`browser-pool-agent-wire.ts`, `browserPoolAgentAdminBytes`, canonical JSON) with its Ed25519 key. Its public half is
  `agent.json` `admin.provisionerKey`, checked at `server.ts`, `createAdminServer`.
- The host signs every reply with its host key: `browserPoolAgentAdminReplyBytes(requestBytes,
reply)` (`browser-pool-agent-wire.ts`, `browserPoolAgentAdminReplyBytes`), i.e. sha256 of the request plus the canonical
  reply (`server.ts`, `createAdminServer`). The client checks it against the host key pinned at enrolment
  (`browser-pool-agent-wire.ts`, `callBrowserPoolAgentAdmin`).
- **What a reply proves:** this host, holding the enrolled host key, answered this exact
  request.

**Calls** (schema: `server.ts`, `adminSchema`; handling: `server.ts`, `administer`).

| Call                                                                                                    | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Idempotency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create {slotId, term, homeKey, relayKey?, ticketKey?, guest: {vcpus, memoryMib, profileMib, egress?}}` | Makes the slot and its number, namespace and proxy socket, and its profile disk if none is there (section 4). No guest is started. The reply's `slot.controlKey` is the slot's own public key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A repeat with the same `homeKey` and `term` returns the same slot and touches no file. Another key or term is `conflict`. A create at or below a deleted slot's last term is `conflict`, for the 30 days its tombstone is kept (`agent.ts`, `#create`, `agent.ts`, `tombstoneRetentionMs`). A profile that cannot be made leaves no slot and no file (`agent.ts`, `#create`); one whose room the profiles' filesystem cannot guarantee is a signed `profile-disk-full` and nothing is made (round I / J4: the new size plus what every existing profile may still fill in, against what an unprivileged writer can still use, `bavail`) (`profiles.ts`, `ensureProfile`, `agent.ts`, `#create`, `server.ts`, `administer`). On a host that pulls egress (section 8) a create names no `egress`, or it is `conflict` (`agent.ts`, `#create`). |
| `replace-key {slotId, term, homeKey, relayKey?, ticketKey?}`                                            | A new Home key set at a higher term, in one journal write. The old set is refused from then on. **The guest is ended and its saved state discarded; the next start is cold.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The same term and keys again is a no-op. A lower or equal term is `conflict` (`agent.ts`, `replaceKey`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `delete {slotId, term, eraseProfile?}`                                                                  | Ends the guest, erases saved state, the network and the proxy, and writes a tombstone. Answers `{erased: true}` only after the VMM's exit was seen and the files are gone. It also removes the slot's upstream credential files before its record goes, and adds `credentialsErased: true` once they are seen gone, also when the slot has none, and on a pulling host for a slot it no longer knows (a file another live slot also names is kept, and the field is absent; a file that cannot be removed fails the delete, which may be sent again). Settle a deletion on `erased`, `profileErased` and `credentialsErased` all true. With `eraseProfile: true` it then removes the profile disk and adds `profileErased: true` only once the file is seen gone; if it cannot, the delete is refused (`unavailable`) and may be sent again (`agent.ts`, `deleteSlotWithEvidence`, credentials at `agent.ts`, `deleteSlotWithEvidence`, `server.ts`, `administer`). | A delete naming another term is `conflict` and erases nothing; so is one naming a tombstoned slot at a term below its tombstone's (round I). A slot already gone, or never known, answers `erased: true`; with `eraseProfile` a leftover profile at that slot id's path is removed, with the same evidence (`agent.ts`, `deleteSlotWithEvidence`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `list`                                                                                                  | Every live slot: `slotId`, `term`, `controlKey`, `status`, and `parked: {tier, writeMs?}` while paused (`agent.ts`, `#summary`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Read only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Refusals** (`server.ts`, `administer`, and the envelope checks above): `conflict`, `profile-disk-missing`, `profile-disk-full`, `unknown-slot`, `unavailable`, `bad-request`,
`stale-request`, `unauthenticated`. The client throws `BrowserPoolAgentUnavailable` for any of
them.

**Telling a refusal from no answer (round G).** The client throws `BrowserPoolAgentUnavailable`
for every failure. Its `refusal` field holds the answer's code only when the host key's
signature over that answer verified (`browser-pool-agent-wire.ts`, `BrowserPoolAgentUnavailable`).

- **`conflict`, `profile-disk-full`, and `unknown-slot`:** the call did nothing.
- **`profile-disk-missing`:** the host's profile disk is not the mount it was told to expect
  (section 7). No profile was made or erased. A delete may have ended the guest and erased its
  credentials first; send it again once the disk is back.
- **A signed `unavailable`:** the host answered but could not finish, so the effect may be
  partial. Read `list`, or send the call again.
- **No `refusal`:** no verified answer; the effect is unknown. This includes `bad-request`,
  `unauthenticated` and `stale-request`, which the host sends unsigned (`server.ts`, `createAdminServer`).

## 2. What a host reports at setup

`setup-host.sh install` (`setup-host.sh`, its `install` mode) does not enrol the host. It makes what enrolment
needs, and the operator writes `/etc/opensteer-pool/agent.json` from the provisioner's values
(`HOST-SETUP.md`, "Agent configuration").

| Fact                                 | Where it comes from                                                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host id                              | Chosen by the provisioner, written into `agent.json` `admin.hostId` (`apps/pool-agent/src/config.ts`, `agentConfigSchema`). Not generated on the host.                                                                  |
| Host key (pin it)                    | `host_key()` makes `/etc/opensteer-pool/host-key.pem` (root, 0600) and publishes `/etc/opensteer-pool/host-key.pub` (`setup-host.sh`, `host_key`). It signs admin replies and the answer that a slot was deleted.       |
| Relay key (pin it; not the host key) | `/etc/opensteer-pool/relay-key.pem`, certificate `/etc/opensteer-pool-relay/relay-cert.pem`, public half `/etc/opensteer-pool-relay/relay-key.pub` (`setup-host.sh`, `host_key`).                                       |
| Relay address                        | `relay.json` `listen` 0.0.0.0:`OSP_RELAY_PORT` 7312 (`setup-host.sh`: `OSP_RELAY_PORT`, and `relay.json` in `install_units`). The firewall allows only loopback and `OSP_HOME_CIDR` (`setup-host.sh`, `host_firewall`). |
| Agent's Home address                 | `agent.json` `listen`, port `OSP_AGENT_PORT` 7310 (`setup-host.sh`, `OSP_AGENT_PORT`). Same firewall rule as the relay.                                                                                                 |
| Admin address                        | `agent.json` `admin.listen`, port 7311 (above).                                                                                                                                                                         |

The host's IP address is the provisioner's to know; the host prints none.

## 3. What the Home is handed, and what it hands back

**The Home makes its keys and hands back only their public halves.**

- It makes `ManagedBrowserPoolHomeKeys`: `homeKey`, `relayKey` plus a self-signed
  `relayCertificate`, and `ticketKey` (`apps/host/src/browser/managed-pool.ts`, `ManagedBrowserPoolHomeKeys`).
- `managedBrowserPoolRegistration(keys)` (`managed-pool.ts`, `managedBrowserPoolRegistration`) returns `{homeKey, relayKey,
ticketKey: {keyId, spki}}`, each as SPKI DER base64. These are exactly the key fields of
  `create` and `replace-key`.
- **Private keys never leave the Home.**

**The provisioner hands the Home public material only**
(`ManagedBrowserPoolTarget`, `apps/host/src/browser/browser-pool-agent-client.ts`, `ManagedBrowserPoolTarget`, with the
relay of `managed-pool.ts`, `ManagedBrowserPoolRelay`; built by `managedBrowserPool(target, keys)`,
`managed-pool.ts`, `managedBrowserPool`):

```text
{ kind: "managed-pool", agentUrl, slotId, term,
  agentKey: <create reply's slot.controlKey>,
  hostKey: <host-key.pub as SPKI base64>,
  relay: { host, port, relayHostKey: <relay-key.pub as SPKI base64> } }
```

## 4. The profile disk

The agent makes and erases it, because it is the only party on the host (round G). The
provisioner never sends a path and never touches the file. On a provisioned host the agent also
refuses to make, use or erase a profile while `driver.profilesRoot` is not the mount it was told
to expect (`driver.profilesMount`, section 7).

- **Its path is derived from the slot id alone:** `<profilesRoot>/slot-<sha256 of the slot
id>.ext4` (`apps/pool-agent/src/profiles.ts`, `profileFileName`).
  - No slot id reaches a file elsewhere or another slot's file. `profilesRoot` defaults to
    `/var/lib/opensteer-pool/profiles`, which setup makes 0711 (`setup-host.sh`, `install_units`).
  - The earlier `guest.profilePath` is still accepted on the wire, but only if it is that same
    path. Anything else is `conflict` (`agent.ts`, `#create`).
  - The boot checks stay: a plain file under the root, not a link (`firecracker/paths.ts`, `confine`,
    `firecracker/driver.ts`, `confineGuest` and `#prepareJail`).
- **`create` with `profileMib`** (64 MiB to 1 TiB, `server.ts`, `adminSchema`):
  - **No file there:** the agent makes a sparse file of that size with an ext4 filesystem
    (`mkfs.ext4 -q -F -m 0`, `firecracker/driver.ts`, `ensureProfile`). It makes it under a temporary
    name and links it into place only once it is formatted (`profiles.ts`, `ensureProfile`). A make that
    fails leaves nothing under the slot's name, and the create is refused with no slot. A
    temporary file a crash left behind is removed when the driver opens (`profiles.ts`, `sweepUnfinishedProfiles`,
    `firecracker/driver.ts`, `open`).
  - **A file there:** kept exactly as it is, never formatted, whatever `profileMib` says. This is
    what lets a replaced host instance keep every profile: the provisioner creates the slot again
    at a higher term, and the person's profile is still theirs.
- **What the agent does to it at each boot:** chowns it to the slot's uid, sets 0600 and
  bind-mounts it into the jail (`firecracker/driver.ts`, `#prepareJail`). The guest mounts it as
  `/dev/vdb` (`apps/pool-agent/guest/init.sh`, its profile mount).
- **Erasing it.** Only `delete` with `eraseProfile: true` removes a profile (section 1).
  - No other call removes one: not a failed create, not a rollback, not `replace-key`.
  - Without `eraseProfile` the file stays for the same slot id's next create.
- **A tombstoned slot's file and a new create.** The tombstone refuses a create at or below the
  deleted term. A create above it, for the same slot id, finds the kept file and uses it: the
  slot id is the person's Cloud Computer. A file is never handed to another slot id, because the
  path is derived from the id.
- **Credential files.** On a host that pulls egress (`driver.requireEgressUpstream`), the agent
  fetches and writes them itself (section 8); the provisioner never places one. On a host that
  does not, they are files the create names under `driver.credentialsRoot`, placed by its
  operator.
- **What a delete leaves:**
  - the host user `osp-egress-<n>`, reused by the next slot on that number
    (`firecracker/egress.ts`, `ensureEgressUser`);
  - a journal tombstone holding no secret, pruned after 30 days;
  - without `eraseProfile`, the profile.
- **What the agent removes itself:** the guest, its saved state, its jail, the namespace and
  proxy units, the slot's credential files (unless another live slot names the same file), and
  the slot number. A number is freed only after every piece of work using it
  has ended (`firecracker/slot-numbers.ts`).

## 5. Capacity

- **The agent enforces a capacity, but does not report it on the wire.** It logs it once at
  start: `{"event":"capacity","guestBytes","proxies"}` (`agent.ts`, `start`). The values come from
  `capacity.ts`: `guestCharge`, `guestBudget`, `hostCapacity`, `fits`:
  - `guestBytes` = host memory less max(2 GiB, 10 %) less the proxies' slice (1,536 MiB);
  - each guest in memory is charged its memory + 512 MiB;
  - `proxies` = slice / 128 MiB.
- **A start or a wake from disk that doesn't fit** first saves guests paused in memory to disk,
  oldest park first. If that isn't enough, it is refused as `unavailable`, "This host has no
  memory for another guest now; try again later." (`agent.ts`, `#admitted`). The Home's journal sends it
  again later.
- **To place by capacity,** compute from the host's memory with `capacity.ts`, and read
  occupancy from `list`: each slot's `status.phase`, plus `parked.tier` while paused.
  `maximumSlots` is 16,384 per host (`firecracker/slot-numbers.ts`, `maximumSlots`).

## 6. What the provisioner must never do

- **Never hand a slot to another person with `replace-key`.** The profile disk stays with the
  slot. `replace-key` is for the same person's Home taking new keys. A new person gets a new
  slot and a new profile disk.
- **Never reuse a `slotId` at or below a term it was deleted at,** and never let two slots share
  a profile disk or credential files.
- **Never send a profile path, and never reuse a slot id for another person.** A slot id's
  profile is found by the id: a create at a higher term for the same id gets the same person's
  profile. Use `delete` with `eraseProfile: true` when a Cloud Computer is deleted, and settle
  the deletion only on `erased: true` and `profileErased: true`.
- **Never delete, move or rewrite a profile disk while its slot exists.** The agent confines and
  mounts it at every boot.
- **Never hand the Home anything private:**
  - not the host key;
  - not the relay key;
  - not the provisioner key;
  - not the slot's control key, of which only its public half is on the wire.
- **Never take the Home's private keys either.**
- **Never pin the host key in the relay key's place.** The Home refuses a relay that presents
  the host key (`tests/browser-pool-relay.test.ts`, the impostor-relay tests).
- **Never treat an `unavailable` reply as a failed effect.** The call may have happened; read
  the slot with `list`. A start or wake refused for capacity did not happen.
- **Never edit `agent.json`, the journal or `slots.json` while the agent runs,** and never open
  the admin port beyond `OSP_PROVISIONER_CIDR`.

## 7. Replacing a host instance: what is on which disk

- **Today it is all one tree.** `setup-host.sh` keeps all of the agent's state in one directory,
  `/var/lib/opensteer-pool`, described as durable (`setup-host.sh`, `STATE`; `HOST-SETUP.md`, its table of disks, "on
  the persistent disk"). That tree holds:
  - the journal, with slot records and tombstones (`journal`);
  - the driver's slot numbers (`driver/slots.json`);
  - the profiles (`profiles`);
  - the guest images.
- **What is elsewhere.** Saved guest state lives on the instance's Local SSD array
  (`/srv/opensteer-pool`), which does not survive the instance. The host and relay keys live
  on the instance's own disk, under `/etc/opensteer-pool` and `/etc/opensteer-pool-relay`.
- **Setup mounts no separate disk:** `/var/lib/opensteer-pool` is wherever the boot disk puts it.
- **The safer arrangement for a replaced instance** is to keep only `profilesRoot` on the durable
  disk. The journal, `slots.json` and tombstones then stay with the instance, and the new
  agent comes up with no slots. The provisioner, whose record of slots is the truth, creates
  each again at a higher term; each finds its kept profile (section 4).
- **Why carried state is worse.** A journal carried to a new instance describes guests, saved
  states, namespaces and slot numbers of a machine that is gone, under a host key that is gone
  too. The agent would reconcile it to stopped slots, but every slot's control key would
  outlive the host that held it.
- **The rule this relies on:** a tombstone exists only on the instance that wrote it. So a
  replaced instance accepts a create at any term; the provisioner must still go above the
  term it last used.
- **The profiles root is the durable disk's mount point,** set by `driver.profilesRoot` in
  `agent.json`. How a provisioned host mounts that disk and enrols is the enrolment's to decide.
- **The agent holds the mount by itself when told to:** `driver.profilesMount` in `agent.json`
  (`config.ts`, `agentConfigSchema`). `{}` says `profilesRoot` must be a mount point, and
  `{ "label": "osp-<12 hex>" }` names its filesystem too. The label is `osp-` plus the first
  twelve hex characters of the SHA-256 of the host id, as the enrolment labels it. Without the
  setting nothing is checked, as before.
  - **The check** (`profiles-mount.ts`, `checkProfilesMount`; no privileged call): the root is a
    directory on a different device than its parent; with a label, `/dev/disk/by-label/<label>`
    is that device; and the root is writable.
  - **At the agent's start** a failed check stops it: it exits with a plain message
    (`agent.ts`, `start`). The host fails closed. Nothing on the agent's side waits for a disk
    that attaches late or comes back: an operator mounts it and restarts the two units
    (`systemctl restart opensteer-pool-host opensteer-pool-agent`).
  - **Before every `create` and `delete`,** a failed check is a definite, signed
    `profile-disk-missing` ("The profile disk is not mounted: …"). Nothing is made, nothing is
    erased, and a delete never answers `profileErased` (`agent.ts`, `#profilesMounted`,
    `#create` and `deleteSlotWithEvidence`; `server.ts`, `administer`).
  - **Again immediately before a delete erases the profile** (`agent.ts`,
    `deleteSlotWithEvidence`, its `erase`). A disk gone between the two checks gives the same
    `profile-disk-missing`, and the slot is left as it is then: its guest, saved state,
    network and credentials are gone and it is a tombstone, but its profile is kept. The same
    delete repeated once the disk is back finds the tombstone, erases the profile once at the
    same derived path, and answers `erased`, `profileErased`, and — on a host that pulls its
    egress — `credentialsErased`.
  - **Before every `start` and wake from disk,** a failed check gives a Home a stored, signed
    `applied: false` with reason `profile-disk-missing`, and nothing is booted (`agent.ts`,
    `#profilesRefusal`).
  - **A wake from memory, a park and a stop are not checked:** they do not open the profile
    again.
  - **A guest already running when the mount goes keeps its open profile,** and the agent can't
    see it: the check reads the root, not the guest's file. Its park, wake from memory and stop
    go on as usual, and its saved state stays on the array. Its next start or wake from disk is
    refused until the mount is back.

## 8. Egress on a host that pulls it (`driver.requireEgressUpstream`, rounds H and I)

No upstream, no start, and the host's credentials are a copy of what the account service says.

- **The proxy always requires an upstream.** Every slot's proxy unit is defined with
  `OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED=true` and `--use-system-ca` (`firecracker/egress.ts`,
  `defineEgress`; the one program, `firecracker/driver.ts`, `#program`). With no credentials it
  refuses everything; it never connects directly.
- **A unit is the slot's own only as this host defines it.** A definition is compared on its
  "upstream required" setting, its upstream, and where it loads its credentials from
  (`firecracker/driver.ts`, `#revivePulled` and `proxyRequiresUpstream`). Anything else is
  defined again at the slot's next start or wake. At the agent's start, a guest found running
  behind such a unit is ended (`agent.ts`, `start`).
- **A create names no `egress`.** The slot's credentials live at paths derived from its id:
  `<credentialsRoot>/slot-<sha256>.{url,username,password}` (`slot-credentials.ts`,
  `credentialFiles`).
  - They count as present only when all three are there.
  - They are written by temporary name and renamed into place, root-owned, 0600, in a root-only
    directory that may not be a symlink (`slot-credentials.ts`, `writePulledEgress` and
    `secureCredentialsRoot`).
  - A replaced set stops counting as present before it is rewritten.
  - A temporary file a crash left is swept when the driver opens, and never read
    (`firecracker/driver.ts`, `open`).
- **Every start and every wake from disk asks the account service first,** whether or not
  credentials are there, before anything is written or booted (`agent.ts`, `#withEgress`). The
  fetch has its own 10 s bound and takes the step's signal. A wake from memory asks nothing.
  - **Given:** checked as the proxy itself checks them (one function,
    `packages/browser-runtime-core/src/browser-egress-upstream.ts`; `slot-egress-fetch.ts`,
    `acceptSlotEgress`). They are written if they differ from what is there, and the proxy is
    defined again if its definition differs. Then the start goes on.
  - **None assigned:** what is there is removed, and a stored, signed `applied: false` with
    reason `egress-required` answers; nothing is booted.
  - **Proxy not serving.** Before `start`, the agent requires an active service and a `/health`
    answer within 5 s. A wake from either tier recreates a down socket and resets a failed or
    restarting service as needed before recording `consumed`. The bounded health probe then
    activates the proxy alongside restore or resume, and the socket queues early connections.
    Signed status reports a failed probe as `proxy: "down"` so the Home can park and wake the guest.
    The agent's periodic health recheck clears the report once the proxy serves again.
  - **The fetch could not be completed** (no answer, a refusal, a malformed answer, its
    deadline): what is there is used, if anything is. Otherwise it is refused as `unavailable`
    ("try again later"), with nothing written.
  - So a rotated password or a bad answer once written never wedges a slot, and an endpoint
    taken away stops being used at the next cold start.
- **`delete` ends the guest and its proxy first, then removes the credentials,** for a slot it
  no longer knows too. It answers `credentialsErased: true` once they are seen gone
  (`agent.ts`, `deleteSlotWithEvidence`). **Removing the files alone does not cut a proxy that is
  already running**: it read them when it started (run 8, item 4). Run 7 stopped the proxy's
  service to cut it. Credentials that change stop the slot's proxy service, so its next start reads the new copy.
  The stop runs after the old set stopped counting as present and before the new URL is in
  place, so a crash never leaves a complete new set beside a proxy on the old one. Credentials
  removed because none is assigned are removed first, and then the service is stopped
  (`firecracker/driver.ts`, `writePulledEgress` and `removePulledEgress`).
- **The fetch** (`slot-egress-fetch.ts`; `agent.json` `driver.egress.accountOrigin`, https only,
  `config.ts`, `agentConfigSchema`):
  - The request is `POST {accountOrigin}/v1/browser-pool/hosts/{hostId}/slot-egress` with
    `{v: 1, hostId, slotId, issuedAt, nonce, signature}`.
  - The signature is made by the host key over
    `opensteer-pool-slot-egress-v1\n<hostId>\n<slotId>\n<issuedAt>\n<nonce>`
    (`slot-egress-fetch.ts`, `slotEgressBytes`).
  - The answer is `200 {"egress": {url, username, password}}`, or `200 {}` for none.
    - `url` is `https://host:port` with an explicit port that is not 0, as the proxy requires;
      at most 1024 characters.
    - `username` and `password` are not blank, have no control character, are at most 1024
      characters, and the username has no colon.
    - Anything else could not be completed (`slot-egress-fetch.ts`, `parseAnswer` and
      `acceptSlotEgress`).
  - TLS uses the system's roots, no redirect is followed, and the answer is capped at 16 KiB. A
    reply cut off part-way fails at once.
  - The password is never logged, journaled or put in an error.

## 9. Stopping a running guest whose Home has gone silent

A Home that shuts down cleanly leaves its pooled sessions alive for adoption and polls a running
guest's signed status at least once a minute while it is up. If the Home never returns, the guest
runtime tears its sessions down and closes Chromium after 10 minutes (`pooledRuntimeSessionDeadlineMs`
in `packages/browser-runtime-core/src/browser-pool.ts`), leaving an empty micro-VM holding host RAM.
`homeSilenceSeconds` in `agent.json` (`config.ts`, `agentConfigSchema`; default `900` — 15 minutes;
lower bound `720` — 12 minutes, i.e., the runtime's 10-minute deadline plus a 2-minute margin,
enforced in both `agentConfigSchema` and `PoolAgent`) controls how long a running guest may go
without an authenticated call from its Home (`status`, `result`, `apply`, or an authorized relay
open) before the agent stops it through the slot's lane and journal, freeing its memory while
leaving the durable profile disk untouched. Parked guests are unaffected (their own `discardAt`
governs them), and an agent restart starts the silence clock fresh from restart time. Because this
bounds how long an orphaned running VM can hold a memory slot on the host, the host owner sets
`homeSilenceSeconds` to fit their host's capacity budget. When the agent stops a silent guest,
operators see `{ "event": "guest.stopped", "slotId": ..., "reason": "home-silent" }` in the agent
log and `status.stopReason: "home-silent"` in `list` summaries (and in the Home's signed `status`
reply until the Home starts a fresh guest or stops/replaces the slot).
