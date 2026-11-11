import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, loadavg, release } from "node:os";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  createMachineAccessDatabase,
  enrollmentToken,
  startMachineAccessHost,
} from "../apps/host/src/runtime/machine-access.test-support.js";
import { startBrowserRuntime } from "../apps/host/src/browser/browser-runtime.test-support.js";
import { testRpcData } from "../apps/host/src/server/test-host-api-request.js";
import { linkProfiles, startShapingProxy } from "./mobile-network/proxy.test-support.js";
import { installFixture } from "./browser-stream/fixture.test-support.js";
import {
  benchmarkTimeoutMs,
  browserStreamOptions,
  causalLatencies,
  distribution,
  motionMetrics,
  resolveInputs,
  scenarioDeadlineMs,
  scenarios,
} from "./browser-stream/metrics.test-support.js";
import { startJpegProducer } from "./browser-stream/producer.test-support.js";
import type { ViewerRun } from "./browser-stream/viewer.test-support.js";

type Distribution = ReturnType<typeof distribution>;
type Clock = Awaited<ReturnType<typeof calibrate>>;
interface BenchmarkSample {
  producer: string;
  profile: string;
  scenario: string;
  run: number;
  loadAverage: number[];
  inputDurationMs: number;
  tailDrainMs: number;
  inputToPixelsMs: Distribution;
  unmatchedInputs: number;
  attemptedInputs: number;
  rejectedInputs: number;
  pictureAgeMs: Distribution;
  clockUncertaintyMs: number;
  motion: ReturnType<typeof motionMetrics> | null;
  viewerReceiveToPresentMs: Distribution;
  hostQueueResidenceMs: null;
  producerQueueResidenceMs: null;
  bytesUp: number;
  bytesDown: number;
  invalidMarkers: number;
  errors: string[];
  clocks: { sourceClock: Clock; viewerClock: Clock; sourceAfter: Clock; viewerAfter: Clock };
  trace: ViewerRun;
}

const deadline = <T>(operation: Promise<T>, message: string, timeoutMs = 25_000) =>
  withTimeout(operation, timeoutMs, { timeoutError: () => new Error(message) });

