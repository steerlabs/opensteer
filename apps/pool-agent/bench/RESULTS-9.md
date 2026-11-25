# Pool host agent: ninth real-host run (2026-11-25, the faster wake)

## The instance

- **Shape:** `pool-agent-run-9`, an n2-standard-8 with one thread per core (4 cores, 31 GB),
  nested virtualization, four Local SSDs (NVMe), no external address, IAP only, Ubuntu 24.04,
  Linux `7.0.0-1017-gcp`, Intel Xeon @ 2.80GHz, Firecracker v1.18.0, Node v24.15.0.
- **The profiles' own disk:** `pool-agent-run-9-profiles`, a 20 GB pd-ssd attached as device
  `opensteer-profiles`, formatted ext4 with the label `osp-<12hex>` and mounted at
  `driver.profilesRoot`. `setup-host.sh boot` refuses to run without one (below).
- **Network:** its own, `pool-bench-net`, with subnet `10.201.0.0/24`, an IAP-only SSH rule and
  Cloud NAT. Package downloads and the bench's egress upstream used a local tinyproxy on
  `127.0.0.1:3128` through that NAT, in place of the IAP reverse tunnel of earlier runs.
  `run-gcp.sh`'s `PROXY` default already names that address.
- **Times:** created 15:33:47Z; deleted with all its disks at 16:18:08Z (44 min 21 s). The
  profiles disk, NAT, router, firewall rule, subnet and network were deleted by 16:19:20Z, and
  none of them is listed afterwards.
- **Cost:** about $0.60:
  - the instance, about $0.29
  - its four Local SSDs, about $0.12
  - the boot and profiles disks, about $0.01
  - Cloud NAT processing of a few GB of package and image downloads, about $0.15–0.25
- **Code:** a9e05f458 for the agent, the relay and the guest images. The bench is a9e05f458's,
  plus the `pull-wake` phase added in this commit.

## Raw rows

- `results-2026-11-25-run9a.jsonl`: the series beside run 6, plus `crash-loop`. Every row's own
  checks passed. Its last row is `failed`: the added `pull-wake` phase stopped at its first start
  (`run9b` below), so `assertAll()` did not run, and **this file has no `assertions` row**.
- `-run9b-standin-path.jsonl`: `pull-wake` alone, stopped at the same place. Cause: the helper
  starts the stand-ins from `/opt/pool-src/apps/pool-agent/bench`. The tree was unpacked at
  `/opt/pool-bench-src`, so both stand-in units exited with `MODULE_NOT_FOUND`, and the agent logged
  `egress.fetch-failed` (`SlotEgressUnavailable`). Fixed by a symlink `/opt/pool-src`.
- `-run9c-pull-wake.jsonl`: `pull-wake` alone after that fix, passed:
  `{"kind":"assertions","rows":5,"failed":[],"ok":true}`.
- `-run9-resumed.txt`: the agent's `resumed` lines from disk, 39 in non-pull mode and 4 in pull
  mode (`bench-pw-a`).

## Bench series beside run 6 (median / p95, ms, `summarize.mjs`)

These runs were in the bench's default mode, without pulled egress, as run 6's were. The bench
asserts each sample's checks; it asserts no time.

| Series                     | First CDP reply, run 9 | Run 6         | Edited frame, run 9 | Run 6         | Checks |
| -------------------------- | ---------------------- | ------------- | ------------------- | ------------- | ------ |
| Cold start                 | 2,128 / 2,179          | 2,181 / 2,250 | —                   | —             | 10/10  |
| Paused in memory           | 47.8 / 53.6            | 52.4 / 59.1   | 145 / 168           | 155 / 172     | 10/10  |
| From disk, cache kept      | 329 / 937              | 321 / 610     | 641 / 1,487         | 655 / 1,336   | 10/10  |
| From disk, cache dropped   | 646 / 705              | 646 / 756     | 949 / 1,055         | 995 / 1,186   | 10/10  |
| Three wakes while two save | 2,664 / 3,605          | 1,711 / 3,094 | 3,484 / 4,134       | 3,335 / 3,557 | 9/9    |
| After a concurrent save    | 357 / 1,029            | 346 / 554     | 669 / 1,404         | 683 / 1,268   | 6/6    |

Printed:

- **HTTPS after every wake:** 47 of 47 `opaque` across the series.
- **Proxy usage over the series:** 7 connections and 29.7 MB, against run 6's 7 and 84.0 MB.
- **Clock after 60 s parked:** 22 ms behind from memory and 44 ms from disk.
- **Saves:** cache kept 1,919 / 2,601 ms; the concurrent saves took 3,086–3,310 ms.
- **`crash-loop` passed:** 5 kills, the service `failed`, PID 1 used 1,270 ms of CPU. The status
  said `proxy: "down"`, HTTPS failed while it was down and loaded after the next start.
- **Not explained:** three wakes while two save were slower than run 6 at the median (2,664 against
  1,711 ms). This run did not find out why.

## The `resumed` steps from disk (ms, median / min / max)

