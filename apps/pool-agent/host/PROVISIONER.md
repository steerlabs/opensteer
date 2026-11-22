# The pool host, from the provisioner's side

Written for whoever builds the provisioner's hosts and slots. It is taken from the code at
`browser-pool-agent` as of this page. Every claim names its file and line.

## 1. The administration interface

**Transport.**

- `POST /v1` on the admin listener: `agent.json` `admin.listen`, port `OSP_ADMIN_PORT` 7311
  (`setup-host.sh:32`).
- The host firewall drops it from anywhere but loopback and `OSP_PROVISIONER_CIDR`
  (`setup-host.sh:306`). The provisioner's side is already written:
  `callBrowserPoolAgentAdmin` (`packages/browser-runtime-core/src/browser-pool-agent-wire.ts:297`).

**Envelope** (`browser-pool-agent-wire.ts:158`):

```text
{ v: 1, host, issuedAt, nonce, request }
```

- `host` is the host id the provisioner enrolled. A request naming another host is refused
  (`apps/pool-agent/src/server.ts:250`).
- `issuedAt` must be within 5 minutes of the host's clock (`browserPoolAgentRequestWindowMs`,
  `browser-pool-agent-wire.ts:14`; `server.ts:260`).
- `nonce` makes each envelope distinct. **There is no nonce ledger.** Replays are made harmless
  by idempotency and terms (below), not by remembering nonces.

**Who signs what.**

- The provisioner signs `browserPoolAgentAdminBytes(envelope)`
  (`browser-pool-agent-wire.ts:197`, canonical JSON) with its Ed25519 key. Its public half is
  `agent.json` `admin.provisionerKey`, checked at `server.ts:251`.
- The host signs every reply with its host key: `browserPoolAgentAdminReplyBytes(requestBytes,
reply)` (`browser-pool-agent-wire.ts:202`), i.e. sha256 of the request plus the canonical
  reply (`server.ts:268`). The client checks it against the host key pinned at enrolment
  (`browser-pool-agent-wire.ts:323`).
- **What a reply proves:** this host, holding the enrolled host key, answered this exact
  request.

**Calls** (schema: `server.ts:92–131`; handling: `server.ts:275`).