/** Monotonic echo brackets, not Date/timeOrigin guesses. The shortest round trip bounds the offset. */
async function calibrate(read: () => Promise<number>) {
  const echoes = [];
  for (let sample = 0; sample < 7; sample++) {
    const before = performance.now();
    const remote = await read();
    const after = performance.now();
    echoes.push({ offsetMs: (before + after) / 2 - remote, uncertaintyMs: (after - before) / 2 });
  }
  return echoes.toSorted((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0]!;
}

const requested = process.env.OPENSTEER_BROWSER_STREAM_BENCH;
const benchmarkOptions = requested ? browserStreamOptions.parse(JSON.parse(requested)) : null;

it(
  "measures browser input through Host, shaped transport, shared Watch and real canvas presentation",
  async () => {
    if (!benchmarkOptions) throw new Error("Use pnpm bench:browser-stream");
    if (!process.env.OPENSTEER_TEST_DATABASE_URL)
      throw new Error("Benchmark requires an isolated test PostgreSQL database");
    const options = benchmarkOptions;
    const profiles =
      options.profile === "all" ? (["lan", "4g", "weak-cell"] as const) : [options.profile];
    const selected = options.scenario === "all" ? scenarios : [options.scenario];
    const bundle = await build({
      entryPoints: [join(import.meta.dirname, "browser-stream/viewer.test-support.ts")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
    });
    const samples: BenchmarkSample[] = [];
    const report = {
      version: 1,
      status: "running",
      sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      measuredAt: new Date().toISOString(),
      environment: {
        node: process.version,
        chromium: chromium.executablePath(),
        arch: arch(),
        os: release(),
        loadAverage: loadavg(),
        sharedMachine: true,
      },
      options,
      profiles: linkProfiles,
      methodology: {
        path: "Production headless Chromium launcher/BrowserRuntime/BrowserRuntimeServer; enrolled relay fixture verifies Host tickets; real isolated Host and PostgreSQL; native viewer WebSockets through the mobile-network shaping proxy; BrowserWatchStore plus production web attachBrowserCanvas (JPEG decode and rAF draw). Control has no pictures; Watch owns presented-frame credit.",
        causality:
          "Each scenario has a fresh pixel epoch. The page paints actual scrollTop/scrollY, field length or click count, plus monotonic paint time and checksum into a fixed binary marker only when DOM state changes. After the production presenter draws, the viewer decodes that canvas. Each input is matched to the first presentation whose monotonic state reaches its cumulative target. Coalesced inputs share a presentation; receipt/ACK alone never counts. Marker tracking may lag compositor scrolling by one source rAF.",
        clocks:
          "Input dispatch and presentation use one viewer performance.now clock. Picture age is source marker-paint to viewer draw, using minimum-RTT monotonic echo brackets against the Node clock before/after each workload. Reported uncertainty includes echo half-RTTs and observed offset drift; no cross-process wall clocks.",
        presentation:
          "Presentation is the production headless canvas draw callback, before marker readback; it is not physical scanout. Canvas readback adds benchmark work after the timed boundary. Source marker is 256x40 CSS pixels; viewport/viewer 800x600, DPR 1.",
        traffic:
          "Delivered TCP payload bytes in both directions (HTTP/WebSocket framing included), from first input through presentation of the final causal state. Attach, warmup and fixture setup excluded. No TLS, radio scheduling, congestion, retransmission or packet loss model. Scenario duration is input generation; tail drain is separately reported.",
        queues:
          "viewerReceiveToPresentMs measures residence from Watch receipt to canvas draw, including pending picture, JPEG decode and rAF. Host/producer internal queue residence is not exposed and is null, not inferred from RTT.",
        comparison:
          "Serial workloads on a shared loaded Mac; descriptive measurements, no timing pass/fail thresholds. Keep workload, viewport, profiles and presentation boundary fixed when replacing the producer/decoder.",
        workload:
          "Scroll: 12 CSS pixels at 60Hz paced by viewer rAF for --duration seconds, without waiting for feedback. Typing: the fixed 40-character sentence, one native key down/up pair per visible acknowledgement. Click: eight native down/up pairs, each changes the page and waits for visible acknowledgement. Discrete probes measure latency, not burst typing throughput. Explicit browser-input-overload sequence ranges count as rejected inputs; their effects are removed from subsequent cumulative pixel targets. Latency quantiles cover accepted inputs only; rejections are always reported separately. Missing pixels for accepted inputs still fail the run.",
      },
      samples,
    };
    const save = async () => {
      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
    };
    await save();
    let epoch = 0;
    try {
      for (const profile of profiles) {
        for (let run = 1; run <= options.runs; run++) {
          const cleanup: (() => Promise<unknown>)[] = [];
          const failures: unknown[] = [];
          try {
            const database = await createMachineAccessDatabase(
              process.env.OPENSTEER_TEST_DATABASE_URL,
            );
            cleanup.push(() => database.drop());
            const host = await startMachineAccessHost(database.url, {
              logger: { level: "silent" },
            });
            cleanup.push(() => host.close());
            const producer = await startJpegProducer();
            cleanup.push(() => producer.close());
            const relay = await startBrowserRuntime(
              host.hostPort,
              await enrollmentToken(host, {
                allowedModules: ["browser"],
                idempotencyKey: "browser-bench",
                name: "Headless browser benchmark",
              }),
              { agentReady: true, editing: true, runtimeUrl: producer.runtimeUrl, keepAlive: true },
            );
            cleanup.push(() => relay.close());
            const opened = await testRpcData(
              host.origin,
              "commands.dispatch",
              {
                type: "browser.session.start",
                idempotencyKey: "browser-bench-session",
                input: { fresh: true, reuseExisting: false },
              },
              { headers: host.ownerHeaders },
            );
            if (opened.type !== "browser.session.start")
              throw new Error("Browser command mismatch");
            cleanup.push(() =>
              testRpcData(
                host.origin,
                "commands.dispatch",
                {
                  type: "browser.session.close",
                  sessionId: opened.session.id,
                  idempotencyKey: "close-benchmark",
                },
                { headers: host.ownerHeaders },
              ),
            );
            const proxy = await startShapingProxy(new URL(host.origin), linkProfiles[profile]);
            cleanup.push(() => proxy.close());
            const viewer = await chromium.launch({ headless: true });
            cleanup.push(() => deadline(viewer.close(), "Viewer Chromium did not close"));
            const context = await viewer.newContext({
              viewport: { width: 800, height: 600 },
              deviceScaleFactor: 1,
            });
            // The synthetic document is fulfilled locally; Chromium otherwise treats its
            // network address space as unknown when dialing the loopback shaping proxy.
            await context.grantPermissions(["local-network-access"], { origin: host.origin });
            const cookie = host.ownerHeaders.cookie;
            if (!cookie) throw new Error("Fixture owner has no cookie");
            await context.addCookies(
              cookie.split(";").map((part) => {
                const separator = part.indexOf("=");
                return {
                  name: part.slice(0, separator).trim(),
                  value: part.slice(separator + 1),
                  url: host.origin,
                };
              }),
            );
            const page = await context.newPage();
            const viewerErrors: string[] = [];
            page.on("pageerror", (error) => viewerErrors.push(String(error)));
            page.on("console", (message) => {
              if (message.type() === "error") console.error(`Viewer: ${message.text()}`);
            });
            await page.route(`${host.origin}/benchmark-viewer`, (route) =>
              route.fulfill({
                contentType: "text/html",
                body: "<style>html,body{margin:0}main{width:800px;height:600px}canvas{width:800px;height:600px}</style><main><canvas></canvas></main>",
              }),
            );
            await page.goto(`${host.origin}/benchmark-viewer`);
            await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
            await deadline(
              page.evaluate((connection) => window.browserStreamBench.connect(connection), {
                origin: proxy.origin,
                sessionId: opened.session.id,
                surfaceId: producer.surfaceId(),
              }),
              "Viewer did not connect",
            );
            cleanup.push(() => page.evaluate(() => window.browserStreamBench.stop()));
            const bytes = () =>
              proxy.connections.reduce(
                (sum, connection) => ({
                  up: sum.up + connection.bytesUp,
                  down: sum.down + connection.bytesDown,
                }),
                { up: 0, down: 0 },
              );
            for (const scenario of selected) {
              epoch++;
              await deadline(
                producer.evaluate(
                  `(${installFixture.toString()})(${JSON.stringify({ scenario, epoch })})`,
                ),
                "Source fixture did not install",
              );
              await deadline(
                page.evaluate((id) => window.browserStreamBench.ready(id), epoch),
                "Viewer never presented the new fixture",
              );
              const sourceClock = await calibrate(() =>
                producer.evaluate<number>("performance.now()"),
              );
              const viewerClock = await calibrate(() => page.evaluate(() => performance.now()));
              const byteStart = bytes();
              const result: ViewerRun = await deadline(
                page.evaluate((input) => window.browserStreamBench.run(input), {
                  epoch,
                  scenario,
                  duration: options.duration,
                }),
                `Workload did not settle: ${profile}/${scenario}`,
                scenarioDeadlineMs(scenario, options.duration),
              );
              const byteEnd = bytes();
              const sourceAfter = await calibrate(() =>
                producer.evaluate<number>("performance.now()"),
              );
              const viewerAfter = await calibrate(() => page.evaluate(() => performance.now()));
              const clockUncertaintyMs =
                sourceClock.uncertaintyMs +
                viewerClock.uncertaintyMs +
                Math.abs(sourceAfter.offsetMs - sourceClock.offsetMs) +
                Math.abs(viewerAfter.offsetMs - viewerClock.offsetMs) +
                1;
              const pictures = result.pictures.filter((picture) => picture.at >= result.start);
              const resolved = resolveInputs(result.inputs, result.rejections);
              const accepted = resolved.filter((input) => !input.rejected);
              const latencies = causalLatencies(accepted, pictures);
              const sample = {
                producer: producer.encoding,
                profile,
                scenario,
                run,
                loadAverage: loadavg(),
                inputDurationMs: result.end - result.start,
                tailDrainMs: result.finished - result.end,
                inputToPixelsMs: distribution(
                  latencies.filter((value): value is number => value !== null),
                ),
                unmatchedInputs: latencies.filter((value) => value === null).length,
                attemptedInputs: result.inputs.length,
                rejectedInputs: resolved.length - accepted.length,
                pictureAgeMs: distribution(
                  pictures.map(
                    (picture) =>
                      picture.at - picture.paintedAt - sourceClock.offsetMs + viewerClock.offsetMs,
                  ),
                ),
                clockUncertaintyMs,
                motion: scenario.endsWith("scroll")
                  ? motionMetrics(pictures, result.start, result.end)
                  : null,
                viewerReceiveToPresentMs: distribution(
                  pictures.map((picture) => picture.at - picture.receivedAt),
                ),
                hostQueueResidenceMs: null,
                producerQueueResidenceMs: null,
                bytesUp: byteEnd.up - byteStart.up,
                bytesDown: byteEnd.down - byteStart.down,
                invalidMarkers: result.invalidMarkers,
                errors: [...result.errors, ...viewerErrors, ...relay.protocolErrors()],
                clocks: { sourceClock, viewerClock, sourceAfter, viewerAfter },
                trace: result,
              };
              samples.push(sample);
              await save();
              console.info(
                `Measured ${profile}/${scenario}: ${sample.inputToPixelsMs.p50?.toFixed(0)}/${sample.inputToPixelsMs.p95?.toFixed(0)}ms; ${sample.rejectedInputs}/${sample.attemptedInputs} rejected, ${sample.unmatchedInputs} unmatched`,
              );
              expect(sample.errors).toEqual([]);
              expect(sample.unmatchedInputs).toBe(0);
              expect(sample.inputToPixelsMs.count).toBeGreaterThan(0);
              expect(sample.inputToPixelsMs.count + sample.rejectedInputs).toBe(
                sample.attemptedInputs,
              );
              expect(result.pictures.at(-1)?.value).toBe(resolved.at(-1)?.expected);
              expect(sample.invalidMarkers).toBe(0);
            }
          } catch (error) {
            failures.push(error);
          } finally {
            for (const close of cleanup.reverse()) {
              try {
                await deadline(close(), "Browser benchmark cleanup did not finish");
              } catch (error) {
                failures.push(error);
              }
            }
          }
          if (failures.length)
            throw new AggregateError(failures, "Browser benchmark or cleanup failed");
        }
      }
      report.status = "complete";
    } catch (error) {
      report.status = "failed";
      throw error;
    } finally {
      await save();
    }
    const round = (value: number | null | undefined) =>
      value == null ? "—" : Number(value.toFixed(1));
    console.table(
      samples.map((sample) => ({
        link: sample.profile,
        scenario: sample.scenario,
        run: sample.run,
        "input p50 ms": round(sample.inputToPixelsMs.p50),
        "input p95 ms": round(sample.inputToPixelsMs.p95),
        "age p50 ms": round(sample.pictureAgeMs.p50),
        "age p95 ms": round(sample.pictureAgeMs.p95),
        "clock ± ms": round(sample.clockUncertaintyMs),
        fps: round(sample.motion?.fps),
        "jitter ms": round(sample.motion?.pacingJitterMs),
        "viewer queue p95 ms": round(sample.viewerReceiveToPresentMs.p95),
        downKiB: round(sample.bytesDown / 1024),
        upKiB: round(sample.bytesUp / 1024),
        "tail ms": round(sample.tailDrainMs),
        refused: `${sample.rejectedInputs}/${sample.attemptedInputs}`,
      })),
    );
    console.info(`JSON report: ${options.out}`);
  },
  benchmarkOptions ? benchmarkTimeoutMs(benchmarkOptions) : undefined,
);
