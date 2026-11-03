import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import {
  browserVideoFixture,
  browserKeyFixture,
  browserDeltaFixture,
} from "../../apps/host/src/browser/browser-video.test-support.js";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { linkProfiles, startShapingProxy } from "../mobile-network/proxy.test-support.js";
import type { FixtureVideoPicture } from "./video-viewer.test-support.js";
import type { BrowserStreamOptions } from "./metrics.test-support.js";

/** Real AUs and production Host fan-out, WatchStore, WebCodecs and canvas. No encoder claims. */
export async function runBrowserVideoFixtureBenchmark(
  options: BrowserStreamOptions,
): Promise<void> {
  if (options.viewer !== "web")
    throw new Error(
      "Native browser-video acceptance requires the reserved VM/device journey; no web substitute is run.",
    );
  const profiles =
    options.profile === "all" ? (["lan", "4g", "weak-cell"] as const) : [options.profile];
  const bundle = await build({
    entryPoints: [new URL("./video-viewer.test-support.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
  });
  const browser = await chromium.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
  const samples: unknown[] = [];
  const errors: string[] = [];
  const failed = (error: unknown) =>
    errors.push(error instanceof Error ? error.message : String(error));
  try {
    for (const profile of profiles)
      for (let run = 1; run <= options.runs; run++) {
        const f = await browserVideoFixture(true);
        const cleanups: (() => Promise<unknown>)[] = [];
        try {
          const sourceProxy = await startShapingProxy(
            new URL(f.origin.replace("ws:", "http:")),
            linkProfiles[options.sourceProfile],
          );
          cleanups.push(() => sourceProxy.close());
          const pages = [];
          const proxies = [];
          for (let device = 0; device < options.devices; device++) {
            const admitted = await f.admit(device === 0);
            const server = createServer((_request, response) => {
              response.writeHead(200, { "content-type": "text/html" });
              response.end('<div style="width:128px;height:128px"><canvas></canvas></div>');
            });
            const controls = new WebSocketServer({ server, perMessageDeflate: false });
            controls.on("connection", (socket) => {
              socket.send(
                JSON.stringify({
                  type: "browser.snapshot",
                  sessionId: admitted.owner.target.sessionId,
                  state: "ready",
                  access: "read-write",
                  videoVersion: 1,
                  targetedStreamingVersion: 1,
                  dialog: null,
                  surfaces: [
                    { id: "tab", active: true, title: "H.264 fixture", url: "about:blank" },
                  ],
                }),
              );
              socket.on("message", (raw) => {
                const message = JSON.parse(String(raw));
                if (message.type === "video.subscribe")
                  for (const response of admitted.messages) socket.send(JSON.stringify(response));
              });
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address();
            if (!address || typeof address === "string")
              throw new Error("No fixture control listener");
            cleanups.push(async () => {
              for (const socket of controls.clients) socket.terminate();
              await new Promise<void>((resolve) => controls.close(() => resolve()));
              await closeHttpServerNow(server);
            });
            const proxy = await startShapingProxy(
              new URL(f.origin.replace("ws:", "http:")),
              linkProfiles[device === 0 ? profile : "weak-cell"],
            );
            proxies.push(proxy);
            cleanups.push(() => proxy.close());
            const page = await browser.newPage();
            pages.push(page);
            cleanups.push(() => page.close());
            await page.goto(`http://127.0.0.1:${address.port}`);
            await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
            await page.evaluate(
              async (input) => {
                const fixture = (
                  window as unknown as {
                    videoFixture: { start(input: unknown): void; ready(): Promise<void> };
                  }
                ).videoFixture;
                fixture.start(input);
                await fixture.ready();
              },
              {
                control: `ws://127.0.0.1:${address.port}`,
                media: proxy.origin.replace("http:", "ws:") + "/v1/browser/video",
                sessionId: admitted.owner.target.sessionId,
                surfaceId: "tab",
                mode: device === 0 ? "control" : "watch",
                decoder: options.decoder,
              },
            );
          }
          const source = await f.source(sourceProxy.origin.replace("http:", "ws:"));
          const started = performance.now();
          const harnessCpu = process.cpuUsage();
          const observations = [];
          // Key then final delta are real independent codec fixtures. They measure attach and final-still delivery.
          for (const sequence of [1, 2]) {
            const presented = pages.map((page) =>
              page.evaluate(
                (seq) =>
                  (
                    window as unknown as { videoFixture: { next(seq: number): Promise<void> } }
                  ).videoFixture.next(seq),
                sequence,
              ),
            );
            const acknowledged = once(source.socket, "message", {
              signal: AbortSignal.timeout(10000),
            });
            source.send(sequence);
            await acknowledged;
            await Promise.all(presented);
            observations.push({ sequence, elapsedMs: performance.now() - started });
          }
          const traces = await Promise.all(
            pages.map((page) =>
              page.evaluate(
                () =>
                  (window as unknown as { videoFixture: { pictures: FixtureVideoPicture[] } })
                    .videoFixture.pictures,
              ),
            ),
          );
          for (const trace of traces)
            for (const seq of [1, 2]) {
              const picture = trace.find((p) => p.sequence === seq);
              const pixel = picture?.pixel;
              if (
                !picture ||
                picture.certificate !== `certificate-${seq}` ||
                !pixel ||
                (seq === 1
                  ? !(pixel[1]! > 180 && pixel[0]! < 40 && pixel[2]! < 40)
                  : !(pixel[2]! > 200 && pixel[0]! < 40 && pixel[1]! < 40))
              )
                throw new Error(`Decoded marker does not match the presented certificate ${seq}.`);
            }
          samples.push({
            status: "passed",
            harnessCpuUs: process.cpuUsage(harnessCpu),
            producerCpuUs: null,
            viewerCpuUs: null,
            retainedEncodedBytes: null,
            inputOutcomes: null,
            sourcePictureAgeMs: null,
            configuredBudget: f.start().budget,
            nominalFps: 15,
            profile,
            sourceProfile: options.sourceProfile,
            run,
            devices: options.devices,
            backend: "fixture",
            width: 128,
            height: 128,
            keyBytes: browserKeyFixture.length,
            deltaBytes: browserDeltaFixture.length,
            observations,
            traces,
            source: sourceProxy.connections,
            viewers: proxies.map((proxy) => proxy.connections),
          });
        } catch (error) {
          failed(error);
          samples.push({
            profile,
            sourceProfile: options.sourceProfile,
            run,
            devices: options.devices,
            status: "failed",
            error: errors.at(-1),
          });
        } finally {
          for (const close of cleanups.reverse())
            try {
              await close();
            } catch (error) {
              failed(error);
            }
          try {
            await f.close();
          } catch (error) {
            failed(error);
          }
        }
      }
  } catch (error) {
    failed(error);
  } finally {
    try {
      await browser.close();
    } catch (error) {
      failed(error);
    }
  }
  await writeFile(
    options.out,
    JSON.stringify(
      {
        version: 1,
        status: errors.length ? "failed" : "passed",
        errors,
        producer: "fixture-h264",
        viewer: "web",
        decoder: options.decoder,
        limits:
          "Synthetic certificates and pre-encoded AUs; production Host media fan-out/WatchStore/WebCodecs/canvas. No native guard, encoder CPU/rate, page-input causality, physical scanout, TLS/radio/loss or Connect claim. The existing JPEG benchmark retains those page workloads. Attach is included; each viewer uses its own socket and credit.",
        samples,
      },
      null,
      2,
    ) + "\n",
  );
  if (errors.length)
    throw new Error(
      `Browser video benchmark failed; evidence saved to ${options.out}: ${errors[0]}`,
    );
}
