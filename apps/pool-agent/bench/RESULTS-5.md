# Pool host agent: fifth real-host run (2026-11-21, round D)

Instance `pool-agent-run-5` (n2-standard-8, nested virtualization, four Local SSDs, no external
address, IAP only, Ubuntu 24.04), created 17:48:30Z, deleted 18:41:28Z. The host ran 2f48e2daf.

Raw rows:

- `results-2026-11-21-run5c.jsonl`: the bench of record, at 2f48e2daf.
- `-run5a-window-30s.jsonl`: the first bench, at bb38b53cb. The crash loop failed: with a 30 s
  start window and the 1–30 s backoff, the limit never tripped.
- `-run5b-no-revive.jsonl`: the second bench, at d2b44da11. The limit tripped, but the proxy did
  not come back at the next start. The agent's own stop reset the failed socket, systemd unloaded
  the transient socket, and the revive brought back only a socket still marked failed.
- `-run5-proof.jsonl`: our runtime, at 2f48e2daf.

Each finding was fixed in code, with a test that failed first, and the bench was run again
whole. No assertion was changed between the three runs.

## What is asserted and what is printed

Corrected in round E (the re-check of round D, finding 3): rows 1, 2, 4 and 6 below first
claimed as asserted what run 5's scripts only read or printed, and row 4 counted the flood
series twice.

**Asserted** means a script fails on it. In the bench that is `assertAll()` in `real-host.ts`:
the run's verdict row `assertions` fails on any row with `passed: false` or `ok: false`, and on
any HTTPS check that is not `opaque`. In the proof it is an `expect` in
`tests/browser-pool-guest.real-host.integration.test.ts`. _Printed_ means the script writes it
down, and nothing fails on it.

Run 5c's verdict: `{"kind":"assertions","rows":79,"failed":[],"ok":true}`. The proof passed:
one test, 38.4 s.

## Round D on the host

