import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { z } from "zod";

// Coordinator for journey.tsx in one owned iOS simulator or Android emulator:
// serves fixtures, records the journey's events and assertions, and checks real
// screenshot pixels.
const udid = process.env.OPENSTEER_PHONE_DISPLAY_UDID;
const serial = process.env.OPENSTEER_PHONE_DISPLAY_SERIAL;
if (!udid === !serial) throw new Error("Set exactly one owned simulator UDID or Android serial");
const device = z.string().min(1).parse(process.env.OPENSTEER_PHONE_DISPLAY_DEVICE);
const bundle = "com.opensteer.mobile";
const adb = (...args: string[]) =>
  execFileSync("adb", ["-s", serial!, ...args], { maxBuffer: 64 * 1024 * 1024 });
const simctl = (...args: string[]) =>
  execFileSync("xcrun", ["simctl", ...args], { stdio: "ignore" });
const directory = path.join(
  z.string().min(1).parse(process.env.OPENSTEER_PHONE_DISPLAY_EVIDENCE_DIR),
  device,
);
mkdirSync(directory, { recursive: true });
const fixtures = path.join(import.meta.dirname, "fixtures");
const fixtureNames = new Set([
  "mac.h264",
  "resized.h264",
  "noisy.h264",
  "red-blue-64x48.jpg",
  "green-yellow-48x64.jpg",
  "lime-key-64x64.h264",
  "blue-delta-64x64.h264",
]);
const results: { step: string; passed: boolean; details: unknown }[] = [];
let started = false;
const record = (step: string, passed: boolean, details: unknown) => {
  results.push({ step, passed, details });
  appendFileSync(
    path.join(directory, "results.jsonl"),
    JSON.stringify({ step, passed, details }) + "\n",
  );
};

const Color = z.tuple([z.number(), z.number(), z.number()]);
const Check = z.object({
  step: z.string().regex(/^[a-z0-9-]+$/),
  probes: z
    .array(z.object({ x: z.number(), y: z.number(), color: Color, label: z.string() }))
    .min(1),
  screen: z.object({ width: z.number().positive(), height: z.number().positive() }),
  window: z.object({ width: z.number().positive(), height: z.number().positive() }),
  never: z.boolean().optional(),
  /** Passes once no probe matches: the probed pixels have left the screen. */
  gone: z.boolean().optional(),
  ms: z.number().int().positive().max(5_000).optional(),
});
const palette = [
  [255, 0, 0],
  [0, 0, 255],
  [0, 255, 0],
  [255, 255, 0],
  [128, 128, 128],
  [0, 0, 0],
] as const;

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG, which is what simctl and screencap write. */
function decodePng(file: Buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("latin1", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error("Unsupported PNG depth or interlace");
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (channels === 0) throw new Error(`Unsupported PNG colour type ${body[9]}`);
    } else if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      const p = left + up - corner;
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner)
          ? left
          : Math.abs(p - up) <= Math.abs(p - corner)
            ? up
            : corner;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter!];
      if (predicted === undefined) throw new Error(`Unknown PNG filter ${filter}`);
      pixels[y * stride + x] = (value + predicted) & 255;
    }
  }
  return {
    width,
    height,
    /** The mean colour of a 5 × 5 patch, so a single anti-aliased pixel cannot decide. */
    sample(px: number, py: number) {
      const sum = [0, 0, 0];
      let count = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const x = Math.round(px) + dx;
          const y = Math.round(py) + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          for (let c = 0; c < 3; c++) sum[c]! += pixels[y * stride + x * channels + c]!;
          count++;
        }
      return sum.map((value) => Math.round(value / Math.max(count, 1)));
    },
  };
}
/** The nearest palette colour, so a Display P3-tagged screenshot still classifies sRGB fixtures. */
function classify(color: number[]) {
  let best: readonly number[] = palette[0];
  let distance = Infinity;
  for (const entry of palette) {
    const d = entry.reduce<number>(
      (total, value, index) => total + (value - color[index]!) ** 2,
      0,
    );
    if (d < distance) [best, distance] = [entry, d];
  }
  return distance < 120 ** 2 ? best : null;
}

let shot = 0;
function screenshot(step: string) {
  const file = path.join(directory, `${String(++shot).padStart(3, "0")}-${step}.png`);
  // Duo launches on its cover display; simctl defaults to the inactive inner display.
  if (udid)
    simctl(
      "io",
      udid,
      "screenshot",
      "--type=png",
      ...(device === "iPhone-Duo" ? ["--display=1"] : []),
      file,
    );
  else writeFileSync(file, adb("exec-out", "screencap", "-p"));
  return { file, image: decodePng(readFileSync(file)) };
}

