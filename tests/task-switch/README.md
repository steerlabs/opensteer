# Personal task switch benchmark

Run from the repository root with the workspace dependencies installed. The existing Personal Host fixture needs the plugin engine build. The benchmark builds the Web bundle itself on each run.

```sh
pnpm --filter apps build
pnpm --filter @opensteer/host build
pnpm --filter @opensteer/web exec playwright-core install chromium

export OPENSTEER_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:5432/postgres
export OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL="$OPENSTEER_TEST_DATABASE_URL"
OPENSTEER_TASK_SWITCH_RESULTS=task-switch-results.json pnpm bench:task-switch
```

Use a local test PostgreSQL server and an account that can create databases and install the standard `pgrowlocks` extension. Both URLs can point to the same server. The shared test database fixture creates unique templates and a clone and drops them after the run. The Host listens on loopback and serves the built app. Set `OPENSTEER_CHROMIUM_EXECUTABLE` to use a specific Chromium executable. The default output is `task-switch-results.json` at the repository root.

## Workload

The benchmark opens a signed-in Personal workspace in headless Chromium and clicks real sidebar task links. It uses the production Web entry, real browser client and IndexedDB, and a Personal Host with real HTTP, WebSocket, and PostgreSQL. The benchmark instruments the build in memory and uses the existing Personal Host, Web distribution manifest, and database fixtures. The mock Web journeys are useful for renderer/layout checks. They get their transcript from an in-process mock and cannot establish the sync or network cost measured here.

- **Warm** runs 10 selections between A and B after opening both with short transcripts.
- **Inactive with 100 commits** leaves B running while A is selected, writes 49 browser tool calls (start and completion) and two short replies to B, then selects B. It repeats three times. The baseline takes the replay path.
- **Inactive with 1,000 commits** repeats the inactive workload with 499 tool calls and two short replies to measure the bounded snapshot with short messages.
- **Inactive with 1,000 commits and reports** writes 498 browser tool calls, a short reply, and three reports of roughly 24, 64, and 112 KiB during each of three absences. The baseline takes the bounded snapshot path. The client window must contain the three newest reports and tool entries. The largest report is the newest reply and exercises Markdown rendering at the tail.
- **Warm with reports** revisits the same research task five times with no more writes. It tests the work of opening a recent, heavy transcript independently of the backlog.

Each background event is persisted by the normal Runner event store in its own transaction. The tool inputs and outputs are generated locally, and writing stops before the measured click. Before each 1,000-commit absence, the harness uses the client's public latest-window action to clear any historical reading anchor. It also uses the on-screen jump when offered. Both actions occur outside the measured interval. The run can therefore be repeated without a live agent, a real website, or external network latency. “Inactive” means the task was left open in the same browser session while the user viewed A. The benchmark allows the normal retention and checkpoint policy to choose the resume source. It does not force memory eviction, insert a fixed storage delay, or reload the renderer.

## Measurements

- **First transcript paint** starts at the captured sidebar click. The probe matches the destination's conversation header and finds a text-bearing row inside its visible transcript and records the following animation frame. This measures a rendering opportunity with visible content. Chromium may present that frame later, and another transcript element could have appeared earlier.
- **Newest reply paint** uses the same method for the newest fixture reply. It is nullable because the reader may remain at an older position. The sample still requires the newest reply to exist in synchronized state.
- **Synchronized** is the first public transcript snapshot with `synchronized` true and the newest seeded reply. This includes browser application of the cut. It does not wait for every auxiliary read.
- **Notifications** count callbacks from one public transcript subscription and one public Host snapshot subscription. The transcript count through synchronization is reported separately. React may batch those callbacks into fewer commits. The benchmark does not use the React DevTools hook or a profiling build.
- **Long tasks** use Chromium's Long Tasks API, including browser-main-thread intervals of at least 50 ms that overlap the sample. The JSON records each task's start relative to the click and its total duration.
- **Transport** includes the WebSocket messages observed by Playwright just before the click through the end of the sample, grouped by direction, frame type and scope. Payload sizes are UTF-8 JSON bytes before WebSocket framing. Selected subscribe messages record whether they carried a resume cursor or a reading anchor. HTTP RPCs started during the sample are grouped by method. Request query and body bytes and encoded response body bytes exclude headers, and responses still outstanding are counted separately.
- **Markdown** counts the public `unified().parse` calls made by `react-markdown` across the page. This covers the current transcript renderer and may include other Markdown in the workspace. A replacement parser would need its own probe. If the instrumented package is absent, the metric is null.

The observation window extends 250 ms past detection of the first content paint and synchronized state, so it captures typical follow-up reads and updates. The output contains raw samples and nearest-rank p50 and p95. With three samples, p95 equals the largest observation. Compare runs on the same machine and keep the frame counts beside timings when trying changes to replay or snapshot behavior.

## Main baseline

[baseline.json](baseline.json) records unmodified product code at `6e4687d2d48345f57f9ba6f13b6789e5382e9c50`. The full command took 67 seconds on a shared Apple M5 Max Mac with 18 cores and 128 GiB of RAM, macOS 27.0.1, Node 24.15.0, headless Chromium 151.0.7922.34, and native PostgreSQL 17.11. The browser, Host, and database ran on the same Mac over loopback.

| Scenario                            | Samples | First paint p50 | Synchronized p50 | Transcript notifications through sync p50 | Markdown parses p50 | Long tasks p50 |
| ----------------------------------- | ------: | --------------: | ---------------: | ----------------------------------------: | ------------------: | -------------: |
| Warm                                |      10 |         22.3 ms |          16.0 ms |                                         1 |                   2 |              0 |
| Inactive, 100 commits               |       3 |         22.7 ms |         399.7 ms |                                       103 |                   5 |              0 |
| Inactive, 1,000 commits             |       3 |         22.3 ms |          27.9 ms |                                         2 |                   2 |              0 |
| Inactive, 1,000 commits and reports |       3 |        261.6 ms |         700.0 ms |                                         2 |               1,786 |              6 |
| Warm with reports                   |       5 |        309.8 ms |         305.7 ms |                                         1 |                 893 |              5 |

Every 100-commit sample received 100 change frames before the first detail synchronization and exposed 103 transcript notifications through that point. It issued six HTTP RPCs during the observation window. The other scenarios issued three. Every 1,000-commit sample received one snapshot, about 29 kB of selected WebSocket payload for short messages and 250 kB with reports. The research window had 50 entries, including 46 tool entries and the three reports. The newest replayed reply stayed outside the viewport for all three 100-commit samples, which explains the empty newest-reply paint distribution for that case.
