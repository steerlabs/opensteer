/**
 * A phone's live display on the pinned Electron, decoded the way desktop
 * Watch decodes it.
 *
 * The page is served by the desktop's own app protocol handler, so it runs
 * under the shipped Content-Security-Policy in a sandboxed renderer, and it
 * loads the shipping modules: the client's viewer transport and the web
 * view's WebCodecs decoder and canvas renderer. A socket playing the Host
 * feeds them: live frames under its four-frame credit window, its cache
 * replayed under byte credit with the frames' original sequences, and
 * acknowledgements consumed in delivery order.
 *
 * It proves, with no phone attached:
 *
 * 1. The phone's recorded H.264 vectors (a keyframe carrying SPS and PPS, and
 *    a delta) decode and cover the canvas. Both pictures are libx264 black,
 *    so here non-blank means the decoded pixels replaced a magenta fill
 *    everywhere. A delta that arrives before its keyframe is dropped and
 *    acknowledged; the others are acknowledged once the decoder takes them.
 * 2. The preview Host's phone decodes to its layout's colours, and control is
 *    granted and given back over the same socket.
 * 3. Frames this Chromium encodes itself, Annex B, decode under the live
 *    credit window with none skipped and no acknowledgement ahead of the
 *    decoder; the picture survives an announced generation change until the
 *    new keyframe decodes on a reconfigured decoder at the new size, and
 *    leaves the canvas on protection.
 * 4. A joiner's replay of 25 frames arrives at once under byte credit: none is
 *    skipped, and every draw any canvas received is recorded with the marker
 *    band it left, so the first picture shown is the `replayThrough` frame.
 * 5. A decoder broken on an intact frame keeps the last picture, sends one
 *    `display.keyframe` while later deltas are dropped, and recovers from the
 *    Host's replay of its cache under the original sequences on the same socket.
 * 6. A decoder holding six outputs back, as a reorder window does, still lets
 *    all live frames through the four-frame window: credit follows the
 *    decoder's queue, not its output.
 * 7. A recording decodes with no error and reaches the canvas at its size.
 * 8. An owner-view source decodes live pixels without sending control or input,
 *    and discards queued decoder output when that authority ends while a second
 *    owner window keeps decoding under its independent authority.
 *
 * A recording is a file of viewer frames as a viewer received them, each a
 * u32 big-endian length followed by that many bytes of display viewer
 * envelope (u32 header length, JSON header, Annex B access unit). Set
 * `OPENSTEER_DISPLAY_SMOKE_RECORDING` to a recorded phone stream to decode it
 * and require a picture with contrast; without it, the phone vectors are
 * written to and read back from that format.
 */
import assert from "node:assert/strict";
import { displayViewerCreditFrames } from "@opensteer/protocol";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, protocol } from "electron";
import {
  createDesktopAppProtocolHandler,
  desktopAppEntryUrl,
  registerDesktopAppScheme,
} from "../src/app/app-protocol.js";
import type {
  DisplaySmokeInput,
  DisplaySmokeResult,
  DisplaySmokeScenario,
} from "./electron-display-renderer-smoke.js";

const artifactDirectory =
  process.env.OPENSTEER_DISPLAY_E2E_ARTIFACT_DIR ?? path.join(tmpdir(), "opensteer-display-e2e");
const userData = mkdtempSync(path.join(tmpdir(), "opensteer-display-smoke-"));
const webRoot = mkdtempSync(path.join(tmpdir(), "opensteer-display-smoke-web-"));
const recordedStream = process.env.OPENSTEER_DISPLAY_SMOKE_RECORDING?.trim() || null;
app.setPath("userData", userData);
registerDesktopAppScheme(protocol);

const liveness = setInterval(() => undefined, 1_000);
let finished = false;
let result: DisplaySmokeResult | null = null;
app.on("before-quit", (event) => {
  if (!finished) event.preventDefault();
});
app.on("window-all-closed", () => undefined);

void run().then(
  () => finish(null),
  (error: unknown) => finish(error),
);

