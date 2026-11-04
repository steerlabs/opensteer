import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import {
  Deferred,
  type HarnessSession,
  type HarnessVoiceCall,
  findExecutableOnPath,
  nativeUserHarnessRuntimeBoundary,
} from "@opensteer/harness";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { CodexHarnessDriver } from "./codex-driver.js";
import { ModelSelectionSchema } from "@opensteer/core";

const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const signedIn = await access(join(codexHome, "auth.json")).then(
  () => true,
  () => false,
);
const executable = findExecutableOnPath("codex", process.env.PATH);
const qualify =
  process.env.OPENSTEER_VOICE_QUALIFY === "1" &&
  process.platform === "darwin" &&
  signedIn &&
  executable !== undefined;

// Uses shipped and installed CLIs with the person’s own login. Audio and call state live only in
// a disposable directory; the browser has no connection to an installed app.
describe.skipIf(!qualify).each([
  {
    label: "shipped",
    launch: {
      executable: process.execPath,
      arguments: [
        fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url)),
      ],
    },
  },
  { label: "installed", launch: { executable: executable!, arguments: [] } },
])("$label Codex voice agent", ({ launch }) => {
  it("adopts an audio handoff, speaks its final answer and ends its one Run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-voice-engine-"));
    const adapter = await new CodexHarnessDriver({ launch }).create({
      instanceId: createId("harnessInstance"),
      config: {},
      sourceId: "openai",
    });
    let session: HarnessSession | undefined;
    const lifetime = new AbortController();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      expect(adapter.capabilities.voiceCalls).toBe(true);
      browser = await chromium.launch({
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
      const page = await browser.newPage();
      const events: { at: number; text: string }[] = [];
      const userTurns: { at: number; text: string }[] = [];
      const spoken = new Deferred<void>();
      let answeredAt = Number.POSITIVE_INFINITY;
      let lastSpeechAt = 0;
      await page.exposeFunction("voiceEvent", (raw: string) => {
        const event = JSON.parse(raw) as {
          type?: string;
          turn?: { id?: string; role?: string; transcript?: string };
        };
        if (event.type === "output_transcript.added") lastSpeechAt = Date.now();
        if (event.type === "turn.done" && event.turn?.role === "user")
          userTurns.push({ at: Date.now(), text: event.turn.transcript ?? "" });
        if (event.type === "turn.done" && event.turn?.role === "assistant") {
          const text = event.turn.transcript ?? "";
          events.push({ at: Date.now(), text });
          if (lastSpeechAt >= answeredAt) spoken.resolve();
        }
      });
      const offer = (await page.evaluate(`(async () => {
        const pc = new RTCPeerConnection(); window.pc = pc;
        const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0;
        const dest = ctx.createMediaStreamDestination(); osc.connect(gain).connect(dest); osc.start();
        window.speak = async (b64) => { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const src = ctx.createBufferSource(); src.buffer = await ctx.decodeAudioData(bytes.buffer); src.connect(dest); src.start(); };
        pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
        // The browser only reads oai-events; writing interrupts audio and bypasses Codex.
        const dc = pc.createDataChannel("oai-events"); dc.onmessage = e => window.voiceEvent(e.data);
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("ICE gathering did not complete")), 10000); const ready = () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); } }; pc.onicegatheringstatechange = ready; ready(); });
        return pc.localDescription.sdp;
      })()`)) as string;
      const answer = new Deferred<string>();
      let writer: Parameters<HarnessVoiceCall["connect"]>[0] | undefined;
      let speech = Promise.resolve();
      const call: HarnessVoiceCall = {
        offer: Promise.resolve(offer),
        signal: lifetime.signal,
        answer: (sdp) => answer.resolve(sdp),
        connect: (value) => {
          writer = value;
        },
        speak: (_id, text) => {
          speech = speech.then(() => writer!.speak(text));
          return speech;
        },
        end: () => lifetime.abort(),
      };
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const threadId = createId("thread"),
        runId = createId("run");
      // Qualification supplies a disposable, Run-scoped Host MCP plan, never production credentials.
      const url = process.env.OPENSTEER_VOICE_TEST_MCP_URL;
      const token = process.env.OPENSTEER_VOICE_TEST_MCP_TOKEN;
      if (!url || !token)
        throw new Error("Supply the disposable Host MCP URL and token for qualification");
      session = await adapter.startSession({
        accessMode: "approval-required",
        voiceCall: call,
        agentTools: {
          url,
          token,
          instructions: "Use Opensteer tools when needed. Speak briefly.",
          tools: ["thread_read"],
          toolsRevision: "voice-qualification",
          skills: [],
        },
        environmentId: createId("environment"),
        harnessInstanceId: adapter.instanceId,
        history: [],
        historyWindow: { byteCount: 0, itemCount: 0, hasEarlier: false },
        instructions: "Answer in one short sentence.",
        platformGuide: "You are the voice call's agent.",
        machineAccessNotice: "No other computers are reachable.",
        machineAccessPlatform: undefined,
        machineAccessRelaySocket: undefined,
        modelSelection: ModelSelectionSchema.parse({
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          options: { effort: "low" },
        }),
        environment,
        runtimeBoundary: nativeUserHarnessRuntimeBoundary,
        signal: lifetime.signal,
        providerState: {
          kind: "ambient",
          providerHomeDirectory: undefined,
          continuationKey: "voice-engine",
          privateStateRoot: directory,
          store: { directory: join(directory, "store"), id: "voice-engine" },
        },
        skills: undefined,
        threadId,
        threadStateDirectory: join(directory, "call-private"),
        wrapProcessLaunch: (launch) => launch,
        workspaceId: createId("workspace"),
        workspacePath: directory,
        writableRoots: [directory],
      });
      const final = new Deferred<void>();
      let terminal = 0;
      const consume = (async () => {
        for await (const event of session!.events) {
          if (event.type === "assistant.message") final.resolve();
          if (event.type === "run.interrupted" || event.type === "run.failed") terminal++;
        }
      })();
      const execution = session.execute({
        environment,
        inputs: [],
        requestedBy: createId("user"),
        runId,
        signal: lifetime.signal,
        context: {
          assignment: null,
          requesterTimeZone: null,
          threadState: { previousAssignment: null, previousRun: null },
        },
        reports: { messages: [], omittedCount: 0, throughSequence: null },
      });
      await page.evaluate(
        `window.pc.setRemoteDescription({type:"answer",sdp:${JSON.stringify(await withTimeout(answer.promise, 30000, { timeoutError: () => new Error("No SDP answer") }))}})`,
      );
      await page.waitForFunction("window.pc.connectionState === 'connected'", null, {
        timeout: 15_000,
      });
      const wav = join(directory, "speech.wav");
      await promisify(execFile)(
        "say",
        [
          "-o",
          wav,
          "--data-format=LEI16@24000",
          "Use your agent to calculate the sum of 237 and 419 and tell me the answer.",
        ],
        { timeout: 15000 },
      );
      answeredAt = Date.now();
      await page.evaluate(
        `window.speak(${JSON.stringify((await readFile(wav)).toString("base64"))})`,
      );
      await withTimeout(final.promise, 45000, {
        timeoutError: () => new Error("No engine-initiated final answer"),
      });
      await withTimeout(spoken.promise, 30000, {
        timeoutError: () => new Error("No spoken final answer"),
      });
      expect(terminal).toBe(0);
      lifetime.abort();
      await withTimeout(Promise.all([execution, consume]), 10000, {
        timeoutError: () => new Error("Voice Run did not end"),
      });
      expect(terminal).toBe(1);
    } finally {
      lifetime.abort();
      const cleanup = await Promise.allSettled([
        session?.stop(),
        adapter.close(),
        browser?.close(),
      ]);
      await rm(directory, { recursive: true, force: true });
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      expect(errors, "Voice qualification cleanup failed").toEqual([]);
    }
  });
});