| Item                                    | Asserted                                                                                                                                                                                                                                                                                                                                                | Printed                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The cold series with the limits on   | 10 of 10 cold starts passed, then every later series.                                                                                                                                                                                                                                                                                                   | Read on the host, not asserted by run 5's script: the units had `StartLimitIntervalUSec=2min`, `MemoryMax=128M` and the egress slice. The script asserts them from round E on (`proxy-unit` row).                                                    |
| 2. A proxy crashing in a loop           | The service was not active (run 5's script asserted "not active"; from round E on it asserts `failed`). The status said `proxy: "down"`. HTTPS failed while it was down and loaded after the slot's next start, and the status then had no `proxy`. PID 1 used under 5 s of CPU.                                                                        | The service was `failed` (result `signal`). 5 kills in 45 s. systemd: `Start request repeated too quickly`, then the socket failed with `service-start-limit-hit`. Agent log: `proxy.down` 18:31:57Z, `proxy.revived` 18:32:03Z. PID 1 CPU 1,330 ms. |
| 3. A wake while another guest floods    | HTTPS 5 of 5 without the flood and 5 of 5 with it. Flooded median first reply ≤ 1.5 × baseline + 100 ms.                                                                                                                                                                                                                                                | First CDP reply median 311 ms without the flood and 309 ms with it. Without: 283–444 ms. With: 289–509 ms; two of five were near 500 ms. 174,960 requests sent. The flooder's proxy held 9 connections and 74.6 MB.                                  |
| 4. HTTPS after every wake               | 57 of 57 in all, 10 of them in the flood series (30 wakes, 2 clock, 9 concurrent, 6 after a concurrent save, 10 flood).                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                    |
| 5. The proof with D3's assertions       | See the proof table.                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                    |
| 6. `replace-key`                        | Straight after it, the old relay key was refused at both terms (`["refused","refused"]`) and the old slot key got no answer (run 5 asserted "not answered"; from round E on the proof asserts `BrowserPoolAgentUnavailable`). The guest was gone (`stopped`, no saved state). The new Home's cold start applied and its install ran with the new fence. | The old slot key's refusal read as `BrowserPoolAgentUnavailable` (the client's name for `unauthenticated`). The cold start took 4,798 ms.                                                                                                            |
| D1. What one Chromium uses on its proxy | —                                                                                                                                                                                                                                                                                                                                                       | Peak over the series: 6 connections and 84.4 MB (run 5a: 7 and 83.6 MB). These set the ceilings at 64 connections and 128 MiB.                                                                                                                       |

## Bench series beside run 4 (median / p95, ms)

`summarize.mjs` (nearest rank) for both runs; run 4's numbers are corrected in RESULTS-4.md. The
bench asserts that each sample passed its checks. It asserts no time.

| Series                     | First CDP reply, run 5 | Run 4         | Edited frame, run 5 | Run 4         | Checks |
| -------------------------- | ---------------------- | ------------- | ------------------- | ------------- | ------ |
| Cold start                 | 2,088 / 2,221          | 2,087 / 2,126 | —                   | —             | 10/10  |
| Paused in memory           | 53.4 / 55.1            | 43.0 / 47.9   | 145 / 165           | 139 / 155     | 10/10  |
| From disk, cache kept      | 329 / 546              | 323 / 556     | 649 / 1,253         | 654 / 1,293   | 10/10  |
| From disk, cache dropped   | 602 / 667              | 594 / 702     | 907 / 979           | 908 / 1,113   | 10/10  |
| Three wakes while two save | 1,906 / 3,289          | 2,185 / 3,450 | 3,413 / 4,020       | 3,625 / 3,953 | 9/9    |
| After a concurrent save    | 281 / 582              | 324 / 1,086   | 609 / 1,298         | 665 / 1,408   | 6/6    |

Printed: a wake from memory took about 10 ms longer than in run 4. The agent's own resume call
was 43.2 ms against 33.5 ms. This run did not find out why. The clock after 60 s parked: the
guest was 14 ms behind (memory) and 22 ms behind (disk), clocksource `kvm-clock`.

## Our runtime in a guest (the proof)

| Step                                                         | Asserted                                                                                                                                                         | Printed (run 5 / run 4)                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Start through the relay                                      | running                                                                                                                                                          | 5.08 s / 4.90 s                                                                                               |
| The relay's keys                                             | The host key ≠ the relay key. A relay presenting the host key is refused (`relay-key`). Unit test: two distinct key pairs in `tests/browser-pool-relay.test.ts`. | —                                                                                                             |
| Chromium's sandbox, read from the running browser            | `sandboxed: true`, at least one renderer, and every renderer at `Seccomp: 2`, `NoNewPrivs: 1` and NSpid at least two deep                                        | 12 renderers, all three deep; 19 other processes (zygote, GPU, utility, broker). Evidence, never a gate (D4). |
| Three pages: a person's form, an agent's page, a profile tab | all loaded; the draft shown before the park                                                                                                                      | —                                                                                                             |
| Park                                                         | `parked`, then saved to disk. The relay while parked: `parked`. Another Home's relay key: `refused`.                                                             | 1,033 ms / 805 ms                                                                                             |
| Wake from disk                                               | The same three documents, epoch 2. Three sessions adopted, none lost. The draft and a new key shown after the wake.                                              | First frame 2,444 ms / 2,929 ms through IAP; edited frame 2,709 ms                                            |
| HTTPS from a page after the wake                             | loaded                                                                                                                                                           | —                                                                                                             |
| An earlier start's install replayed                          | refused (`superseded`), uninstalled                                                                                                                              | —                                                                                                             |
| Coordinator errors                                           | none                                                                                                                                                             | —                                                                                                             |
| `replace-key`                                                | item 6 above                                                                                                                                                     | cold start 4,798 ms                                                                                           |

## Not shown on this host

- A Home restart while the guest is parked. It waits for the browser-pool-home merge.
- The agent's own resume breakdown in the proof. The agent's journal was not read before the
  instance was deleted.
- A host with more than five slots. The budget of 10 guests in memory is computed
  (`budget.test.ts`), not run.
- Orphan slot-number cleanup. Only `round-d.test.ts` covers it, with a crash injected at
  `create:prepared`; it was not injected on the host.
