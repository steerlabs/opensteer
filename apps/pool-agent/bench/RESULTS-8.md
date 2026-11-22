# Pool host agent: eighth real-host run (2026-11-22, round I)

## The instance

- **Shape:** `pool-agent-run-8`, an n2-standard-8 with one thread per core, nested
  virtualization, four Local SSDs, no external address, IAP only, Ubuntu 24.04.
- **The profiles' own disk:** `pool-agent-run-8-profiles`, a 100 GB pd-ssd formatted ext4 and
  mounted at `driver.profilesRoot`.
- **Times:** created 05:49:36Z; deleted, with both its disks, at 06:09:48Z.
- **Code:** the source was 4bcf71e00. The agent was fixed during the run (below). The final
  bench used the fixed agent, the helper's credential copy, and the upstream stand-in that logs
  whose credentials it saw.

**Summary.**

- Every check of round I's run holds on the last run of its phase:
  `{"kind":"assertions","rows":2,"failed":[],"ok":true}`.
- The run found one fault in the agent: a slot's rotated credentials did not reach a proxy
  service that a pending connection had started again after its guest stopped. It is fixed, and
  the phase passed after the fix.

## Raw rows

- `results-2026-11-22-run8a.jsonl`: `profile` and `egress-pull` passed (round H's checks, under
  round I's semantics). `pull-run8` failed at the rotation (below).
- One attempt between 8a and 8c stopped at its first create. The bench's opening cleanup
  deleted 8a's slots, and with them the bench's shared credential files, as round G's delete is
  meant to. The bench now keeps a copy of those files across its own cleanup (the helper's
  `bench-credentials`).
- `-run8c-rotation-unscoped.jsonl`: `pull-run8` again, with the upstream's log telling whose
  credentials it saw. It failed at the rotation, with every request of the rotated slot
  refused.
- `-run8d.jsonl`: `pull-run8` after the agent's fix, passed.
- `-run8-agent-events.txt`: the agent's egress and profile events. "password-lines 0" counts
  the agent log's lines containing the word.

## The fault the run found

- **Symptom.** After the account service gave slot a a new password, the agent wrote it (the
  file's digest changed), but every CONNECT of a's guest reached the upstream with the old one
  and was refused. The guest could not browse.
- **Cause.** The proxy's journal showed it. A slot's proxy service was stopped with its guest,
  and a connection still pending on its socket started it again in the same second
  (`egress-6`, 05:58:55). It kept running with no guest, holding the credentials it read then.
  The next guest used that process.
- **Fix.** Changed credentials stop the slot's proxy service, so its next start reads the new
  copy (`firecracker/driver.ts`, `writePulledEgress`). The test in
  `firecracker/driver-egress.test.ts` failed first.

## The items (run 8d, all asserted unless marked)

1. **A guest running behind a unit made before the host pulled.** A slot with no egress, on a
   host that did not pull yet: its proxy did not require an upstream, and the guest ran. After
   the switch to `requireEgressUpstream` and the agent's restart, the guest was ended (phase
   `stopped`, no VMM, `egress.unrequired-ended` logged).
2. **From inside a running pulled guest, only its proxy answers:**

   | Probe from the guest                                                | Result    |
   | ------------------------------------------------------------------- | --------- |
   | its own proxy, 172.16.0.1:3128 (positive control)                   | connected |
   | 1.1.1.1:443 and 93.184.215.14:80, TCP, direct                       | timeout   |
   | 8.8.8.8:53 and 169.254.169.254:53, DNS over UDP                     | no answer |
   | 1.1.1.1 and 169.254.169.254, ICMP                                   | no answer |
   | 169.254.169.254:80, TCP                                             | timeout   |
   | 7310, 7311, 7312, on the slot's veth and on the host's address, TCP | timeout   |

3. **One slot's proxy user and another slot's credentials.** It could not read the other slot's
   password or username file under `credentialsRoot`, nor its running proxy's
   `/run/credentials/.../password` (all "Permission denied"). Root found them present.
4. **Credentials removed without stopping the proxy (printed, not asserted).** The guest's next
   HTTPS still loaded (`opaque`): the running proxy holds what it read when it started. So
   removing the files alone does not cut a running guest. A `delete` ends the guest and its
   proxy first.
5. **A wake from disk without credentials.** The slot was parked to disk, its files removed and
   then woken. It asked the account service once, and its HTTPS loaded.
6. **A changed answer at a cold start.**
   - The account service rotated the slot's password, and the upstream took only the new one.
   - At the next start the agent replaced the copy (its digest changed), and the guest's HTTPS
     loaded.
   - All 8 of the slot's requests to the upstream after its start carried the new password.

Run 8a's other two phases passed again under round I. In the profile phase the guest booted
from the agent-made profile (first replies 2,009 ms and 2,062 ms) and the marker survived. The
egress phase passed in full.

## Not shown on this host

- **The account service and the upstream were stand-ins.**
- **The switch to pull mode was made by editing `agent.json`,** not by the enrolment.
- **A guest paused in memory behind a foreign unit** gets the slot's own unit at its wake. That
  was not run here.
