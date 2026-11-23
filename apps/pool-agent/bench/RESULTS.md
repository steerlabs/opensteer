# Pool agent on a real host (2026-11-21)

One Google Cloud VM, `pool-agent-run-1`: `n2-standard-8`, `us-central1-a`, nested
virtualization, one thread per core (4 cores), four Local SSDs striped and encrypted by
`setup-host.sh`, Ubuntu 24.04, Linux `7.0.0-1017-gcp`, no external address. Created
08:22:06Z, deleted 09:39:48Z. Agent and bench at `0c254a8f9` (the run used that tree's agent
and bench bundles). Raw rows: [results-2026-11-21.jsonl](results-2026-11-21.jsonl).

Guests: Firecracker v1.18.0 under the jailer, 2 vCPUs, 2 GiB, the measurement's Chromium
workload (`guestMode: bench`) from our browser runtime image, "ordinary" state (three tabs of
24 MiB and 1,200 rows, a draft, scroll 700, a marker, a ticking timer). Every call went through
the agent's signed HTTP interface; CDP went through the bridge seam as the relay user. Times
are from the moment the Home's call was sent, so they include the agent's journal writes,
the clock step and opening the network, which the measurement's times did not.

Each cell is median / p95 / min / max / n, in milliseconds.

| Series                               | First CDP reply                    | Original tab                      | Edited frame                      | Agent call                     | Save                               | Checks |
| ------------------------------------ | ---------------------------------- | --------------------------------- | --------------------------------- | ------------------------------ | ---------------------------------- | ------ |
| Cold start                           | 2,026 / 2,063 / 2,000 / 2,063 / 10 | —                                 | —                                 | 805 / 814 / 755 / 814 / 10     | —                                  | 10/10  |
| Paused in memory                     | 51.2 / 53.9 / 48.8 / 53.9 / 10     | 54.4 / 63.6 / 51.8 / 63.6 / 10    | 153 / 167 / 131 / 167 / 10        | 41.5 / 43.4 / 40.6 / 43.4 / 10 | —                                  | 10/10  |
| From disk, cache kept                | 299 / 487 / 274 / 487 / 10         | 340 / 706 / 312 / 706 / 10        | 635 / 1,169 / 556 / 1,169 / 10    | 120 / 201 / 96 / 201 / 10      | 1,899 / 2,623 / 1,534 / 2,623 / 10 | 10/10  |
| From disk, cache dropped             | 627 / 730 / 606 / 730 / 10         | 660 / 796 / 633 / 796 / 10        | 937 / 1,096 / 889 / 1,096 / 10    | 284 / 314 / 266 / 314 / 10     | 2,138 / 2,862 / 1,901 / 2,862 / 10 | 10/10  |
| Three wakes from disk while two save | 1,492 / 2,738 / 954 / 2,738 / 9    | 1,565 / 2,768 / 1,006 / 2,768 / 9 | 2,657 / 3,037 / 1,845 / 3,037 / 9 | 460 / 873 / 311 / 873 / 9      | 2,926–3,169 (6 saves)              | 9/9    |

"Checks" are the measurement's: the original tab answers with its draft, scroll, marker and
time origin (no reload), a typed edit shows in a new frame, its timer ticks, every tab's
workload is intact, plus an HTTPS request from the page after the wake. Beside the
measurement (`RESULTS.md` on `browser-pool-gcp`, 2 GiB ordinary, N2): paused in memory
4 ms / 97 ms (first reply / edited frame); one SSD, cache kept 190 / 740; four SSDs, cache
dropped 447 / 1,062; cold start 1,630; save 2.3 s on four SSDs.

Where the agent's time goes on a resume (its own log, ms): in memory, closing the gate 5–6,
vCPUs 0.7, clock step 1–40, opening the network 23–27; from disk, kill 1–7, restore (jail,
jailer, `LoadSnapshot`) 47–55, vCPUs 0.7–2, clock step 27–165, network 25 once the slot's
proxy stays up through the save (it was 620–730 when the proxy was restarted per wake).

