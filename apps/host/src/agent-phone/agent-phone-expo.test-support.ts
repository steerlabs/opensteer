import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { ComputerUseSessionIdSchema } from "@opensteer/protocol";
import { delay } from "@opensteer/shared/delay";
import { expect } from "vitest";
import { z } from "zod";
import {
  acquireAndroidDevice,
  eventually,
  agentPhoneActivities,
  fixtureActivities,
  tapView,
  repositoryRoot,
  runCommand,
  type AndroidDevice,
  type AgentPhoneHost,
} from "./agent-phone-device.test-support.js";
import { ComputerDisplayViewer, type ReceivedFrame } from "./agent-phone-display.test-support.js";

const Event = z.object({
  type: z.string(),
  platform: z.enum(["ios", "android"]),
  at: z.number(),
  details: z.unknown(),
});
const Manifest = z.looseObject({ launchAsset: z.looseObject({ url: z.url() }) });

/** Real Expo surfaces, the shared Host client, and the same physical H.264 producer. */
export async function runExpoPhoneDisplayJourney(options: {
  host: AgentPhoneHost;
  phone: AndroidDevice;
  directory: string;
  task: (platform: "ios" | "android") => Promise<{
    sessionId: string;
    machineId: string;
    revoke: () => Promise<void>;
    finish: () => Promise<void>;
  }>;
}) {
  const directory = join(options.directory, "expo");
  await mkdir(directory, { recursive: true });
  const events: z.infer<typeof Event>[] = [];
  const cleanupFailures: string[] = [];
  const savedBundles = new Set<string>();
  let current: Awaited<ReturnType<typeof options.task>> | null = null;
  let stage: "tile" | "full" | "closed" = "tile";
  let revision = 0;
  let epoch = hostApiVersion;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1:18766");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/configuration") {
        if (!current) throw new Error("No Expo task");
        const origin = new URL(options.host.origin);
        if (url.searchParams.get("platform") === "android") origin.hostname = "10.0.2.2";
        response.end(
          JSON.stringify({
            origin: origin.origin,
            headers: {
              ...options.host.ownerHeaders,
              host: new URL(options.host.publicOrigin).host,
            },
            sessionId: current.sessionId,
            machineId: current.machineId,
          }),
        );
      } else if (url.pathname === "/control")
        response.end(JSON.stringify({ stage, revision, epoch }));
      else if (url.pathname === "/event") {
        let body = "";
        for await (const part of request) {
          body += String(part);
          if (body.length > 6 * 1_048_576) throw new Error("Oversized Expo event");
        }
        const entry = Event.parse(JSON.parse(body));
        events.push(entry);
        const media = z
          .object({
            header: z.object({
              generation: z.number().int().nonnegative(),
              sequence: z.number().int().nonnegative(),
            }),
            payload: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/u)
              .max(5_592_408),
          })
          .safeParse(entry.details);
        if (entry.type === "frame" && media.success)
          await writeFile(
            join(
              directory,
              `${entry.platform}-${events.length}-generation-${media.data.header.generation}-sequence-${media.data.header.sequence}.h264`,
            ),
            Buffer.from(media.data.payload, "base64url"),
          );
        response.end("{}");
      } else {
        const platform = request.headers["expo-platform"] === "android" ? "android" : "ios";
        const result = await fetch(`http://127.0.0.1:18767/?platform=${platform}`, {
          headers: {
            accept: "application/expo+json",
            "expo-platform": platform,
            "expo-protocol-version": "1",
          },
        });
        const manifest = Manifest.parse(await result.json());
        const bundle = new URL(manifest.launchAsset.url);
        bundle.pathname = "/apps/mobile/test-support/phone-display-journey.tsx.bundle";
        bundle.hostname = platform === "android" ? "10.0.2.2" : "127.0.0.1";
        manifest.launchAsset.url = bundle.toString();
        if (!savedBundles.has(platform)) {
          const local = new URL(bundle);
          local.hostname = "127.0.0.1";
          const compiled = await fetch(local);
          if (!compiled.ok) throw new Error(`Metro ${platform} bundle failed: ${compiled.status}`);
          await writeFile(
            join(directory, `${platform}.bundle.js`),
            Buffer.from(await compiled.arrayBuffer()),
          );
          savedBundles.add(platform);
        }
        response.setHeader("content-type", "application/expo+json");
        response.setHeader("expo-protocol-version", "1");
        response.end(JSON.stringify(manifest));
      }
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(18766, "127.0.0.1", resolve);
  });
  const fd = openSync(join(directory, "metro.log"), "a");
  const metro: ChildProcess = spawn(
    "pnpm",
    ["exec", "expo", "start", "--dev-client", "--port", "18767", "--max-workers", "2", "--lan"],
    {
      cwd: join(repositoryRoot, "apps/mobile"),
      env: { ...process.env, NODE_ENV: "development", CI: "1", EXPO_NO_DOTENV: "1" },
      detached: true,
      stdio: ["ignore", fd, fd],
    },
  );
  closeSync(fd);
  async function colours(path: string) {
    const pixels = await runCommand(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-vf",
        // The development client's floating Tools button covers the right edge.
        // Keep both fixture colour blocks in the analysis, and save the full screenshot.
        "scale=360:800,crop=288:800:0:0",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { output: "buffer" },
    );
    let blue = 0;
    let green = 0;
    const blueRows = new Map<number, { left: number; right: number; count: number }>();
    for (let index = 0; index < pixels.length; index += 3) {
      const r = pixels[index]!;
      const g = pixels[index + 1]!;
      const b = pixels[index + 2]!;
      if (b > r + 20 && b > g + 10 && r > 80) {
        blue++;
        const pixel = index / 3;
        const x = pixel % 288;
        const y = Math.floor(pixel / 288);
        const row = blueRows.get(y) ?? { left: x, right: x, count: 0 };
        row.left = Math.min(row.left, x);
        row.right = Math.max(row.right, x);
        row.count++;
        blueRows.set(y, row);
      }
      if (g > r + 10 && g > b + 5 && r > 80) green++;
    }
    const size = z
      .object({ streams: z.array(z.object({ width: z.number(), height: z.number() })).min(1) })
      .parse(
        JSON.parse(
          await runCommand("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path]),
        ),
      ).streams[0]!;
    // A few colour-fringed status-bar pixels are not part of the fixture block.
    const widest = Math.max(0, ...[...blueRows.values()].map((row) => row.count));
    const block = [...blueRows.entries()].filter(([, row]) => row.count >= widest / 2);
    const left = Math.min(...block.map(([, row]) => row.left));
    const right = Math.max(...block.map(([, row]) => row.right));
    const top = Math.min(...block.map(([y]) => y));
    const bottom = Math.max(...block.map(([y]) => y));
    return {
      blue,
      green,
      blueAspect:
        blue > 0
          ? (((right - left + 1) / (bottom - top + 1)) * (size.width / 360)) / (size.height / 800)
          : null,
    };
  }
  try {
    await eventually(
      "Metro ready",
      async () => ((await fetch("http://127.0.0.1:18767/status")).ok ? true : undefined),
      120_000,
    );
    for (const platform of ["ios", "android"] as const) {
      stage = "tile";
      epoch = hostApiVersion;
      revision++;
      const cursor = events.length;
      let android: AndroidDevice | null = null;
      let startedIos = false;
      const udid = process.env.OPENSTEER_EXPO_IOS_SIMULATOR;
      if (!udid)
        throw new Error("Set OPENSTEER_EXPO_IOS_SIMULATOR to an explicit iPhone simulator UDID.");
      let launch: () => Promise<void>;
      let shot: (path: string) => Promise<void>;
      let background: () => Promise<void>;
      let foreground: () => Promise<void>;
      let terminate: () => Promise<void>;
      try {
        if (platform === "ios") {
          const inventory = z
            .object({
              devices: z.record(
                z.string(),
                z.array(z.object({ udid: z.string(), state: z.string() })),
              ),
            })
            .parse(
              JSON.parse(
                await runCommand("xcrun", ["simctl", "list", "devices", "available", "--json"]),
              ),
            );
          const simulator = Object.values(inventory.devices)
            .flat()
            .find((device) => device.udid === udid);
          if (!simulator) throw new Error(`Missing iOS simulator ${udid}`);
          if (simulator.state !== "Booted") {
            await runCommand("xcrun", ["simctl", "boot", udid]);
            startedIos = true;
          }
          await runCommand("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs: 300_000 });
          const app = process.env.OPENSTEER_EXPO_IOS_APP;
          if (!app) throw new Error("Set OPENSTEER_EXPO_IOS_APP to the matching simulator build.");
          await runCommand("xcrun", ["simctl", "install", udid, app], { timeoutMs: 120_000 });
          launch = async () => {
            await runCommand("xcrun", [
              "simctl",
              "openurl",
              udid,
              `com.opensteer.mobile://expo-development-client/?url=${encodeURIComponent("http://127.0.0.1:18766")}`,
            ]);
          };
          shot = async (path) => {
            await runCommand("xcrun", ["simctl", "io", udid, "screenshot", path]);
          };
          background = async () => {
            await runCommand("xcrun", ["simctl", "launch", udid, "com.apple.Preferences"]);
          };
          foreground = async () => {
            await runCommand("xcrun", ["simctl", "launch", udid, "com.opensteer.mobile"]);
          };
          terminate = async () => {
            await runCommand("xcrun", ["simctl", "terminate", udid, "com.opensteer.mobile"]);
          };
        } else {
          // A second emulator is required: showing the viewer on the producer would capture itself.
          android = await acquireAndroidDevice({
            api: 33,
            emulatorLog: join(directory, "viewer-emulator.log"),
          });
          const device = android;
          await device.adb(
            [
              "install",
              "-r",
              process.env.OPENSTEER_EXPO_ANDROID_APK ??
                join(
                  repositoryRoot,
                  "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
                ),
            ],
            { timeoutMs: 120_000 },
          );
          launch = async () => {
            await device.shell(
              `am start -W -a android.intent.action.VIEW -d 'com.opensteer.mobile://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A18766' com.opensteer.mobile`,
            );
          };
          shot = async (path) => {
            await writeFile(path, await device.screencap());
          };
          background = async () => {
            await device.shell("input keyevent KEYCODE_HOME");
          };
          foreground = async () => {
            await device.shell("am start -W -n com.opensteer.mobile/.MainActivity");
          };
          terminate = async () => {
            await device.shell("am force-stop com.opensteer.mobile");
          };
          await writeFile(join(directory, "android-viewer-serial.txt"), `${device.serial}\n`);
        }
        current = await options.task(platform);
        await launch();
        async function visible(name: string) {
          const path = join(directory, `${platform}-${name}.png`);
          return eventually(
            `Expo ${platform} ${name} decoded fixture colours`,
            async () => {
              expect(
                events
                  .slice(cursor)
                  .filter((entry) => entry.type === "error" || entry.type === "forbidden-capture"),
              ).toEqual([]);
              await shot(path);
              const pixels = await colours(path);
              return pixels.blue > 500 && pixels.green > 500 ? pixels : undefined;
            },
            120_000,
            1_000,
          );
        }
        async function cleared(name: string) {
          await delay(1_000);
          const path = join(directory, `${platform}-${name}.png`);
          await shot(path);
          expect(await colours(path)).toMatchObject({ blue: 0, green: 0 });
        }
        async function verifyAspect(name: string, picture: Awaited<ReturnType<typeof colours>>) {
          const observer = new ComputerDisplayViewer(options.host, {
            kind: "task-session",
            sessionId: ComputerUseSessionIdSchema.parse(current?.sessionId),
          });
          const input = join(directory, `${platform}-${name}-reference.h264`);
          const output = join(directory, `${platform}-${name}-reference.png`);
          let frames: readonly ReceivedFrame[];
          try {
            await observer.wait("reference first frame", () => observer.trace.frames[0]);
            await delay(510);
            const frameCursor = observer.trace.frames.length;
            const stateCursor = observer.trace.events.length;
            observer.send({ type: "display.keyframe" });
            frames = await observer.wait("reference replay through current picture", () => {
              const reset = observer.trace.events
                .slice(stateCursor)
                .findLast(
                  (entry) =>
                    entry.kind === "message" &&
                    entry.message.type === "display.state" &&
                    entry.message.replayThrough !== undefined,
                );
              if (reset?.kind !== "message" || reset.message.type !== "display.state")
                return undefined;
              const through = reset.message.replayThrough;
              const pictures = observer.trace.frames.slice(frameCursor);
              const first = pictures.findIndex((frame) => frame.header.key);
              const last = pictures.findIndex(
                (frame, index) => index >= first && frame.header.sequence === through,
              );
              return first >= 0 && last >= first ? pictures.slice(first, last + 1) : undefined;
            });
          } finally {
            await observer.close();
          }
          // Rotation's first keyframe can contain Android's transition animation.
          // Decode through replayThrough, rather than comparing that old keyframe.
          await writeFile(input, Buffer.concat(frames.map((frame) => frame.payload)));
          await runCommand("ffmpeg", [
            "-v",
            "error",
            "-y",
            "-i",
            input,
            "-vf",
            `select=eq(n\\,${frames.length - 1})`,
            "-frames:v",
            "1",
            output,
          ]);
          const reference = await colours(output);
          const expected = z.number().positive().parse(reference.blueAspect);
          const actual = z.number().positive().parse(picture.blueAspect);
          await writeFile(
            join(directory, `${platform}-${name}-aspect.json`),
            `${JSON.stringify({ actual, expected, relativeError: Math.abs(actual / expected - 1), limit: 0.1, referenceFrames: frames.length, referenceHeader: frames.at(-1)?.header }, null, 2)}\n`,
          );
          expect(Math.abs(actual / expected - 1)).toBeLessThan(0.1);
        }
        await verifyAspect("tile", await visible("tile"));
        expect(events.slice(cursor).some((entry) => entry.type === "decoded")).toBe(true);
        const fullCursor = events.length;
        stage = "full";
        revision++;
        await eventually(
          "native full-view layout",
          async () =>
            events
              .slice(fullCursor)
              .find(
                (entry) =>
                  entry.type === "layout" &&
                  z.object({ stage: z.literal("full") }).safeParse(entry.details).success,
              ),
          15_000,
        );
        await verifyAspect("full", await visible("full"));
        await options.phone.shell(`am start -W -n ${agentPhoneActivities.main}`);
        await cleared("own-app-protected");
        await options.phone.shell(`am start -W -n ${fixtureActivities.display}`);
        await visible("own-app-resumed");
        await options.phone.shell(`am start -W -n ${fixtureActivities.secure}`);
        await cleared("flag-secure-redacted");
        await options.phone.shell(`am start -W -n ${fixtureActivities.display}`);
        await visible("secure-window-resumed");
        await options.phone.shell("input keyevent KEYCODE_SLEEP");
        await cleared("screen-off-cleared");
        expect(await options.phone.shell("dumpsys power")).toMatch(/mWakefulness=Asleep/u);
        await options.phone.shell("input keyevent KEYCODE_WAKEUP");
        await options.phone.shell("wm dismiss-keyguard");
        await visible("static-local-wake");
        await background();
        await delay(1_000);
        await foreground();
        await visible("resumed");
        await options.phone.shell("settings put system accelerometer_rotation 0");
        await options.phone.shell("settings put system user_rotation 1");
        await delay(1_000);
        await verifyAspect("rotated-stream", await visible("rotated-stream"));
        await options.phone.shell("settings put system user_rotation 0");
        stage = "closed";
        revision++;
        await delay(1_000);
        const closed = join(directory, `${platform}-closed.png`);
        await shot(closed);
        expect(await colours(closed)).toMatchObject({ blue: 0, green: 0 });
        stage = "full";
        revision++;
        await visible("reopened");
        for (const version of [hostApiVersion - 1, hostApiVersion + 1]) {
          epoch = version;
          revision++;
          await eventually(
            `Expo ${platform} epoch ${version} refused`,
            async () =>
              events.slice(cursor).find(
                (entry) =>
                  entry.type === "epoch-refusal" &&
                  z
                    .object({
                      version: z.literal(version),
                      status: z.literal(400),
                      body: z.object({
                        ok: z.literal(false),
                        error: z.object({ reason: z.literal("unsupported-version") }),
                      }),
                    })
                    .safeParse(entry.details).success,
              ),
            15_000,
          );
          await delay(500);
          const rejected = join(directory, `${platform}-epoch-${version}-cleared.png`);
          await shot(rejected);
          expect(await colours(rejected)).toMatchObject({ blue: 0, green: 0 });
          epoch = hostApiVersion;
          revision++;
          await visible(`epoch-${version}-recovered`);
        }
        await current.revoke();
        await delay(1_000);
        const revoked = join(directory, `${platform}-revoked.png`);
        await shot(revoked);
        expect(await colours(revoked)).toMatchObject({ blue: 0, green: 0 });
        const previous = current.sessionId;
        const replacement = await options.task(platform);
        await delay(1_500);
        const replaced = join(directory, `${platform}-replacement-stays-cleared.png`);
        await shot(replaced);
        expect(await colours(replaced)).toMatchObject({ blue: 0, green: 0 });
        events.push({
          type: "replacement",
          platform,
          at: Date.now(),
          details: { previous, next: replacement.sessionId },
        });
        await replacement.revoke();
        current = await options.task(platform);
        stage = "full";
        revision++;
        await terminate();
        await launch();
        await visible("pause-task");
        await options.phone.shell(`am start -W -n ${agentPhoneActivities.main}`);
        await tapView(options.phone, {
          activity: agentPhoneActivities.main,
          viewId: "pause_switch",
        });
        await cleared("paused-task-ended");
        await tapView(options.phone, {
          activity: agentPhoneActivities.main,
          viewId: "pause_switch",
        });
        await options.phone.shell(`am start -W -n ${fixtureActivities.display}`);
        await cleared("unpaused-old-task-stays-cleared");
        await current.finish();
        const credit = events
          .slice(cursor)
          .filter((entry) => entry.platform === platform && entry.type === "display-close")
          .map((entry) =>
            z
              .object({ maxLive: z.number(), maxBytes: z.number(), acknowledged: z.number() })
              .parse(entry.details),
          );
        expect(credit.length).toBeGreaterThan(0);
        expect(credit.some((entry) => entry.acknowledged > 0)).toBe(true);
        for (const entry of credit) {
          expect(entry.maxLive).toBeLessThanOrEqual(4);
          expect(entry.maxBytes).toBeLessThanOrEqual(1_048_576);
        }
      } finally {
        if (android) {
          await android
            .adb(["logcat", "-d", "-t", "3000"])
            .then((log) => writeFile(join(directory, "android-logcat.txt"), log));
          await android.close();
        }
        if (startedIos) await runCommand("xcrun", ["simctl", "shutdown", udid]);
        await writeFile(join(directory, "events.json"), `${JSON.stringify(events, null, 2)}\n`);
      }
    }
  } finally {
    if (metro.pid) {
      try {
        process.kill(-metro.pid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
          cleanupFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await writeFile(join(directory, "events.json"), `${JSON.stringify(events, null, 2)}\n`);
    await writeFile(join(directory, "cleanup.json"), `${JSON.stringify(cleanupFailures)}\n`);
  }
  expect(cleanupFailures).toEqual([]);
  expect(await readFile(join(directory, "metro.log"), "utf8")).not.toMatch(
    /Uncaught \(in promise/u,
  );
}
