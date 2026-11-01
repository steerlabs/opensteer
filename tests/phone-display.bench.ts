/* oxlint-disable opensteer/no-real-time-wait-in-tests, opensteer/no-polling-loop-in-tests -- This opt-in benchmark uses fixed sampling/workload intervals to measure real-time delivery and idle traffic; no wait establishes readiness. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { build as bundle } from "esbuild";
import { chromium, type Page } from "playwright-core";
import WebSocket from "ws";
import { it, vi } from "vitest";
import { ComputerAppHub } from "../apps/host/src/computer-apps/computer-app-hub.js";
import { DisplayViewerBitrate } from "../apps/host/src/computer-use/display-viewer-bitrate.js";
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
    const idleDurationMs = Number(process.env.OPENSTEER_PHONE_BENCH_IDLE_MS ?? 3_000);
    if (!Number.isSafeInteger(idleDurationMs) || idleDurationMs < 1_000 || idleDurationMs > 300_000)
      throw new Error("Idle observation must be between 1000 and 300000 milliseconds");
    const bitrateSamples: unknown[] = [];
    const keyframeSamples: unknown[] = [];
    const controllers = new Map<DisplayViewerBitrate, number>();
    const controller = (rate: DisplayViewerBitrate) => {
      if (!controllers.has(rate)) controllers.set(rate, controllers.size);
      return controllers.get(rate)!;
    };
    if (process.env.OPENSTEER_PHONE_BENCH_TRACE === "1") {
      const send = ComputerAppHub.prototype.sendDisplay;
      vi.spyOn(ComputerAppHub.prototype, "sendDisplay").mockImplementation(function (
        this: ComputerAppHub,
        fence,
        message,
      ) {
        if (message.type === "host.integrations.display.refresh")
          keyframeSamples.push({ type: "refresh", at: performance.now() });
        return send.call(this, fence, message);
      });
      const ack = DisplayViewerBitrate.prototype.ack;
      const stall = DisplayViewerBitrate.prototype.stall;
      vi.spyOn(DisplayViewerBitrate.prototype, "ack").mockImplementation(function (
        this: DisplayViewerBitrate,
        now,
        bytes,
        delay,
        minimumDelay,
      ) {
        const before = this.cap;
        ack.call(this, now, bytes, delay, minimumDelay);
        bitrateSamples.push({
          controller: controller(this),
          now,
          bytes,
          delay,
          minimumDelay,
          before,
          cap: this.cap,
        });
      });
      vi.spyOn(DisplayViewerBitrate.prototype, "stall").mockImplementation(function (
        this: DisplayViewerBitrate,
        now,
        observedQueueMs = 0,
      ) {
        const before = this.cap;
        stall.call(this, now, observedQueueMs);
        bitrateSamples.push({
          controller: controller(this),
          now,
          observedQueueMs,
          stall: true,
          before,
          cap: this.cap,
        });
      });
    }
    const authority = await createTestCertificateAuthority(scratch);
    const build = await buildE2eAgentPhone({ authority, log: join(directory, "build.log") });
    process.stdout.write("Benchmark APK built\n");
    const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    cleanup.push(() => database.drop());
    let capEnabled = false;
    const displayStream = ComputerAppHub.prototype.displayStream;
    const capability = vi
      .spyOn(ComputerAppHub.prototype, "displayStream")
      .mockImplementation(function (this: ComputerAppHub, runnerId) {
        const live = displayStream.call(this, runnerId);
        if (capEnabled || !live || live === "unsupported") return live;
        const { displayProfile: _displayProfile, ...baseline } = live;
        return baseline;
      });
    cleanup.push(async () => capability.mockRestore());
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
        if (frame.header.key && process.env.OPENSTEER_PHONE_BENCH_TRACE === "1")
          keyframeSamples.push({
            type: "key",
            at: performance.now(),
            bytes: frame.payload.byteLength,
          });
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
    const decoderBundle = await bundle({
      entryPoints: [
        join(import.meta.dirname, "mobile-network/phone-display-decoder.test-support.ts"),
      ],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "PhoneDisplayBenchmark",
      platform: "browser",
    });
    const decoderScript = decoderBundle.outputFiles[0]!.text;
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
    const caps = (process.env.OPENSTEER_PHONE_BENCH_CAPS ?? "0").split(",");
    for (const { profile, window, cap } of profiles.flatMap((profile) =>
      windows.flatMap((window) => caps.map((cap) => ({ profile, window, cap }))),
    )) {
      if (!["0", "1"].includes(window)) throw new Error("Window must be 0 or 1");
      if (!["0", "1"].includes(cap)) throw new Error("Cap must be 0 or 1");
      capEnabled = cap === "1";
      const uptime = (await runCommand("uptime", [])).trim();
      const sampleStart = bitrateSamples.length;
      const keyframeSampleStart = keyframeSamples.length;
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
          const pendingCredit = new Map<number, DisplayFrame>();
          let packetId = 0;
          await page.exposeFunction("dequeued", (id: number) => {
            pendingCredit.get(id)?.done();
            pendingCredit.delete(id);
          });
          await page.addScriptTag({ content: decoderScript });
          await page.evaluate(() => {
            const sink = globalThis as unknown as {
              PhoneDisplayBenchmark: {
                benchmarkPhoneDecoder: (sink: unknown) => { accept: (packet: unknown) => void };
              };
              painted: (sequence: number) => void;
              dequeued: (id: number) => void;
              decodeFailed: (message: string) => void;
              accept: (packet: unknown) => void;
            };
            sink.accept = sink.PhoneDisplayBenchmark.benchmarkPhoneDecoder({
              painted: sink.painted,
              dequeued: sink.dequeued,
              failed: sink.decodeFailed,
            }).accept;
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
          const connectionStart = proxy.connections.length;
          const lease = pool.retain({ scope: profile, source });
          lease.onFrame((frame) => {
            received.push({ at: performance.now(), frame });
            const id = packetId++;
            pendingCredit.set(id, frame);
            const job = page
              .evaluate(
                (packet) =>
                  (globalThis as unknown as { accept: (packet: unknown) => void }).accept(packet),
                {
                  id,
                  connection: frame.connection,
                  header: frame.header,
                  data: Buffer.from(frame.payload).toString("base64"),
                  replayed: frame.replayed,
                },
              )
              .catch((error) => {
                recordError(String(error));
                pendingCredit.get(id)?.done();
                pendingCredit.delete(id);
              })
              .finally(() => {
                submissions.delete(job);
              });
            submissions.add(job);
          });
          await withTimeout(first, 30_000, {
            timeoutError: () =>
              new Error(`Headless viewer never painted a frame: ${errors.join("; ")}`),
          });
          const firstPaintMs = paints[0]!.at - started;
          const joinBytes = proxy.connections
            .slice(connectionStart)
            .reduce((sum, c) => sum + c.bytesDown + c.bytesUp, 0);
          return {
            received,
            paints,
            firstPaintMs,
            joinBytes,
            errors,
            lease,
            submissions,
            close: () => pool.dispose(),
            page,
          };
        };
        const cold = await viewer();
        const motionStart = performance.now();
        const inputTimes: number[] = [];
        // Each swipe is a real fixture gesture. Duration is workload, not a readiness wait.
        for (let turn = 0; turn < Number(process.env.OPENSTEER_PHONE_BENCH_SWIPES ?? 18); turn++) {
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
        const motionJoin = await viewer();
        await motionJoin.page.screenshot({
          fullPage: true,
          path: join(directory, `${profile}-${results.length}-motion.png`),
        });
        motionJoin.close();
        // Observe the fixed refinement tail separately from the static measurement.
        await delay(5_000);
        const idleStart = performance.now();
        const bytesAtIdle = proxy.connections.reduce((sum, c) => sum + c.bytesDown + c.bytesUp, 0);
        await delay(idleDurationMs);
        const idleEnd = performance.now();
        const idleSeconds = (idleEnd - idleStart) / 1000;
        const idleBytesPerSecond =
          (proxy.connections.reduce((sum, c) => sum + c.bytesDown + c.bytesUp, 0) - bytesAtIdle) /
          idleSeconds;
        const idleFrames = cold.received.filter(
          (frame) => frame.at >= idleStart && frame.at < idleEnd,
        );
        const idleKeyframes = idleFrames.filter((frame) => frame.frame.header.key);
        const idlePayloadBytesPerSecond =
          idleFrames.reduce((sum, frame) => sum + frame.frame.payload.byteLength, 0) / idleSeconds;
        const joined = await viewer();
        await joined.page.screenshot({
          fullPage: true,
          path: join(directory, `${profile}-${results.length}-static.png`),
        });
        const activeStalls = stalls.filter(
          (stall) => stall.at >= motionStart && stall.at < motionEnd,
        );
        const record = {
          profile,
          uptime,
          loadAverage: loadavg(),
          variant:
            process.env.OPENSTEER_PHONE_BENCH_CAPS === undefined
              ? (process.env.OPENSTEER_PHONE_BENCH_VARIANT ?? "default")
              : `cap${cap}`,
          cap: capEnabled,
          motionLateJoinPaintMs: motionJoin.firstPaintMs,
          motionLateJoinBytes: motionJoin.joinBytes,
          creditStalls: activeStalls.length,
          maxCreditAgeMs: Math.max(0, ...activeStalls.map((stall) => stall.ageMs)),
          revision,
          window: window === "1",
          coldPaintMs: cold.firstPaintMs,
          motionDurationMs: motionEnd - motionStart,
          motionStartedAt: new Date(performance.timeOrigin + motionStart).toISOString(),
          motionEndedAt: new Date(performance.timeOrigin + motionEnd).toISOString(),
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
          idlePayloadBytesPerSecond,
          idleDurationMs: idleEnd - idleStart,
          idleFrameCount: idleFrames.length,
          idleKeyframeCount: idleKeyframes.length,
          idleLastKeyframeOffsetMs: (idleKeyframes.at(-1)?.at ?? idleStart) - idleStart,
          // Include both observation edges so a paused capture cannot look cheap.
          idleMaxFrameGapMs: Math.max(
            idleEnd - (idleFrames.at(-1)?.at ?? idleStart),
            ...idleFrames.map(
              (frame, index) => frame.at - (idleFrames[index - 1]?.at ?? idleStart),
            ),
          ),
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
        if (process.env.OPENSTEER_PHONE_BENCH_TRACE === "1")
          await writeFile(
            join(directory, `${profile}-${results.length - 1}-keyframes.json`),
            JSON.stringify(keyframeSamples.slice(keyframeSampleStart)),
          );
        if (process.env.OPENSTEER_PHONE_BENCH_TRACE === "1")
          await writeFile(
            join(directory, `${profile}-${results.length - 1}-bitrate.json`),
            JSON.stringify(bitrateSamples.slice(sampleStart)),
          );
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
