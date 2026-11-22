# Pool host agent: third real-host run (2026-11-21)

Instance `pool-agent-run-3` (n2-standard-8, nested virtualization, four Local SSDs, no external
address, IAP only, Ubuntu 24.04, kernel 7.0.0-1017-gcp), created 13:15:31Z, deleted 14:41:03Z.
Source: the branch head at the start of the run, plus the host fixes committed during it (relay
directories, relay socket, kvm-pit identification, debug runtime log). Raw rows:
`results-2026-11-21-run3a.jsonl` (bench guests), `-run3b.jsonl` (after the reboot),
`-run3-proof.jsonl` (our runtime in a guest, driven by a Home on the Mac through IAP).

## Bench series, beside the earlier runs (median / p95, ms)

| Series                     | First CDP reply | Edited frame  | Run 2 (reply / frame) | Run 1 (reply / frame) |
| -------------------------- | --------------- | ------------- | --------------------- | --------------------- |
| Cold start                 | 2,061 / 2,135   | —             | 2,039 / —             | 2,026 / —             |
| Paused in memory           | 39.8 / 42.5     | 132 / 149     | 40.9 / 135            | 51.2 / 153            |
| From disk, cache kept      | 361 / 490       | 652 / 1,011   | 359 / 672             | 299 / 635             |
| From disk, cache dropped   | 603 / 687       | 909 / 960     | 704 / 1,029           | 627 / 937             |
| Three wakes while two save | 3,062 / 3,438   | 3,764 / 3,940 | 2,441 / 3,364         | 1,492 / 2,657         |

Every series passed every state check except one: **the HTTPS fetch from the page failed in all
30 wake samples** ("TypeError: Failed to fetch"), while it passed in both clock samples later in
the same run and in the proof's HTTPS page after its wake. Two things changed since run 2 (37/37):
names resolve through Google Cloud's resolver (re-check finding 2) and the proxy starts at the
guest's first connection (finding 8). Which one, or what else, is not known: owed to the next run.

The three-wakes-while-two-save series is slower than both earlier runs although the eager proxy
start is gone (finding 8 expected it faster). Not explained by this run.

## Re-check items on the host

| Check                                                     | Result                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup from scratch                                        | every check ok, `l1tf` and `spec_store_bypass` included                                                                                                                                                                       |
| Flush with positive controls                              | both controls connected (guest to its proxy, proxy namespace to the upstream); all ten other probes blocked, all within 1.5 s, before the repair at 5.3 s                                                                     |
| 400 slots, agent restarts                                 | ready in 471 / 451 / 493 ms (run 2: 1,386 / 1,372 / 1,340); a cold start among them 2,102 ms, now timed from before the start call                                                                                            |
| A real reboot with 400 slots                              | `systemctl reboot` hung in Google's own shutdown-script job (no time limit); the instance was reset instead. After it the agent was ready with 400 slots 1,087 ms after systemd started it, no failure; a cold start 2,011 ms |
| A journal that keeps failing (45 s)                       | 30 calls, none applied; 5 restarts; the unit never failed (`activating`); back 21.9 s after the journal took writes; the guest the same process; pause and resume applied                                                     |
| `memory.high` during two saves                            | round 1: 481 and 349 `high` events during the save; rounds 2 and 3: 0; 0 `max`, 0 `oom`                                                                                                                                       |
| kvm-pit                                                   | the thread is named `kvm-pit/1` (the VMM's pid in its own namespace): the first agent found none (`absent`). With the fix, 23 moved, 0 refused; `setup-host.sh check` reads `kvm-pit refused 0`                               |
| Clock after 60 s parked                                   | 43 ms behind (memory), 22 ms (disk)                                                                                                                                                                                           |
| Isolation, restarts, array unmounted, one journal failure | as run 2: all passed                                                                                                                                                                                                          |

## Our runtime in a guest (the proof)

A Home on the Mac (browser service, pool coordinator, agent client, the Runner's browser relay and
bridge) drove one guest running our runtime, through SSH forwards of the agent, its
administration interface and the relay.

| Step                                                                       | Result                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start: boot, runtime and Chromium up, the Home's install through the relay | 4.84 s                                                                                                                                                                   |
| A person's tab (a form page) and an agent's tab (https://example.com)      | both loaded                                                                                                                                                              |
| Park                                                                       | 759 ms                                                                                                                                                                   |
| Relay while parked                                                         | refused (`parked`); another Home's relay key refused (`refused`)                                                                                                         |
| Saved to disk                                                              | within the agent's 4 s idle save                                                                                                                                         |
| Wake (a viewer of the person's tab)                                        | attach 1,583 ms, first frame 1,790 ms (through IAP); the agent's own resume from disk 146–158 ms (restore 62 ms)                                                         |
| Same documents                                                             | yes, both tabs; both sessions adopted, none lost                                                                                                                         |
| The draft and a new key on the person's page                               | **not shown**: the viewer's keys did not change the page in the guest, before the park as after it (the Home accepted them; the runtime logged nothing). Cause not found |
| HTTPS from a page after the wake                                           | https://example.com loaded                                                                                                                                               |
| An earlier start's install replayed into a fresh guest                     | refused ("superseded"); the guest stays uninstalled                                                                                                                      |
| Coordinator errors                                                         | none                                                                                                                                                                     |

Chromium's sandbox was not read from the running browser. A pooled runtime refuses to start
without `OPENSTEER_CHROMIUM_SANDBOX=true`, the launcher then passes no `--no-sandbox`, and
Chromium does not start without a usable sandbox under `no_new_privs`; it started.

## Found and fixed during the run

- The relay's user could not enter `/etc/opensteer-pool` or `/run/opensteer-pool` (both root
  only): its files and the agent's socket moved to their own directories.
- The coordinator reads the runtime's state before a guest exists: the relay channel is seeded
  from the agent's status.
- kvm-pit identification (above).