| Call                                                                                                    | Does                                                                                                                                                                                                                                                                                                                                                                                                                   | Idempotency                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create {slotId, term, homeKey, relayKey?, ticketKey?, guest: {vcpus, memoryMib, profileMib, egress?}}` | Makes the slot and its number, namespace and proxy socket, and its profile disk if none is there (section 4). No guest is started. The reply's `slot.controlKey` is the slot's own public key.                                                                                                                                                                                                                         | A repeat with the same `homeKey` and `term` returns the same slot and touches no file. Another key or term is `conflict`. A create at or below a deleted slot's last term is `conflict`, for the 30 days its tombstone is kept (`agent.ts:594`, `agent.ts:180`). A profile that cannot be made leaves no slot and no file (`agent.ts:607–620`). |
| `replace-key {slotId, term, homeKey, relayKey?, ticketKey?}`                                            | A new Home key set at a higher term, in one journal write. The old set is refused from then on. **The guest is ended and its saved state discarded; the next start is cold.**                                                                                                                                                                                                                                          | The same term and keys again is a no-op. A lower or equal term is `conflict` (`agent.ts:683–730`).                                                                                                                                                                                                                                              |
| `delete {slotId, term, eraseProfile?}`                                                                  | Ends the guest, erases saved state, the network and the proxy, and writes a tombstone. Answers `{erased: true}` only after the VMM's exit was seen and the files are gone. With `eraseProfile: true` it then removes the profile disk and adds `profileErased: true` only once the file is seen gone; if it cannot, the delete is refused (`unavailable`) and may be sent again (`agent.ts:755–796`, `server.ts:297`). | A delete naming another term is `conflict` and erases nothing. A slot already gone, or never known, answers `erased: true`; with `eraseProfile` a leftover profile at that slot id's path is removed, with the same evidence (`agent.ts:770`).                                                                                                  |
| `list`                                                                                                  | Every live slot: `slotId`, `term`, `controlKey`, `status`, and `parked: {tier, writeMs?}` while paused (`agent.ts:1706`).                                                                                                                                                                                                                                                                                              | Read only.                                                                                                                                                                                                                                                                                                                                      |

**Refusals** (`server.ts:296`, and the envelope checks above): `conflict`, `unknown-slot`, `unavailable`, `bad-request`,
`stale-request`, `unauthenticated`. The client throws `BrowserPoolAgentUnavailable` for any of
them.

## 2. What a host reports at setup

`setup-host.sh install` (`setup-host.sh:414`) does not enrol the host. It makes what enrolment
needs, and the operator writes `/etc/opensteer-pool/agent.json` from the provisioner's values
(`HOST-SETUP.md:132`).

| Fact                                 | Where it comes from                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host id                              | Chosen by the provisioner, written into `agent.json` `admin.hostId` (`apps/pool-agent/src/config.ts:23`). Not generated on the host.                                                                          |
| Host key (pin it)                    | `host_key()` makes `/etc/opensteer-pool/host-key.pem` (root, 0600) and publishes `/etc/opensteer-pool/host-key.pub` (`setup-host.sh:107–115`). It signs admin replies and the answer that a slot was deleted. |
| Relay key (pin it; not the host key) | `/etc/opensteer-pool/relay-key.pem`, certificate `/etc/opensteer-pool-relay/relay-cert.pem`, public half `/etc/opensteer-pool-relay/relay-key.pub` (`setup-host.sh:119–129`).                                 |
| Relay address                        | `relay.json` `listen` 0.0.0.0:`OSP_RELAY_PORT` 7312 (`setup-host.sh:33, 220–221`). The firewall allows only loopback and `OSP_HOME_CIDR` (`setup-host.sh:305`).                                               |
| Agent's Home address                 | `agent.json` `listen`, port `OSP_AGENT_PORT` 7310 (`setup-host.sh:31`). Same firewall rule as the relay.                                                                                                      |
| Admin address                        | `agent.json` `admin.listen`, port 7311 (above).                                                                                                                                                               |

The host's IP address is the provisioner's to know; the host prints none.

## 3. What the Home is handed, and what it hands back

**The Home makes its keys and hands back only their public halves.**

- It makes `ManagedBrowserPoolHomeKeys`: `homeKey`, `relayKey` plus a self-signed
  `relayCertificate`, and `ticketKey` (`apps/host/src/browser/managed-pool.ts:128`).
- `managedBrowserPoolRegistration(keys)` (`managed-pool.ts:139`) returns `{homeKey, relayKey,
ticketKey: {keyId, spki}}`, each as SPKI DER base64. These are exactly the key fields of
  `create` and `replace-key`.
- **Private keys never leave the Home.**

**The provisioner hands the Home public material only**
(`ManagedBrowserPoolTarget`, `apps/host/src/browser/browser-pool-agent-client.ts:92`, with the
relay of `managed-pool.ts:117`; built by `managedBrowserPool(target, keys)`,
`managed-pool.ts:159`):

```text
{ kind: "managed-pool", agentUrl, slotId, term,
  agentKey: <create reply's slot.controlKey>,
  hostKey: <host-key.pub as SPKI base64>,
  relay: { host, port, relayHostKey: <relay-key.pub as SPKI base64> } }