| Step    | Pull mode, 4 wakes | Default mode, 39 wakes |
| ------- | ------------------ | ---------------------- |
| prepare | 13.5 / 13.3 / 25.1 | 12.7 / 5.9 / 26.9      |
| restore | 57.2 / 53.0 / 65.9 | 71.9 / 50.9 / 2,304    |
| clock   | 29.3 / 17.2 / 74.8 | 68.6 / 20.3 / 2,061    |
| network | 9.1 / 8.6 / 13.6   | 11.1 / 7.2 / 21.0      |

The default-mode maxima are from the wakes while two guests save.

Before this commit, on the test stack's pool host (pull mode, the 1.86 MB proxy bundle), `prepare`
was 755–820 ms. Most of that was the slot proxy's cold start, which the wake waited for.

Pull-mode lines as logged:

```
{"slotId":"bench-pw-a","tier":"disk","steps":{"host":7.5,"prepare":13.5,"close":5.6,"journal":4.1,"kill":2.3,"restore":65.9,"vcpus":1.8,"clock":74.8,"token":22.5,"network":8.9}}
{"slotId":"bench-pw-a","tier":"disk","steps":{"host":7.3,"prepare":13.3,"close":5.3,"journal":3.8,"kill":0.9,"restore":53,"vcpus":0.8,"clock":31.2,"token":17.7,"network":13.6}}
{"slotId":"bench-pw-a","tier":"disk","steps":{"host":7.2,"prepare":13.5,"close":5.3,"journal":3.7,"kill":0.9,"restore":55.5,"vcpus":3.9,"clock":27.4,"token":6.7,"network":8.6}}
{"slotId":"bench-pw-a","tier":"disk","steps":{"host":7.3,"prepare":25.1,"close":5.6,"journal":4.7,"kill":0.8,"restore":58.9,"vcpus":1.3,"clock":17.2,"token":5.5,"network":9.2}}
```

The fourth line is the wake under the crash loop (below).

## The slot proxy's cold start on this host

Method:

- The host's own `images/egress/dist/egress-main.js` (35,298 bytes), with `--use-system-ca`.
- Each run in an empty network namespace (`unshare -n`, loopback only), as uid 65534, on one CPU.
- Timed from exec to the first `/health` answer; 5 runs each.

| Case                                        | This host (35 KB bundle) | The test stack's pool host, 1.86 MB bundle |
| ------------------------------------------- | ------------------------ | ------------------------------------------ |
| No upstream (the bundle only)               | 120–132                  | 574–584                                    |
| With an upstream and dummy credential files | 157–168                  | 605–627                                    |
| Bare `node -e 0`                            | 60–81                    | 59–68                                      |

The trust context, timed in-process: reading the CA lists took 25.2 ms (default 508, system 363),
and building one context of 266 certificates took 24.1 ms.

## `pull-wake`: the production wake path (added in this commit)

The new wake path runs only when the agent pulls its egress (`driver.requireEgressUpstream`). In
that mode the proxy is probed alongside the restore, and `proxy: "down"` is reported when it does
not come up. `run-gcp.sh agent` does not set that mode, and the bench's wake series run before its
pull phases. So the phase does the following:

1. It starts the stand-ins and switches the agent to pull mode.
2. It makes a slot `bench-pw-a` with pulled credentials. The phase retries its first start while the
   stand-in account service is still starting.
3. It runs three wakes from disk with HTTPS after each.
4. It makes one more wake from disk while the bench's `proxy-crash-loop` helper kills the proxy
   whenever it runs (45 s, started 6 s before the wake).
5. After the loop ends, it parks the slot in memory and wakes it again.

Asserted (`run9c`, passed):

- **The three wakes from disk:** each resume call took 259, 191 and 177 ms. The first CDP reply came
  683, 570 and 397 ms after the wake began, and HTTPS was `opaque` at 1,166, 905 and 717 ms.
- **The wake under the crash loop:** the resume call returned in 177 ms. The guest was `running`, and
  its status said `proxy: "down"` 5,165 ms after the wake began. HTTPS failed
  (`TimeoutError: signal timed out`). The loop made 8 kills, the service `failed`, and PID 1 used
  1,310 ms of CPU.
- **After the loop, a park in memory and a wake:** the resume call took 96 ms, HTTPS was `opaque` and
  the status had no `proxy` field.

The phase polls the status first and opens CDP afterwards. Its "first CDP reply while down"
(5,219 ms) therefore includes that polling and is not a wake time.

## What the run needed that `run-gcp.sh` does not do

- **A profiles disk.** `setup-host.sh boot` (called from `run-gcp.sh images`) refuses with
  "OSP_PROFILE_DISK is empty", and it requires the device path
  `/dev/disk/by-id/google-opensteer-profiles`. Runs 7 and 8 had such a disk. This run attached one
  with that device name, made the ext4 label, mounted it and wrote both settings to `host.env`.
- **The source at `/opt/pool-src`.** The helper starts the stand-ins from there. The relay user also
  cannot read a tree under `/root`.

Neither comes from a9e05f458.
