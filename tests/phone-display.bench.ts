/* oxlint-disable opensteer/no-real-time-wait-in-tests, opensteer/no-polling-loop-in-tests -- This opt-in benchmark uses fixed sampling/workload intervals to measure real-time delivery and idle traffic; no wait establishes readiness. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import WebSocket from "ws";
import { it } from "vitest";
import type { WebSocketClient } from "../packages/client/src/host/host-session-client.js";
import { decodeDisplayMediaFrame } from "../packages/protocol/src/display-stream.js";
import {
  DisplayStreams,
  type DisplayFrame,
} from "../packages/client/src/integrations/phone-display-stream.js";
import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  createMachineAccessDatabase,
  freePort,
} from "../apps/host/src/runtime/machine-access.test-support.js";
import { testRpcData } from "../apps/host/src/server/test-host-api-request.js";
import {
  acquireAndroidDevice,
  buildE2eAgentPhone,
  createTestCertificateAuthority,
  findView,
  fixtureActivities,
  installFixture,
  Redaction,
  resetPhone,
  runAgentPhoneSetup,
  runCommand,
  startAgentPhoneHost,
  startTlsFrontDoor,
  waitForPhoneOnline,
} from "../apps/host/src/agent-phone/agent-phone-device.test-support.js";
import {
  linkProfiles,
  startShapingProxy,
  type ProfileName,
} from "./mobile-network/proxy.test-support.js";

function percentile(values: number[], fraction: number): number | null {
  return values.length
    ? values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!
    : null;
}

it("measures the real phone, relay, shared client and headless WebCodecs viewer", async () => {
  const directory =
    process.env.OPENSTEER_PHONE_BENCH_OUT ??
    (await mkdtemp(join(tmpdir(), "opensteer-phone-bench-")));
  await mkdir(directory, { recursive: true });
  process.stdout.write(`Phone display benchmark: ${directory}\n`);
  const scratch = await mkdtemp(join(tmpdir(), "opensteer-phone-bench-scratch-"));
  const cleanup: (() => Promise<unknown>)[] = [() => rm(scratch, { recursive: true, force: true })];
  const results: unknown[] = [];
  const failures: unknown[] = [];
  try {
    const authority = await createTestCertificateAuthority(scratch);
    const build = await buildE2eAgentPhone({ authority, log: join(directory, "build.log") });
    process.stdout.write("Benchmark APK built\n");
    const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    cleanup.push(() => database.drop());
    const stalls: { at: number; ageMs: number }[] = [];
    const host = await startAgentPhoneHost(database.url, {
      publicPort: await freePort(),
      log: (line) => {
        const entry = JSON.parse(line) as { msg?: string; oldestAckAgeMs?: number };
        if (entry.msg === "computer.display.viewer-credit-stall")
          stalls.push({ at: performance.now(), ageMs: entry.oldestAckAgeMs ?? 0 });
      },
    });
    cleanup.push(() => host.close());
    const ingress = new Map<number, number>();
    const front = await startTlsFrontDoor({
      authority,
      hostPort: host.hostPort,
      port: Number(new URL(host.publicOrigin).port),
      onDisplayMedia: (bytes) => {
        const frame = decodeDisplayMediaFrame(bytes);
        ingress.set(frame.header.sequence, performance.now());
        if (ingress.size > 1200) ingress.delete(ingress.keys().next().value!);
      },
    });
    cleanup.push(() => front.close());
    const phone = await acquireAndroidDevice({
      api: 33,
      emulatorLog: join(directory, "emulator.log"),
    });
    cleanup.push(() => phone.close());
    process.stdout.write("Benchmark Host ready; resetting selected emulator\n");
    await resetPhone(phone);
    await installFixture(phone);
    const setup = await runAgentPhoneSetup({
      artifact: build.artifact,
      device: phone,
      host,
      redaction: new Redaction(),
      runnerName: "Display benchmark",
      onStep: (step) => process.stdout.write(`Phone setup: ${step.step}\n`),
      timeoutMs: 600_000,
    });
    if (setup.outcome !== "done") throw new Error(`Phone setup stopped: ${JSON.stringify(setup)}`);
    await waitForPhoneOnline(phone, host, setup.runnerId, 60_000);
    await phone.shell("svc power stayon true");
    cleanup.push(() => phone.shell("svc power stayon false"));
    await phone.shell("input keyevent KEYCODE_WAKEUP");
    await phone.shell(`am start -W -n ${fixtureActivities.display}`);
    const list = await findView(phone, {
      activity: fixtureActivities.display,
      viewId: "fixture_list",
    });
    if (!("point" in list)) throw new Error(list.missing);
    const center = list.point;
    const stroke = 180;
    const browser = await chromium.launch({ headless: true });
    cleanup.push(() => browser.close());
    const revision = (await runCommand("git", ["rev-parse", "HEAD"])).trim();
    const profiles = (process.env.OPENSTEER_PHONE_BENCH_PROFILES ?? "lan,4g,weak-cell").split(
      ",",
    ) as ProfileName[];
    const windows = (
      process.env.OPENSTEER_PHONE_BENCH_WINDOWS ??
      process.env.OPENSTEER_PHONE_BENCH_WINDOW ??
      "0"
    ).split(",");
    for (const { profile, window } of profiles.flatMap((profile) =>
      windows.map((window) => ({ profile, window })),
    )) {
      if (!["0", "1"].includes(window)) throw new Error("Window must be 0 or 1");
      ingress.clear();
      if (!Object.hasOwn(linkProfiles, profile))
        throw new Error(`Unknown link profile: ${profile}`);
      const proxy = await startShapingProxy(new URL(host.origin), linkProfiles[profile]);
      const pools: DisplayStreams[] = [];
      const pages: Page[] = [];
      const opened = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "computer.view.open",
          machineId: setup.runnerId,
          target: { kind: "phone", display: "main" },
          idempotencyKey: randomUUID(),
        },
        { headers: host.ownerHeaders },
      );
      if (opened.type !== "computer.view.open") throw new Error("Unexpected open result");
      const source = {
        kind: "owner-view" as const,
        viewId: opened.view.viewId,
        generation: opened.view.generation,
      };
      try {
        const viewer = async () => {
          const page = await browser.newPage();
          pages.push(page);
          await page.goto(host.origin);
          const received: { at: number; frame: DisplayFrame }[] = [];
          const paints: { at: number; sequence: number; relayAgeMs: number | null }[] = [];
          const errors: string[] = [];
          const recordError = (message: string) => {
            if (errors.length < 8) errors.push(message);
          };
          const submissions = new Set<Promise<unknown>>();
          let firstResolve!: () => void;
          const first = new Promise<void>((resolve) => {
            firstResolve = resolve;
          });
          await page.exposeFunction("painted", (sequence: number) => {
            const at = performance.now();
            const sent = ingress.get(sequence);
            paints.push({ at, sequence, relayAgeMs: sent === undefined ? null : at - sent });
            firstResolve();
          });
          await page.exposeFunction("decodeFailed", (message: string) => recordError(message));
          await page.evaluate(() => {
            const sink = globalThis as typeof globalThis & {
              accept: (packet: {
                header: {
                  codec?: string;
                  key: boolean;
                  width: number;
                  height: number;
                  ptsUs: number;
                  sequence: number;
                };
                data: string;
                replayed: boolean;
              }) => void;
              painted: (sequence: number) => void;
              decodeFailed: (message: string) => void;
            };
            const canvas = document.createElement("canvas");
            document.body.append(canvas);
            const context = canvas.getContext("2d")!;
            const pending = new Map<number, { sequence: number; replayed: boolean }>();
            const decoder = new VideoDecoder({
              output: (frame) => {
                const item = pending.get(frame.timestamp);
                pending.delete(frame.timestamp);
                if (item && !item.replayed) {
                  context.drawImage(frame, 0, 0);
                  sink.painted(item.sequence);
                }
                frame.close();
              },
              error: (error) => sink.decodeFailed(String(error)),
            });
            sink.accept = (packet) => {
              const { header } = packet;
              if (decoder.state === "unconfigured") {
                canvas.width = header.width;
                canvas.height = header.height;
                decoder.configure({
                  codec: header.codec!,
                  optimizeForLatency: true,
                  hardwareAcceleration: "prefer-software",
                });
              }
              pending.set(header.ptsUs, { sequence: header.sequence, replayed: packet.replayed });
              decoder.decode(
                new EncodedVideoChunk({
                  type: header.key ? "key" : "delta",
                  timestamp: header.ptsUs,
                  data: Uint8Array.from(atob(packet.data), (byte) => byte.charCodeAt(0)),
                }),
              );
            };
          });
          const pool = new DisplayStreams({
            connect: (ref) => {
              if (ref.kind !== "owner-view") throw new Error("Expected owner source");
              const url = new URL(
                `/v1/computer-use/views/${ref.viewId}/${ref.generation}/display`,
                proxy.origin,
              );
              url.protocol = "ws:";
              if (window === "1") url.searchParams.set("displayWindow", "1");
              const socket = new WebSocket(url, {
                headers: { ...host.ownerHeaders, host: new URL(host.publicOrigin).host },
              });
              socket.on("error", (error) => recordError(String(error)));
              return socket as unknown as WebSocketClient;
            },
          });
          pools.push(pool);
          const started = performance.now();
          const bytesBefore = proxy.connections.reduce(
            (sum, c) => sum + c.bytesDown + c.bytesUp,
            0,
          );
          const lease = pool.retain({ scope: profile, source });
          lease.onFrame((frame) => {
            received.push({ at: performance.now(), frame });
            const job = page
              .evaluate(
                (packet) =>
                  (globalThis as unknown as { accept: (packet: unknown) => void }).accept(packet),
                {
                  header: frame.header,
                  data: Buffer.from(frame.payload).toString("base64"),
                  replayed: frame.replayed,
                },
              )
              .catch((error) => {
                recordError(String(error));
              })
              .finally(() => {
                frame.done();
                submissions.delete(job);
              });
            submissions.add(job);
          });
          await withTimeout(first, 30_000, {
            timeoutError: () =>
              new Error(`Headless viewer never painted a frame: ${errors.join("; ")}`),
          });
          const firstPaintMs = paints[0]!.at - started;
          const joinBytes =
            proxy.connections.reduce((sum, c) => sum + c.bytesDown + c.bytesUp, 0) - bytesBefore;
          return { received, paints, firstPaintMs, joinBytes, errors, lease, submissions };
        };
        const cold = await viewer();
        const motionStart = performance.now();
        const inputTimes: number[] = [];
        // Each swipe is a real fixture gesture. Duration is workload, not a readiness wait.
        for (let turn = 0; turn < 18; turn++) {
          inputTimes.push(performance.now());
          const direction = turn % 2 === 0 ? 1 : -1;
          await phone.shell(
            `input swipe ${center.x} ${center.y + direction * stroke} ${center.x} ${center.y - direction * stroke} 350`,
          );
        }
        const motionEnd = performance.now();
        const active = cold.paints.filter((p) => p.at >= motionStart && p.at < motionEnd);
        const gaps = active.slice(1).map((p, i) => p.at - active[i]!.at);
        const activeFrames = cold.received.filter((p) => p.at >= motionStart && p.at < motionEnd);
        // Observe the fixed refinement tail separately from the static measurement.
        await delay(5_000);
        const idleStart = performance.now();
        const bytesAtIdle = proxy.connections.reduce((sum, c) => sum + c.bytesDown + c.bytesUp, 0);
        await delay(3_000);
        const idleBytesPerSecond =
          (proxy.connections.reduce((sum, c) => sum + c.bytesDown + c.bytesUp, 0) - bytesAtIdle) /
          ((performance.now() - idleStart) / 1000);
        const joined = await viewer();
        const activeStalls = stalls.filter(
          (stall) => stall.at >= motionStart && stall.at < motionEnd,
        );
        const record = {
          profile,
          creditStalls: activeStalls.length,
          maxCreditAgeMs: Math.max(0, ...activeStalls.map((stall) => stall.ageMs)),
          revision,
          window: window === "1",
          coldPaintMs: cold.firstPaintMs,
          lateJoinPaintMs: joined.firstPaintMs,
          lateJoinBytes: joined.joinBytes,
          fps: active.length / ((motionEnd - motionStart) / 1000),
          frameGapP50Ms: percentile(gaps, 0.5),
          relayToPaintP50Ms: percentile(
            active.flatMap((p) => (p.relayAgeMs === null ? [] : [p.relayAgeMs])),
            0.5,
          ),
          relayToPaintP95Ms: percentile(
            active.flatMap((p) => (p.relayAgeMs === null ? [] : [p.relayAgeMs])),
            0.95,
          ),
          frameGapP95Ms: percentile(gaps, 0.95),
          maxFrameGapMs: Math.max(0, ...gaps),
          sequenceGaps: activeFrames
            .slice(1)
            .filter(
              (p, i) => p.frame.header.sequence !== activeFrames[i]!.frame.header.sequence + 1,
            ).length,
          steadyBytesPerSecond:
            activeFrames.reduce((sum, p) => sum + p.frame.payload.byteLength, 0) /
            ((motionEnd - motionStart) / 1000),
          idleBytesPerSecond,
          adbSwipeToNextPaintP50Ms: percentile(
            inputTimes.flatMap((time) => {
              const p = cold.paints.find((p) => p.at >= time);
              return p ? [p.at - time] : [];
            }),
            0.5,
          ),
          errors: [...cold.errors, ...joined.errors],
          painted: active.length,
        };
        if (record.errors.length > 0)
          throw new Error(`Viewer decode failed: ${record.errors.join("; ")}`);
        if (record.relayToPaintP50Ms === null || record.relayToPaintP95Ms === null)
          throw new Error("The relay observer did not timestamp painted frames");
        results.push(record);
        process.stdout.write(`${JSON.stringify(record)}\n`);
        await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
      } finally {
        for (const pool of pools) pool.dispose();
        await Promise.all(pages.map((page) => page.close()));
        await proxy.close();
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "computer.view.close",
            viewId: source.viewId,
            generation: source.generation,
            idempotencyKey: randomUUID(),
          },
          { headers: host.ownerHeaders },
        );
      }
      await delay(5_500); // End demand before measuring the next cold start.
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "Phone benchmark or cleanup failed");
});