async function run(): Promise<void> {
  const vectors = JSON.parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        "../../../packages/runner-auth/fixtures/agent-phone-vectors.json",
      ),
      "utf8",
    ),
  ) as { displayMediaFrames: { viewerEnvelopeBase64: string }[] };
  const envelopes = vectors.displayMediaFrames.map((frame) =>
    Buffer.from(frame.viewerEnvelopeBase64, "base64"),
  );
  const recordingPath = recordedStream ?? path.join(webRoot, "vectors.recording");
  if (!recordedStream) writeFileSync(recordingPath, recordingOf(envelopes));
  const input: DisplaySmokeInput = {
    vectors: envelopes.map((bytes) => bytes.toString("base64")),
    recording: readRecording(recordingPath).map((bytes) => Buffer.from(bytes).toString("base64")),
    recordingSource: recordedStream ?? "phone vectors",
  };
  writeFileSync(
    path.join(webRoot, "index.html"),
    '<!doctype html><meta charset="utf-8"><script src="/renderer.js"></script>',
  );
  writeFileSync(
    path.join(webRoot, "renderer.js"),
    readFileSync(path.join(import.meta.dirname, "display-renderer-smoke.global.js")),
  );
  await app.whenReady();
  protocol.handle("app", createDesktopAppProtocolHandler(webRoot));
  const window = new BrowserWindow({
    show: false,
    // Pictures are drawn on animation frames, which a hidden window must still run.
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  try {
    await window.loadURL(desktopAppEntryUrl);
    result = (await window.webContents.executeJavaScript(
      `window.displaySmoke.run(${JSON.stringify(input)})`,
      true,
    )) as DisplaySmokeResult;
    verify(result);
  } finally {
    window.destroy();
  }
}

function verify(outcome: DisplaySmokeResult): void {
  assert.notEqual(outcome.acceleration, null, "This Electron cannot decode the phone's H.264.");
  const vectors = scenario(outcome, "phone-vectors");
  assert.deepEqual(vectors.checks.canvas, [180, 320]);
  assert.equal(vectors.checks.decodedEverywhere, true, "The vectors did not cover the canvas.");
  assert.equal(vectors.checks.sentinelLeft, false);
  assert.deepEqual(acknowledged(vectors), [0, 1, 2]);
  assert.equal(vectors.stats.dropped, 1);
  assert.equal(vectors.stats.decoded, 2);

  const preview = scenario(outcome, "mock-preview");
  assert.deepEqual(preview.checks.canvas, [360, 780]);
  assert.deepEqual(preview.checks.colours, {
    background: true,
    card: true,
    accent: true,
    button: true,
    line: true,
  });
  assert.equal(preview.checks.sharedInputSent, true);
  assert.deepEqual(
    preview.timeline.filter(
      (entry) => entry.startsWith("display.") && !entry.startsWith("display.ack"),
    ),
    ["display.input 0", "display.input-reset"],
  );

  const owner = scenario(outcome, "owner-authority");
  assert.deepEqual(owner.checks, {
    decoded: true,
    independentSibling: true,
    inputSent: false,
    inputFrameSent: false,
    cleared: true,
    queuedOutputDiscarded: true,
  });

  const generations = scenario(outcome, "encoder-generations");
  const checks = generations.checks as {
    keyframeUnits: { portrait: number[]; landscape: number[] };
    portrait: Record<string, boolean>;
    keptThroughGenerationChange: { stillPortrait: boolean; canvas: number[] };
    landscape: { canvas: number[]; green: boolean; yellow: boolean };
    clearedOnProtection: { shown: unknown; black: boolean };
    frames: { portrait: number; landscape: number };
  };
  for (const units of [checks.keyframeUnits.portrait, checks.keyframeUnits.landscape])
    assert(
      units.includes(7) && units.includes(8) && units.includes(5),
      `A keyframe lacks SPS, PPS or IDR: ${JSON.stringify(units)}`,
    );
  assert.deepEqual(checks.portrait, { red: true, blue: true, square: true });
  assert.equal(checks.keptThroughGenerationChange.stillPortrait, true);
  assert.deepEqual(checks.keptThroughGenerationChange.canvas, [240, 432]);
  assert.deepEqual(checks.landscape, { canvas: [432, 240], green: true, yellow: true });
  assert.equal(checks.clearedOnProtection.shown, null);
  assert.equal(checks.clearedOnProtection.black, true);
  const total = checks.frames.portrait + checks.frames.landscape;
  assert.equal(generations.stats.decoded, total, "A frame was skipped.");
  assert.equal(generations.stats.dropped, 0);
  assert.equal(generations.stats.configures, 2);
  assert(
    generations.maxOutstanding <= displayViewerCreditFrames,
    "The credit window was exceeded.",
  );
  assert.deepEqual(acknowledged(generations), sequences(0, total));
  assertCreditFollowsDecoder(generations);

  const join = scenario(outcome, "replay-join");
  const joined = join.checks as {
    frames: number;
    replayOutstanding: number;
    firstPaint: number;
    nothingStale: boolean;
  };
  assert(
    joined.replayOutstanding > displayViewerCreditFrames,
    `The replay never exceeded the live window: ${joined.replayOutstanding}`,
  );
  assert.equal(join.stats.decoded, joined.frames, "A replayed frame was skipped.");
  assert.equal(join.stats.dropped, 0);
  assert.equal(joined.firstPaint, 24, "The first picture shown was not the replayThrough frame.");
  assert.equal(joined.nothingStale, true, "A frame older than replayThrough was shown.");
  assert.deepEqual(acknowledged(join), sequences(0, joined.frames));
  assertCreditFollowsDecoder(join);

  const broken = scenario(outcome, "decoder-error");
  const recovery = broken.checks as {
    errors: number;
    keyframeRequests: number;
    keptPicture: boolean;
    recovered: number[];
    connection: string;
  };
  assert(recovery.errors >= 1, "The corrupted chunk did not break the decoder.");
  assert.equal(recovery.keyframeRequests, 1);
  assert.equal(recovery.keptPicture, true, "The last picture left while waiting for a keyframe.");
  assert.equal(recovery.connection, "open", "The Host's replay ended the socket.");
  assert.equal(recovery.recovered[0], 8, "Recovery did not show the replay's last frame first.");
  assert(recovery.recovered.every((shows) => shows >= 8));
  // Nine live frames, then the cache replayed under the same sequences.
  assert.deepEqual(acknowledged(broken), [...sequences(0, 9), ...sequences(0, 9)]);

  const reorder = scenario(outcome, "reorder-window");
  const held = reorder.checks as {
    frames: number;
    acknowledgedWhileHeld: number;
    heldOutputs: number;
    painted: number[];
  };
  assert.equal(held.heldOutputs, 6, "The decoder was not holding outputs back.");
  assert.equal(held.acknowledgedWhileHeld, held.frames, "Credit waited for decoder output.");
  assert(reorder.maxOutstanding <= displayViewerCreditFrames);
  assert.equal(held.painted.at(-1), held.frames - 1);
  assertCreditFollowsDecoder(reorder);

  const recorded = scenario(outcome, "recording");
  const stream = recorded.checks as {
    decodable: number;
    lastHeader: { width: number; height: number };
    canvas: number[];
    contrast: number;
  };
  assert.equal(recorded.stats.errors, 0, "The recording broke the decoder.");
  assert.equal(recorded.stats.decoded, stream.decodable, "A recorded frame did not decode.");
  assert.deepEqual(stream.canvas, [stream.lastHeader.width, stream.lastHeader.height]);
  if (recordedStream)
    assert(stream.contrast > 32, "The recorded stream decoded to a blank picture.");
}

function scenario(outcome: DisplaySmokeResult, name: string): DisplaySmokeScenario {
  const value = outcome.scenarios[name];
  assert(value, `The ${name} scenario did not run.`);
  assert(
    !("error" in value),
    `The ${name} scenario failed: ${"error" in value ? value.error : ""}`,
  );
  return value;
}

function acknowledged(value: DisplaySmokeScenario): number[] {
  return value.timeline
    .filter((entry) => entry.startsWith("display.ack "))
    .map((entry) => Number(entry.slice("display.ack ".length)));
}

function sequences(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index);
}

