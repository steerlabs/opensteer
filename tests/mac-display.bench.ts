/* oxlint-disable opensteer/no-real-time-wait-in-tests, opensteer/no-polling-loop-in-tests -- Opt-in real-time benchmark: cadence and fixed observation intervals are workload, not readiness waits. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir, arch, release, loadavg } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { it, vi } from "vitest";
import { z } from "zod";
import {
  DisplayStreams,
  type DisplayFrame,
  type DisplayLease,
} from "../packages/client/src/integrations/phone-display-stream.js";
import type { WebSocketClient } from "../packages/client/src/host/host-session-client.js";
import {
  DisplayAckSchema,
  decodeDisplayViewerFrame,
  encodeDisplayMediaFrame,
  type HostIntegrationsDisplayStart,
  type DisplayClientDiagnostic,
} from "../packages/protocol/src/index.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { delay } from "@opensteer/shared/delay";
import { linkProfiles, startShapingProxy } from "./mobile-network/proxy.test-support.js";
import { macHub } from "../apps/host/src/computer-use/mac-display-bench.test-support.js";
import {
  liveEncoder,
  liveEncoderBinary,
  type EncoderRecord,
} from "./mac-display/live-encoder.test-support.js";

function percentile(values: number[], fraction: number) {
  return (
    values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null
  );
}
const scenarioSchema = z.enum(["lan", "4g", "weak-cell", "edge", "handover", "mixed"]);
const deadline = <T>(promise: Promise<T>, message: string) =>
  withTimeout(promise, 15_000, { timeoutError: () => new Error(message) });

it("benchmarks synthetic Mac video through the real Host and shared WebCodecs viewer", async () => {
  if (process.platform !== "darwin") throw new Error("Requires macOS VideoToolbox");
  const directory =
    process.env.OPENSTEER_MAC_BENCH_OUT ??
    (await mkdtemp(join(tmpdir(), "opensteer-mac-display-")));
  await mkdir(directory, { recursive: true });
  const duration = Number(process.env.OPENSTEER_MAC_BENCH_DURATION ?? 20);
  if (!Number.isSafeInteger(duration) || duration < 4 || duration > 120)
    throw new Error("Duration must be 4..120 seconds");
  const fpsValues = (process.env.OPENSTEER_MAC_BENCH_FPS ?? "30,60")
    .split(",")
    .map((v) => z.union([z.literal(30), z.literal(60)]).parse(Number(v)));
  const scenarios = (
    process.env.OPENSTEER_MAC_BENCH_SCENARIO ?? "lan,4g,weak-cell,edge,handover,mixed"
  )
    .split(",")
    .map((s) => scenarioSchema.parse(s));
  const bundle = await build({
    entryPoints: [
      join(import.meta.dirname, "../apps/web/src/components/phone-display-decoder.test-support.ts"),
    ],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "PhoneDisplayBenchmark",
    platform: "browser",
  });
  const encoderBuild = await liveEncoderBinary(directory);
  const browser = await chromium.launch({ headless: true });
  const results = [];
  await writeFile(
    join(directory, "environment.json"),
    JSON.stringify(
      {
        revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        recordedAt: new Date().toISOString(),
        node: process.version,
        architecture: arch(),
        macOS: release(),
        loadAverage: loadavg(),
        fpsValues,
        scenarios,
        duration,
        legacyHost: process.env.OPENSTEER_MAC_BENCH_LEGACY === "1",
        note: "Live production VideoToolbox encoder; offscreen deterministic content; paint means headless canvas draw, not physical presentation.",
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Mac display benchmark: ${directory}\n`);
  try {
    for (const fps of fpsValues) {
      for (const scenario of scenarios) {
        const cleanup: (() => Promise<unknown>)[] = [];
        const captures = new Map<number, number>();
        const demands: { atMs: number; maxBitrate: number | null; maxLongSide: number }[] = [];
        let keyframes = 0,
          refreshes = 0,
          producerAcks = 0,
          producerCreditStalls = 0;
        const outstanding = new Map<number, { bytes: number; at: number }>();
        let needsKey = false;
        let start: HostIntegrationsDisplayStart | undefined;
        let producer: WebSocket | undefined;
        let sequence = 0;
        let origin = performance.now();
        let stopped = false;
        let encoder: ReturnType<typeof liveEncoder> | undefined;
        const emitted: { at: number; bytes: number }[] = [];
        const drops: number[] = [];
        const errors: string[] = [];
        const send = (frame: EncoderRecord, payload: Buffer) => {
          if ("clock" in frame) {
            origin = performance.now() - frame.clock / 1000;
            return;
          }
          if ("drop" in frame) {
            drops.push(performance.now());
            return;
          }
          emitted.push({ at: performance.now(), bytes: payload.length });
          if (!start || producer?.readyState !== WebSocket.OPEN || stopped) return;
          const held = [...outstanding.values()];
          // As the producer's credit: an empty lane takes any legal frame, so a
          // large key is never refused into an endless request for another.
          if (
            (held.length > 0 &&
              held.reduce((sum, f) => sum + f.bytes, 0) + payload.length > 1_048_576) ||
            (held[0] && performance.now() - held[0].at >= 500)
          ) {
            producerCreditStalls++;
            needsKey = true;
            return;
          }
          if (needsKey && !frame.key) {
            encoder?.command({ refresh: true });
            return;
          }
          needsKey = false;
          outstanding.set(sequence, { bytes: payload.length, at: performance.now() });
          captures.set(sequence, origin + frame.captureUs / 1000);
          if (frame.key) keyframes++;
          producer.send(
            encodeDisplayMediaFrame(
              {
                streamId: start.streamId,
                generation: 1,
                sequence: sequence++,
                ptsUs: Math.round(frame.ptsUs),
                key: frame.key,
                ...(frame.key ? { codec: frame.codec } : {}),
                width: frame.width,
                height: frame.height,
              },
              payload,
            ),
          );
        };
        const host = await macHub(
          (message) => {
            if (process.env.OPENSTEER_MAC_BENCH_TRACE) console.log(message.type);
            if (message.type === "host.integrations.display.start") {
              start = message;
              stopped = false;
              outstanding.clear();
              demands.push({
                atMs: 0,
                maxBitrate: message.maxBitrate ?? null,
                maxLongSide: message.maxLongSide,
              });
              const url = new URL("/internal/v1/computer-use/display", host.origin);
              url.protocol = "ws:";
              producer = new WebSocket(url, {
                headers: { authorization: `Bearer ${message.dataTicket}` },
              });
              host.sockets.push(producer);
              producer.on("error", (e) => errors.push(String(e)));
              producer.on("message", (raw) => {
                const ack = DisplayAckSchema.parse(JSON.parse(raw.toString()));
                const sent = outstanding.get(ack.sequence);
                if (sent) encoder?.command({ ack: { delayMs: performance.now() - sent.at } });
                outstanding.delete(ack.sequence);
                producerAcks++;
              });
              producer.once("open", () => {
                void host.state(message.streamId).catch((e) => errors.push(String(e)));
                encoder = liveEncoder(encoderBuild.binary, duration, send, (e) => errors.push(e));
                cleanup.push(encoder.close);
                encoder.command({
                  start: {
                    maxFps: fps,
                    maxLongSide: message.maxLongSide,
                    ...("maxBitrate" in message ? { maxBitrate: message.maxBitrate } : {}),
                  },
                });
              });
            } else if (message.type === "host.integrations.display.refresh") {
              refreshes++;
              encoder?.command({ refresh: true });
            } else if (message.type === "host.integrations.display.demand") {
              demands.push({
                atMs: performance.now() - origin,
                maxBitrate: message.maxBitrate ?? null,
                maxLongSide: message.maxLongSide ?? 1512,
              });
              if ("maxBitrate" in message) encoder?.command({ cap: message.maxBitrate });
              if (message.maxLongSide !== undefined)
                encoder?.command({ resize: message.maxLongSide });
            } else if (
              message.type === "host.integrations.display.stop" &&
              message.streamId === start?.streamId
            ) {
              stopped = true;
              encoder?.command({ stop: true });
              producer?.terminate();
            }
          },
          { legacy: process.env.OPENSTEER_MAC_BENCH_LEGACY === "1" },
        );
        cleanup.push(host.close);
        const ackSamples = new Map<string, { at: number; delay: number }[]>();
        const attach = host.hub.attachViewer.bind(host.hub);
        vi.spyOn(host.hub, "attachViewer").mockImplementation((source, actor, socket, options) => {
          const outstanding = new Map<number, number>();
          const label = host.actorLabels.get(actor)!;
          const samples = ackSamples.get(label) ?? [];
          ackSamples.set(label, samples);
          const sendFrame = socket.send.bind(socket);
          vi.spyOn(socket, "send").mockImplementation((data, ...args) => {
            if (data instanceof Uint8Array) {
              const { header } = decodeDisplayViewerFrame(data);
              outstanding.set(header.sequence, performance.now());
            }
            sendFrame(data, ...args);
          });
          socket.on("message", (raw, binary) => {
            if (binary) return;
            const ack = DisplayAckSchema.safeParse(JSON.parse(raw.toString()));
            if (!ack.success) return;
            const at = outstanding.get(ack.data.sequence);
            if (at !== undefined)
              samples.push({ at: performance.now(), delay: performance.now() - at });
            for (const seq of outstanding.keys())
              if (seq <= ack.data.sequence) outstanding.delete(seq);
          });
          return attach(source, actor, socket, options);
        });
        const failures: unknown[] = [];
        try {
          const viewers = [];
          for (const profile of scenario === "mixed"
            ? (["lan", "weak-cell"] as const)
            : [scenario === "handover" ? "weak-cell" : scenario]) {
            const link = linkProfiles[profile];
            const proxy = await startShapingProxy(
              new URL(host.origin),
              scenario === "handover"
                ? { ...link, stall: { everyChunks: 20, delayMs: 2000, once: true } }
                : link,
            );
            cleanup.push(() => deadline(proxy.close(), "Shaping proxy did not close"));
            const page = await browser.newPage();
            page.on("pageerror", (error) => errors.push(String(error)));
            await page.route("http://127.0.0.1/", (route) =>
              route.fulfill({
                body: "<!doctype html><html><body></body></html>",
                contentType: "text/html",
              }),
            );
            await page.goto("http://127.0.0.1/");
            cleanup.push(() => deadline(page.close(), "Headless viewer did not close"));
            const paints: { at: number; sequence: number; ageMs: number }[] = [];
            const received: { at: number; key: boolean }[] = [];
            const transitions: { atMs: number; record: DisplayClientDiagnostic }[] = [];
            const pending = new Map<number, DisplayFrame>();
            let viewerLease: DisplayLease | undefined;
            const decoderLosses: number[] = [];
            await page.exposeFunction("decoderLost", () => {
              decoderLosses.push(performance.now());
              viewerLease?.requestKeyframe();
            });
            const submissions = new Set<Promise<unknown>>();
            let packet = 0;
            let painted!: () => void;
            const first = new Promise<void>((resolve) => {
              painted = resolve;
            });
            await page.exposeFunction("painted", (seq: number) => {
              const capture = captures.get(seq);
              if (capture === undefined) {
                errors.push(`Missing capture timestamp ${seq}`);
                return;
              }
              paints.push({
                at: performance.now(),
                sequence: seq,
                ageMs: performance.now() - capture,
              });
              painted();
            });
            await page.exposeFunction("dequeued", (id: number) => {
              pending.get(id)?.done();
              pending.delete(id);
            });
            await page.exposeFunction("decodeFailed", (message: string) => errors.push(message));
            await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
            await page.evaluate(() => {
              const bridge = globalThis as unknown as {
                PhoneDisplayBenchmark: {
                  benchmarkPhoneDecoder: (sink: unknown) => { accept: (packet: unknown) => void };
                };
                painted: unknown;
                dequeued: unknown;
                decodeFailed: unknown;
                decoderLost: unknown;
                accept: (packet: unknown) => void;
              };
              bridge.accept = bridge.PhoneDisplayBenchmark.benchmarkPhoneDecoder({
                painted: bridge.painted,
                dequeued: bridge.dequeued,
                failed: bridge.decodeFailed,
                lost: bridge.decoderLost,
              }).accept;
            });
            const pool = new DisplayStreams({
              diagnostic: (record) =>
                transitions.push({ atMs: performance.now() - origin, record }),
              connect: (ref) => {
                if (ref.kind !== "owner-view") throw new Error("Expected Mac owner view");
                const socket = new WebSocket(
                  `${proxy.origin.replace("http:", "ws:")}/v1/computer-use/views/${ref.viewId}/${ref.generation}/display?displayWindow=1`,
                  { headers: { authorization: `Bearer ${profile}` } },
                );
                host.sockets.push(socket);
                if (process.env.OPENSTEER_MAC_BENCH_TRACE) {
                  socket.on("close", (code, reason) =>
                    console.log("viewer closed", code, reason.toString()),
                  );
                  socket.on("message", (raw, binary) => {
                    if (!binary) console.log("viewer state", raw.toString());
                  });
                }
                socket.on("error", (e) => errors.push(String(e)));
                return socket as unknown as WebSocketClient;
              },
            });
            cleanup.push(async () => {
              pool.dispose();
              await deadline(Promise.all(submissions), "Viewer submissions did not drain");
            });
            const lease = pool.retain({ scope: profile, source: host.source });
            viewerLease = lease;
            lease.onFrame((frame) => {
              received.push({ at: performance.now(), key: frame.header.key });
              const id = packet++;
              pending.set(id, frame);
              const job = page
                .evaluate(
                  (data) =>
                    (globalThis as unknown as { accept: (packet: unknown) => void }).accept(data),
                  {
                    id,
                    connection: frame.connection,
                    header: frame.header,
                    replayed: frame.replayed,
                    data: Buffer.from(frame.payload).toString("base64"),
                  },
                )
                .catch((e) => {
                  console.log("submit", String(e));
                  errors.push(String(e));
                })
                .finally(() => submissions.delete(job));
              submissions.add(job);
            });
            viewers.push({ profile, paints, received, proxy, first, transitions, decoderLosses });
          }
          await withTimeout(Promise.all(viewers.map((v) => v.first)), 15_000, {
            timeoutError: () =>
              new Error(
                `No first paint in ${scenario}: ${JSON.stringify({ errors, emitted: emitted.length, keyframes, producerAcks, producerCreditStalls })}`,
              ),
          });
          const begin = performance.now();
          const byteStarts = viewers.map((v) =>
            v.proxy.connections.reduce((sum, c) => sum + c.bytesDown + c.bytesUp, 0),
          );
          await delay(duration * 1000);
          const end = performance.now();
          for (const [viewerIndex, viewer] of viewers.entries()) {
            const paints = viewer.paints.filter((p) => p.at >= begin && p.at < end);
            const gaps = [
              ...paints.map((p, i) => p.at - (paints[i - 1]?.at ?? begin)),
              end - (paints.at(-1)?.at ?? begin),
            ];
            const ages = paints.map((p) => p.ageMs);
            const seconds = (end - begin) / 1000;
            const ack = (ackSamples.get(`Bearer ${viewer.profile}`) ?? [])
              .filter((s) => s.at >= begin && s.at < end)
              .map((s) => s.delay);
            const capIntervals = demands
              .map((d, i) => ({
                cap: d.maxBitrate,
                seconds:
                  Math.max(
                    0,
                    Math.min(end - origin, demands[i + 1]?.atMs ?? end - origin) -
                      Math.max(begin - origin, d.atMs),
                  ) / 1000,
              }))
              .filter((d) => d.cap !== null && d.seconds > 0);
            const cappedSeconds = capIntervals.reduce((n, d) => n + d.seconds, 0);
            const meanHostCap = cappedSeconds
              ? capIntervals.reduce((n, d) => n + d.cap! * d.seconds, 0) / cappedSeconds
              : null;
            results.push({
              scenario,
              profile: viewer.profile,
              fps,
              contentHash: encoderBuild.hash,
              encoderMode: process.env.OPENSTEER_MAC_BENCH_LEGACY === "1" ? "legacy" : "negotiated",
              encoderFps: emitted.filter((f) => f.at >= begin && f.at < end).length / seconds,
              encoderDrops: drops.filter((at) => at >= begin && at < end).length,
              emittedBitrate:
                emitted
                  .filter((f) => f.at >= begin && f.at < end)
                  .reduce((n, f) => n + f.bytes * 8, 0) / seconds,
              bitrateTrace: Array.from({ length: Math.ceil(seconds) }, (_, i) => {
                const at = begin + i * 1000;
                const until = Math.min(end, at + 1000);
                return {
                  atMs: at - origin,
                  emittedBitrate:
                    emitted
                      .filter((f) => f.at >= at && f.at < until)
                      .reduce((n, f) => n + f.bytes * 8, 0) /
                    ((until - at) / 1000),
                  hostCap: demands.findLast((d) => d.atMs <= at - origin)?.maxBitrate ?? null,
                };
              }),
              durationSeconds: seconds,
              observationStartMs: begin - origin,
              meanHostCap,
              cappedSeconds,
              paintedFps: paints.length / seconds,
              deliveredFps:
                viewer.received.filter((t) => t.at >= begin && t.at < end).length / seconds,
              gapP50Ms: percentile(gaps, 0.5),
              gapP95Ms: percentile(gaps, 0.95),
              gapMaxMs: Math.max(...gaps),
              ageP50Ms: percentile(ages, 0.5),
              ageP95Ms: percentile(ages, 0.95),
              ageP99Ms: percentile(ages, 0.99),
              freezes250: {
                count: gaps.filter((g) => g > 250).length,
                totalMs: gaps.filter((g) => g > 250).reduce((a, b) => a + b, 0),
              },
              freezes1000: {
                count: gaps.filter((g) => g > 1000).length,
                totalMs: gaps.filter((g) => g > 1000).reduce((a, b) => a + b, 0),
              },
              bytesPerSecond:
                (viewer.proxy.connections.reduce((sum, c) => sum + c.bytesDown + c.bytesUp, 0) -
                  byteStarts[viewerIndex]!) /
                seconds,
              ackP50Ms: percentile(ack, 0.5),
              ackP95Ms: percentile(ack, 0.95),
              keyframesSent: keyframes,
              refreshRequests: refreshes,
              producerAcks,
              producerCreditStalls,
              viewerKeyframes: viewer.received.filter((f) => f.at >= begin && f.at < end && f.key)
                .length,
              viewerCreditStalls: viewer.transitions.filter(
                (t) => t.record.socketReason === "Display viewer stalled",
              ).length,
              recoveryTrace: viewer.transitions,
              decoderLosses: viewer.decoderLosses.filter((at) => at >= begin && at < end).length,
              demandTrace: demands,
              errors,
            });
          }
          await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
          process.stdout.write(
            "scenario viewer input painted gap95 age50 age95 freezes bitrate capMean encoderFps drops refresh\n",
          );
          for (const r of results.filter((r) => r.scenario === scenario && r.fps === fps)) {
            process.stdout.write(
              `${r.scenario} ${r.profile} ${r.fps} ${r.paintedFps.toFixed(1)} ${r.gapP95Ms?.toFixed(0)} ${r.ageP50Ms?.toFixed(0)} ${r.ageP95Ms?.toFixed(0)} ${r.freezes1000.count} ${Math.round(r.emittedBitrate)} ${r.meanHostCap === null ? "uncapped" : Math.round(r.meanHostCap)} ${r.encoderFps.toFixed(1)} ${r.encoderDrops} ${r.refreshRequests}\n`,
            );
          }
          if (errors.length) throw new Error(`Benchmark viewer errors: ${errors.join(";")}`);
        } catch (error) {
          failures.push(error);
        } finally {
          stopped = true;

          for (const close of cleanup.reverse()) {
            try {
              await close();
            } catch (error) {
              failures.push(error);
            }
          }
          vi.restoreAllMocks();
        }
        if (failures.length) throw new AggregateError(failures, "Mac benchmark or cleanup failed");
      }
    }
  } finally {
    await deadline(browser.close(), "Headless Chromium did not close");
  }
});
