# Pool host agent: seventh real-host run (2026-11-22, round H)

## The instance

- **Shape:** `pool-agent-run-7`, an n2-standard-8 with one thread per core, nested
  virtualization, four Local SSDs, no external address, IAP only, Ubuntu 24.04.
- **The profiles' own disk:** `pool-agent-run-7-profiles`, a 100 GB pd-ssd formatted ext4 and
  mounted at `driver.profilesRoot` (`/dev/sdb ext4 97.9G /var/lib/opensteer-pool/profiles`).
- **Times:** created 04:38:39Z; deleted, with both its disks, at 05:05:42Z.
- **Code:** the agent ran 64183a42f. The bench's helper got two fixes during the run (below).

## Raw rows

- `results-2026-11-22-run7a.jsonl`: all three phases. Its `mkfs-time` row is the one recorded
  here. Its other two rows failed on faults in the bench's own checks (below).
- `-run7-egress.jsonl`: the egress phase rerun after the fix, passed.
- `-run7-profile.jsonl`: the profile phase rerun after the fix, passed:
  `{"kind":"assertions","rows":2,"failed":[],"ok":true}`.
- `-run7-agent-events.txt`: the agent's own egress and profile events. Its last line, 0, is the
  count of agent log lines containing "password".

## What failed first, and why

- **The egress check.** It looked for `CONNECT example.com:443` at the upstream, but the slot
  proxy resolves a name itself and asks its upstream for the address it checked. The check now
  requires a CONNECT to one of example.com's resolved addresses, with the slot's credentials.
  The rows of the first run already showed one (`CONNECT 172.66.147.243:443`).
- **The marker check.** The marker was written into a profile whose journal had not been
  replayed: the guest is ended by a kill. The next mount's replay rolled the directory back
  past it. The helper now replays the journal before it writes or reads the marker.
- **Two reruns stopped at their first create.** The bench's opening cleanup deleted the previous
  run's `bench-*` slots. Since round G, a delete removes a slot's credential files once no other
  live slot names them, so the last delete removed the bench's shared set. `run-gcp.sh agent`
  made the set again before each rerun. This is the delete semantics as decided; only the bench
  assumed host-wide shared files.

## The items

### (a) The agent makes the profile, and the guest boots from it

- **Asserted.**
  - The file is at the derived path, 1 GiB apparent, `type=ext4`.
  - The guest booted from it: first CDP reply 2,049 ms.
- **Printed.** 34 MB allocated; mode 0600. At creation it is root's; the boot hands it to the
  slot's uid.

### (b) A delete without `eraseProfile` keeps it, and a create at a higher term finds it

- **Asserted.**
  - The delete without `eraseProfile` answered with no `profileErased`, and the file stayed.
  - A marker written into its filesystem was read back after a create at a higher term, and
    again after the guest booted from it (second first reply 2,079 ms).

### (c) A delete with `eraseProfile`

- **Asserted:** `profileErased: true`, and the file gone.

### (d) No upstream, no start

The agent ran with `requireEgressUpstream`, against a stand-in account service on loopback and
a stand-in upstream. Both had certificates from a root put into this instance's system store
only.

- **None assigned.**
  - Asserted: `start refused: egress-required`, with no VMM.
  - The slot's proxy unit requires an upstream and has none.
  - A request through it from inside its namespace got `502` for its CONNECT.
  - The account stand-in verified the request's host-key signature.
- **Assigned.**
  - Asserted: the guest's HTTPS loaded (`opaque`).
  - The upstream logged the guest's `CONNECT 104.20.23.154:443` (example.com's address) with the
    slot's credentials, and every request it got carried them.
  - The unit is defined with `https://192.0.43.10:8443` and requires an upstream.
  - The credentials are root's, 0600, in a 0700 directory.
- **Credentials removed** (files deleted, proxy process stopped).
  - Asserted: the guest's next HTTPS failed (`TimeoutError`), and nothing more reached the
    upstream.
  - The proxy service stayed in `activating`: systemd cannot load the missing credentials, so
    no proxy process runs that could connect anywhere.
- **Asserted:** both slots' deletes answered `profileErased: true` and `credentialsErased: true`.

### (e) `mkfs.ext4` as the agent runs it, on the profiles' disk

Printed, not asserted:

| Profile size | Time  | Allocated after |
| ------------ | ----- | --------------- |
| 2 GiB        | 8 ms  | 68 MB           |
| 10 GiB       | 12 ms | 72 MB           |
| 50 GiB       | 13 ms | 273 MB          |

## Not shown on this host

- **The account service and the upstream were stand-ins.** The real account-service route was
  not reached.
- **The run did not use the real enrolment.** Pull mode was set by editing `agent.json`.