async function check(input: z.infer<typeof Check>) {
  const deadline = Date.now() + (input.ms ?? 3_000);
  const observations: unknown[] = [];
  for (;;) {
    const { file, image } = screenshot(input.step);
    const scale = image.width / input.screen.width;
    const samples = input.probes.map((probe) => {
      const color = image.sample(probe.x * scale, probe.y * scale);
      const seen = classify(color);
      return {
        label: probe.label,
        expected: probe.color,
        color,
        matches: seen !== null && seen.every((value, index) => value === probe.color[index]),
      };
    });
    observations.push({ file: path.basename(file), scale, samples });
    if (input.gone) {
      if (samples.every((sample) => !sample.matches)) return { passed: true, observations };
      if (Date.now() >= deadline) return { passed: false, observations };
    } else if (input.never) {
      if (samples.some((sample) => sample.matches)) return { passed: false, observations };
      if (Date.now() >= deadline) return { passed: true, observations };
    } else {
      if (samples.every((sample) => sample.matches)) return { passed: true, observations };
      if (Date.now() >= deadline) return { passed: false, observations };
    }
  }
}

/** Whether the activity manager logs this app's activity stopped within `ms`. */
function stopEvent(ms: number) {
  adb("logcat", "-b", "events", "-c");
  const events = spawn("adb", ["-s", serial!, "logcat", "-b", "events", "-s", "wm_on_stop_called"]);
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      events.kill();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), ms);
    let text = "";
    events.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes(`${bundle}.MainActivity`)) done(true);
    });
    events.once("exit", () => done(false));
  });
}

async function body(request: AsyncIterable<unknown>) {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 262_144) throw new Error("Request too large");
  }
  return JSON.parse(text || "{}") as unknown;
}
function reply(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}
function finish(failed: boolean, message?: string) {
  const report = {
    device,
    udid,
    serial,
    source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    passed: !failed && started && results.length > 0 && results.every((result) => result.passed),
    message,
    failures: results.filter((result) => !result.passed).map((result) => result.step),
    checks: results.length,
  };
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  server.close();
  server.closeAllConnections();
  process.exitCode = report.passed ? 0 : 1;
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:18766");
    if (request.method === "GET" && url.pathname.startsWith("/fixture/")) {
      const name = url.pathname.slice("/fixture/".length);
      if (!fixtureNames.has(name)) return reply(response, 404, { error: "unknown fixture" });
      response.setHeader("content-type", "application/octet-stream");
      return response.end(readFileSync(path.join(fixtures, name)));
    }
    const input = await body(request);
    if (url.pathname === "/start") {
      started = true;
      record("app-started", true, input);
    } else if (url.pathname === "/event") {
      appendFileSync(path.join(directory, "events.jsonl"), JSON.stringify(input) + "\n");
    } else if (url.pathname === "/assert") {
      const { step, passed, details } = z
        .object({ step: z.string(), passed: z.boolean(), details: z.unknown() })
        .parse(input);
      record(step, passed, details);
    } else if (url.pathname === "/check") {
      const parsed = Check.parse(input);
      const outcome = await check(parsed);
      record(`pixels:${parsed.step}`, outcome.passed, {
        never: parsed.never ?? false,
        screen: parsed.screen,
        window: parsed.window,
        ...outcome,
      });
    } else if (url.pathname === "/background") {
      // Another app takes the foreground until the journey's pixels are off
      // screen, then the journey's app returns as a person would.
      const parsed = Check.parse(input);
      if (udid) simctl("launch", udid, "com.apple.Preferences");
      else {
        // Android stops the app only after the other activity has settled; a
        // person leaving the app gets there, a quick relaunch while paused does not.
        const stopped = stopEvent(5_000);
        adb("shell", "am", "start", "-W", "-a", "android.settings.SETTINGS");
        const state = (await stopped) ? "STOPPED" : "not stopped within 5000 ms";
        record(`stopped:${parsed.step}`, state === "STOPPED", { state });
      }
      const outcome = await check({ ...parsed, gone: true, ms: 5_000 });
      record(`pixels:${parsed.step}`, outcome.passed, { gone: true, ...outcome });
      if (udid) simctl("launch", udid, bundle);
      else adb("shell", "am", "start", "-W", "-n", `${bundle}/.MainActivity`);
    } else if (url.pathname === "/done") {
      const { failed, message } = z
        .object({ failed: z.boolean(), message: z.string().optional() })
        .parse(input);
      if (message) record("journey-completed", false, message);
      reply(response, 200, {});
      return finish(failed, message);
    } else return reply(response, 404, { error: "unknown path" });
    reply(response, 200, {});
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    record("coordinator-error", false, message);
    reply(response, 500, { error: message });
  });
});
server.listen(18766, "127.0.0.1", () =>
  process.stdout.write(`Phone display journey coordinator: ${directory}\n`),
);
const deadline = setTimeout(() => {
  record(
    "journey-deadline",
    false,
    started ? "journey did not finish within 240 s" : "app never reached the coordinator",
  );
  finish(true);
}, 240_000);
deadline.unref();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.once(signal, () => {
    record("coordinator-stopped", false, signal);
    finish(true);
  });