/** At every point, no more frames were acknowledged than the decoder had taken. */
function assertCreditFollowsDecoder(value: DisplaySmokeScenario): void {
  let taken = 0;
  let acks = 0;
  for (const entry of value.timeline) {
    if (entry.startsWith("taken ")) taken = Number(entry.slice("taken ".length));
    if (entry.startsWith("display.ack ")) acks += 1;
    assert(acks <= taken, `An acknowledgement went ahead of the decoder: ${entry}`);
  }
}

/** Frames as a recording holds them: each a u32 big-endian length, then that many bytes. */
function recordingOf(frames: readonly Uint8Array[]): Buffer {
  return Buffer.concat(
    frames.flatMap((frame) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(frame.byteLength);
      return [length, frame];
    }),
  );
}

function readRecording(file: string): Uint8Array[] {
  const bytes = readFileSync(file);
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength;) {
    assert(offset + 4 <= bytes.byteLength, `${file} ends inside a frame's length.`);
    const length = bytes.readUInt32BE(offset);
    assert(offset + 4 + length <= bytes.byteLength, `${file} ends inside a frame.`);
    frames.push(bytes.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  assert(frames.length > 0, `${file} holds no frames.`);
  return frames;
}

function finish(error: unknown): void {
  finished = true;
  clearInterval(liveness);
  const report = {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    platform: `${process.platform}-${process.arch}`,
    error: error ? (error instanceof Error ? error.stack : String(error)) : null,
    result,
  };
  void mkdir(artifactDirectory, { recursive: true })
    .then(() =>
      writeFile(
        path.join(artifactDirectory, "display.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      ),
    )
    .finally(() => {
      for (const directory of [userData, webRoot]) {
        // Chromium may still be writing its profile; a leftover temporary
        // directory must not keep the smoke from reporting.
        try {
          rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {}
      }
      if (error) {
        process.stderr.write(
          `${JSON.stringify({ event: "electron-display-smoke.failed", error: report.error })}\n`,
        );
        app.exit(1);
      } else {
        process.stdout.write(
          `${JSON.stringify({
            event: "electron-display-smoke.passed",
            acceleration: result?.acceleration,
            artifact: path.join(artifactDirectory, "display.json"),
          })}\n`,
        );
        app.quit();
      }
    });
}