## Clock after a 60-second sleep

| Path                       | Slept     | Guest behind the host after the wake | Clock source |
| -------------------------- | --------- | ------------------------------------ | ------------ |
| Paused in memory           | 60,109 ms | 9 ms                                 | `kvm-clock`  |
| Saved to disk and restored | 60,347 ms | 24 ms                                | `kvm-clock`  |

The measurement's restored guest was 60,054 ms behind (on `tsc`, no step).

## HTTPS after a wake through the host-side egress proxy

47 of 47 wakes: `fetch("https://example.com/…")` from the original tab returned (`opaque`),
on a new connection through the slot's browser-egress running on the host. This host has no
external address, so that proxy's upstream was a TLS forwarder to a temporary proxy over an
IAP tunnel (see `run-gcp.sh`); the slot proxy resolved `example.com` from a slot hosts file.

## Isolation, probed from inside a guest (a TCP connect from the guest's own Node)

| Target                                                 | Result      |
| ------------------------------------------------------ | ----------- |
| Own egress proxy `172.16.0.1:3128` (positive control)  | connected   |
| GCE metadata `169.254.169.254:80`                      | timeout     |
| GCE metadata IPv6 `fd20:ce::254:80`                    | ENETUNREACH |
| `fd00:ec2::254:80`                                     | ENETUNREACH |
| Agent Home port via the slot's veth `10.200.0.1:7310`  | timeout     |
| Agent admin port `10.200.0.1:7311`                     | timeout     |
| Agent Home port on the host address `10.42.0.6:7310`   | timeout     |
| Host sshd `10.42.0.6:22`                               | timeout     |
| Another guest's bridge `10.200.0.6:4312`               | timeout     |
| Another slot's proxy side `10.200.0.5:3128`            | timeout     |
| Internet direct `1.1.1.1:443`, DNS direct `8.8.8.8:53` | timeout     |
| Other ports on the proxy's address `172.16.0.1:22`     | timeout     |

From the host: root connecting to a guest's bridge port is refused (`ECONNREFUSED`); the relay
user connects. VMMs ran as one uid per slot (200000–200004), each in its own PID namespace
(`NSpid … 1`), with the default seccomp filter (`Seccomp: 2`).

## Agent killed (SIGKILL) in the middle of each transition

Each point fired (`agent.test-crash`) and the next agent recovered the open step (`recover`).

| Point                                                                  | The Home's repeated call                                        | Writers after | Cold start after |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- | ---------------- |
| `start:journaled`, `start:booted`                                      | refused `interrupted`, stopped, same answer twice               | 0             | 2,048 / 1,995 ms |
| `pause:paused`                                                         | refused `interrupted`, stopped                                  | 0             | 2,036 ms         |
| `resume:consumed`, `resume:resumed` (memory), `resume:restored` (disk) | refused `interrupted`, stopped                                  | 0             | 1,984–2,038 ms   |
| `stop:killed`                                                          | applied, stopped                                                | 0             | 2,026 ms         |
| `save:written`, `save:image-recorded`, `save:vmm-ended` (idle save)    | — (no call); the guest stayed parked and was on disk afterwards | 0             | 1,970–2,067 ms   |

## Found by this run and fixed before the numbers above

systemd could not restart the agent into its delegated cgroup with live guests (219/CGROUP:
fixed with `DelegateSubgroup=agent`); Ubuntu's nft refused a ruleset on a pipe; systemd would
not run the proxy as an unresolvable uid; the guest init wrote to its read-only root;
`docker cp` refused the egress image's dangling pnpm links; a parked slot's proxy restart cost
~0.6 s per disk wake; and the memory cgroup killed a VMM mid-save at guest + 512 MiB because
the memory file's page cache is charged to it (now twice the guest + 512 MiB).