```

## 4. The profile disk

The agent makes and erases it, because it is the only party on the host (round G). The
provisioner never sends a path and never touches the file.

- **Its path is derived from the slot id alone:** `<profilesRoot>/slot-<sha256 of the slot
id>.ext4` (`apps/pool-agent/src/profiles.ts:20`).
  - No slot id reaches a file elsewhere or another slot's file. `profilesRoot` defaults to
    `/var/lib/opensteer-pool/profiles`, which setup makes 0711 (`setup-host.sh:143`).
  - The earlier `guest.profilePath` is still accepted on the wire, but only if it is that same
    path. Anything else is `conflict` (`agent.ts:607–613`).
  - The boot checks stay: a plain file under the root, not a link (`firecracker/paths.ts:13–28`,
    `firecracker/driver.ts:182, 627`).
- **`create` with `profileMib`** (64 MiB to 1 TiB, `server.ts:106`):
  - **No file there:** the agent makes a sparse file of that size with an ext4 filesystem
    (`mkfs.ext4 -q -F -m 0`, `firecracker/driver.ts:185–188`). It makes it under a temporary
    name and links it into place only once it is formatted (`profiles.ts:32–62`). A make that
    fails leaves nothing under the slot's name, and the create is refused with no slot. A
    temporary file a crash left behind is removed when the driver opens (`profiles.ts:77`,
    `firecracker/driver.ts:152`).
  - **A file there:** kept exactly as it is, never formatted, whatever `profileMib` says. This is
    what lets a replaced host instance keep every profile: the provisioner creates the slot again
    at a higher term, and the person's profile is still theirs.
- **What the agent does to it at each boot:** chowns it to the slot's uid, sets 0600 and
  bind-mounts it into the jail (`firecracker/driver.ts:627–631`). The guest mounts it as
  `/dev/vdb` (`apps/pool-agent/guest/init.sh:32`).
- **Erasing it.** Only `delete` with `eraseProfile: true` removes a profile (section 1).
  - No other call removes one: not a failed create, not a rollback, not `replace-key`.
  - Without `eraseProfile` the file stays for the same slot id's next create.
- **A tombstoned slot's file and a new create.** The tombstone refuses a create at or below the
  deleted term. A create above it, for the same slot id, finds the kept file and uses it: the
  slot id is the person's Cloud Computer. A file is never handed to another slot id, because the
  path is derived from the id.
- **Credential files: the same gap, not closed in this round.** The egress files
  (`usernameFile`, `passwordFile`, `caFile`) must still be files under `driver.credentialsRoot`
  (`firecracker/driver.ts:185`), and the provisioner cannot write them through this interface.
- **What a delete leaves:**
  - the egress credential files;
  - the host user `osp-egress-<n>`, reused by the next slot on that number
    (`firecracker/egress.ts:42`);
  - a journal tombstone holding no secret, pruned after 30 days;
  - without `eraseProfile`, the profile.
- **What the agent removes itself:** the guest, its saved state, its jail, the namespace and
  proxy units, and the slot number. A number is freed only after every piece of work using it
  has ended (`firecracker/slot-numbers.ts`).

## 5. Capacity

- **The agent enforces a capacity, but does not report it on the wire.** It logs it once at
  start: `{"event":"capacity","guestBytes","proxies"}` (`agent.ts:252`). The values come from
  `capacity.ts:13–43`:
  - `guestBytes` = host memory less max(2 GiB, 10 %) less the proxies' slice (1,536 MiB);
  - each guest in memory is charged its memory + 512 MiB;
  - `proxies` = slice / 128 MiB.
- **A start or a wake from disk that doesn't fit** first saves guests paused in memory to disk,
  oldest park first. If that isn't enough, it is refused as `unavailable`, "This host has no
  memory for another guest now; try again later." (`agent.ts:836`). The Home's journal sends it
  again later.
- **To place by capacity,** compute from the host's memory with `capacity.ts`, and read
  occupancy from `list`: each slot's `status.phase`, plus `parked.tier` while paused.
  `maximumSlots` is 16,384 per host (`firecracker/slot-numbers.ts:15`).

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
  the host key (`tests/browser-pool-relay.test.ts:256–273`).
- **Never treat an `unavailable` reply as a failed effect.** The call may have happened; read
  the slot with `list`. A start or wake refused for capacity did not happen.
- **Never edit `agent.json`, the journal or `slots.json` while the agent runs,** and never open
  the admin port beyond `OSP_PROVISIONER_CIDR`.

## 7. Replacing a host instance: what is on which disk

- **Today it is all one tree.** `setup-host.sh` keeps all of the agent's state in one directory,
  `/var/lib/opensteer-pool`, described as durable (`setup-host.sh:24`; `HOST-SETUP.md:32`, "on
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
  `agent.json`. How a provisioned host mounts that disk and enrols is the enrolment's to decide;
  nothing in the agent assumes it.
