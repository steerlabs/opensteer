# Pool host agent: sixth real-host run (2026-11-21, round F)

Instance `pool-agent-run-6` (n2-standard-8 with one thread per core: 4 cores, 32 GB; nested
virtualization, four Local SSDs, no external address, IAP only, Ubuntu 24.04). Created
20:41:22Z, deleted 21:38:01Z. The agent on the host ran ab69f9472 (no agent change after it).
The bench and its root helper ran 98d731a53. The proof ran from this Mac at 98d731a53, after
the merge of the Home side's 10c2af108.

## Raw rows

- `results-2026-11-21-run6.jsonl`: the bench of record. Its verdict row:
  `{"kind":"assertions","rows":83,"failed":[],"ok":true}`.
- `-run6-proof.jsonl`: our runtime, the proof. 1 test, passed, 60.4 s.
- Earlier attempts, each stopped by a fault in the bench's own scripts, fixed before the next.
  No assertion changed.
  - A first bench, stopped by hand in its cold series. The flag directory did not exist, and the
    capacity phase would have read a log line that had scrolled out (2481393c2).
  - `-run6a-helper-path.jsonl`: failed at the unit check. systemd nests the proxies' slice by
    the dashes in its name (752f8d3e4).
  - `-run6b-spki.jsonl`: failed at E1, on a key conversion in the bench (fb5a42f96).
  - `-run6c-wrappers-0600.jsonl`: only E1, E2 and capacity, to check the script. Capacity
    passed; E1 and E2 failed because the helper's umask left the tool wrappers unexecutable, so
    neither was used (98d731a53).

**Asserted** means a script fails on it: `assertAll()` in `real-host.ts` (any row with
`passed: false` or `ok: false`, any HTTPS check that is not `opaque`), or an `expect` in the
proof. _Printed_ means it is written down and nothing fails on it.

## The six items

### 1. A Home restart while the guest is parked

Proof. The Home's browser service, pool coordinator, agent client and runtime channel are made
new against the same database. The Runner and its connection registry stay, as another process
would.

- **Parked in memory, then restarted.**
  - Asserted: the parked tier was `memory` at the wake; the same three documents; the draft
    shown; three sessions adopted, none lost; epoch 2.
  - Printed: the restart took 156 ms; the first frame came 1,905 ms after the wake began.
- **Saved to disk, then restarted.**
  - Asserted: the parked tier was `disk` after the restart; the same three documents; the draft
    shown, and a new key reached the page; three adopted, none lost; epoch 3.
  - Printed: the restart took 203 ms; first frame 2,866 ms, edited frame 3,133 ms.

### 2. E4: capacity

- **The number.** The agent logged a guest budget of 28,672,908,903 B. The bench sized guests
  at 6,144 MiB, so each is charged 6,656 MiB, and **4 fit, 5 do not** (asserted: `holds` 4).
- **Asserted.**
  1. A, B and C were parked in memory and D was running.
  2. Starts of E and F at once: both let in; A and B saved to disk, C left in memory.
  3. Starts of G and H at once: H let in, C saved to disk. G was refused with
     `BrowserPoolAgentUnavailable`, "This host has no memory for another guest now; try again
     later."
  4. The agent chose a, b, c in that order. After D stopped, the same G call was sent again and
     applied.
  5. `oom_kill` was 0 before and after in the guests' group and in the proxies' slice, and no
     proxy unit failed.

### 3. E2: a slow revive, then a delete, then a new slot

- **The slowing.** A one-shot `/usr/local/sbin/systemd-run`, first on the agent's tool path,
  ignores SIGTERM and sleeps 8 s before running the real one. It stands for a request PID 1
  already took.
- **Asserted.**
  1. The wrapper was used, and the start failed (`start-failed`).
  2. The agent drained the timed-out step (`step.draining`).
  3. The delete finished, and the deleted slot's number 5 had no socket (`inactive`, nothing
     listed).
  4. The new slot, on the same number 5, has its own upstream (`https://192.0.43.10:8444`).
