# Pool host agent: fourth real-host run (2026-11-21)

Instance `pool-agent-run-4` (n2-standard-8, nested virtualization, four Local SSDs, no external
address, IAP only, Ubuntu 24.04), created 15:57:23Z, deleted 16:54:58Z. Raw rows:
`results-2026-11-21-run4a.jsonl` (bench, after the proxy fix), `-run4-before-fix.jsonl` (bench
before it), `-run4b-weights.jsonl` and `-run4c-memory-high.jsonl` (two concurrent-wake
experiments, not kept: `run4-experiments-not-kept.patch`), `-run4-proof.jsonl` (our runtime).

## Bench series beside the earlier runs (median / p95, ms)

Corrected in round D: this table first had percentiles from another formula. These are
`summarize.mjs`'s (nearest rank) over `results-2026-11-21-run4a.jsonl`; the earlier runs' columns
are as their own documents give them.

| Series                     | First CDP reply | Edited frame  | Run 3 (reply / frame) | Run 2         | Run 1         |
| -------------------------- | --------------- | ------------- | --------------------- | ------------- | ------------- |
| Cold start                 | 2,087 / 2,126   | —             | 2,061 / —             | 2,039 / —     | 2,026 / —     |
| Paused in memory           | 43.0 / 47.9     | 139 / 155     | 39.8 / 132            | 40.9 / 135    | 51.2 / 153    |
| From disk, cache kept      | 323 / 556       | 654 / 1,293   | 361 / 652             | 359 / 672     | 299 / 635     |
| From disk, cache dropped   | 594 / 702       | 908 / 1,113   | 603 / 909             | 704 / 1,029   | 627 / 937     |
| Three wakes while two save | 2,185 / 3,450   | 3,625 / 3,953 | 3,062 / 3,764         | 2,441 / 3,364 | 1,492 / 2,657 |

**HTTPS after every wake: 47 of 47** (30 wake samples, 2 clock, 9 concurrent, 6 after a
concurrent save). Before the fix in the same run: 30 of 32 failed, and the 2 that passed were the
clock samples. Cause: each slot
proxy's service is started at the guest's first connection and stopped with every kill; the cold
series did that more than five times in ten seconds, systemd's default start limit failed the
service and its socket with it, and nothing listened on the proxy port any more. Run 3's clock
samples passed only because the bench restarts the agent before them, which redefined the failed
socket. Fixed: no start limit on the service, no trigger limit on the socket.

## Where a concurrent wake's time goes (three wakes while two save)

Per wake, from the agent's own log: waiting for the slot's lane 0 ms in every wake; the journal
write 4–12 ms; host rules 8–16 ms; the slot's network 0 ms; closing 6–16 ms; kill 2–20 ms;
restore 104–620 ms; vCPUs 2–65 ms; the clock step 31–284 ms in rounds 2 and 3 and **up to
2,556 ms in round 1** (the guest's first execution after the restore); the token 5–123 ms;
opening 8–16 ms. The agent's whole call: 0.45–0.70 s in rounds 2 and 3, up to 3.1 s in round 1.

The host across each round: CPU pressure stall ("some") 1.2–2.7 s, I/O stall 1.3–2.4 s, while
the two saves write 2 GiB each. The rest of a slow first reply comes after the agent answered:
the woken guest runs on four cores beside the savers.

Two fixes the numbers suggested were measured and **not kept**, because neither moved the
median: the saving slot at the least CPU and I/O weight (2,079 ms), and `memory.high` lowered only
during a snapshot (2,275 ms). What bounds the series is the woken guests' first run after a
restore on four shared cores while about 4 GiB is written; this run did not separate CPU from
page faults in that first run, so run 1's figure is not met and the bound is not named closer.

## Our runtime in a guest (the proof)

Corrected in round D: this section first said "all asserted". Run 4's script
(`tests/browser-pool-guest.real-host.integration.test.ts` at 608bbdadc) asserted the rows marked
**asserted**; the rows marked _printed_ are what it logged or what was read by hand, and nothing
failed on them. Round D asserts them (RESULTS-5.md).

| Step                                                                                                | Result                                                                                     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Start: boot, runtime and Chromium, the Home's install through the relay                             | running, **asserted**; 4.90 s _printed_                                                    |
| Chromium's sandbox, read from the running browser                                                   | `sandboxed: true` **asserted**; NSpid three deep _printed_ (evidence, never a gate: D4)    |
| A person's form (guest identity), an agent's page, a person's tab from a local profile on the guest | all three loaded, **asserted**                                                             |
| The draft "unsent draft" on the form before the park                                                | shown (the page's own colour), **asserted**                                                |
| Park                                                                                                | `parked` and saved to disk, **asserted**; 805 ms _printed_                                 |
| Relay while parked; another Home's relay key                                                        | `parked`; `refused`, **asserted**                                                          |
| Wake from disk                                                                                      | _printed_: first frame 2,929 ms through IAP; the agent's own resume 191 ms (restore 79 ms) |
| Same documents                                                                                      | all three, **asserted**; three sessions adopted, none lost _printed_                       |
| The draft after the wake, and a new key                                                             | both shown ("unsent draftx" turns the page green), **asserted**                            |
| HTTPS from a page after the wake                                                                    | loaded, **asserted**                                                                       |
| An earlier start's install replayed into a fresh guest                                              | refused ("superseded"), **asserted**                                                       |
| Coordinator errors                                                                                  | none, _printed_ (read from the log)                                                        |

The form is a guest identity's tab: a persistent profile upgrades its plain-HTTP page to HTTPS
(the run has no HTTPS page of its own), so the local profile's tab is https://example.com.

The relay presented its own key (relay-key.pub), not the host key (host-key.pub): two keys,
_printed_ (compared by hand in run 4; asserted in run 5).