- **Printed.** The delete answered 8,111 ms after the start began: it waited for the drain.

### 4. E3: the unit, the slice and the crash loop

- **Asserted, from `systemctl show`.**
  - The proxy unit: start window 2 min, burst 5, `MemoryMax` 134,217,728 B, one core, the
    egress slice.
  - The slice: `MemoryMax` 1,610,612,736 B, `CPUQuota` one core (a quarter of 4 cores).
  - In force: the slice's `cpu.max` is `100000 100000`.
- **Asserted, crash loop.** The service was `failed`. The status said `proxy: "down"`. HTTPS
  failed while it was down and loaded after the next start. PID 1 used 1,280 ms of CPU.
- **Asserted, proof.** The old slot key was refused as `BrowserPoolAgentUnavailable`.

### 5. E1: the old Home's call during a held replacement

- **The holding.** A one-shot slow `systemctl stop` of the slot's proxy, 3 s, inside the
  replacement's stop of the guest. The old Home's pause, at the old term, was sent 1 s in.
- **Asserted.** It was refused as unauthenticated ("The request is not signed by this slot's
  Home for this term."), answered after the replacement finished, and the new Home finds no
  result under its id.
- **Printed.** The replacement took 3,082 ms.

### 6. Everything of run 5

Asserted: every series' checks below; HTTPS after every wake, 57 of 57 (47 across the series,
10 in the flood series); the flood row; the proof; `replace-key`. In `replace-key`, the old
relay key was refused at both terms, the old slot key was refused, the guest was stopped with
no saved state, and the new Home's cold start installed.

## Bench series beside run 5 (median / p95, ms, `summarize.mjs`)

The bench asserts each sample's checks; it asserts no time.

| Series                     | First CDP reply, run 6 | Run 5         | Edited frame, run 6 | Run 5         | Checks |
| -------------------------- | ---------------------- | ------------- | ------------------- | ------------- | ------ |
| Cold start                 | 2,181 / 2,250          | 2,088 / 2,221 | —                   | —             | 10/10  |
| Paused in memory           | 52.4 / 59.1            | 53.4 / 55.1   | 155 / 172           | 145 / 165     | 10/10  |
| From disk, cache kept      | 321 / 610              | 329 / 546     | 655 / 1,336         | 649 / 1,253   | 10/10  |
| From disk, cache dropped   | 646 / 756              | 602 / 667     | 995 / 1,186         | 907 / 979     | 10/10  |
| Three wakes while two save | 1,711 / 3,094          | 1,906 / 3,289 | 3,335 / 3,557       | 3,413 / 4,020 | 9/9    |
| After a concurrent save    | 346 / 554              | 281 / 582     | 683 / 1,268         | 609 / 1,298   | 6/6    |

Printed, all beside run 5:

- **Flood.** First CDP reply median 332 ms without the flood and 381 ms with it (run 5: 311
  and 309). Without: 274–473 ms. With: 295–408 ms. 200,600 requests sent; the flooder's proxy
  held 12 connections and 72.4 MB.
- **Proxy usage over the series.** 7 connections and 84.0 MB (run 5: 6 and 84.4 MB).
- **Clock after 60 s parked.** 39 ms behind from memory and 21 ms from disk (run 5: 14 and 22).
- **Proof.** Start 5.00 s (5.08 s); parks 1,255 ms and 1,206 ms (1,033 ms); `replace-key` cold
  start 4,852 ms (4,798 ms).

The cold start and the wake from disk with the cache dropped were slower than run 5's by 4–7 %
at the median, and this run did not find out why.

## Not shown on this host

- **The Home restart** was made in-process: a new service, coordinator and agent clients against
  the same database and Runner. It was not a new operating-system process.
- **E2 and E1** depend on the injection: a wrapper standing for a slow PID 1, not a slow PID 1
  itself.
- **The slice's CPU ceiling** is shown as configured and in force (`cpu.max`). It was not
  measured under a load that needed more than one core.
- **Capacity** was shown with four 6 GiB guests, not ten 2 GiB guests; the budget arithmetic is
  the same.
