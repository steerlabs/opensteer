import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  Deferred,
  type HarnessSession,
  type HarnessVoiceCall,
  nativeUserHarnessRuntimeBoundary,
} from "@opensteer/harness";
import { hostCommandPlatform, resolveCommand } from "@opensteer/shared/command";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { CodexHarnessDriver } from "./codex-driver.js";
import { ModelSelectionSchema } from "@opensteer/core";

const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const signedIn = await access(join(codexHome, "auth.json")).then(
  () => true,
  () => false,
);
const executable = resolveCommand("codex", {
  cwd: process.cwd(),
  environment: process.env,
  platform: hostCommandPlatform(),
})?.path;
const qualify = process.platform === "darwin" && signedIn && executable !== undefined;

/** The one fact only the stand-in Opensteer tool knows, so a spoken answer proves the tool ran. */
const toolFact = "The meeting moved to 4:30 PM on Thursday.";

/**
 * A loopback stand-in for the Host's Opensteer MCP with one tool, so
 * qualification proves a spoken request reaches a real MCP tool call without
 * production credentials. The SDK is resolved through the Host, which owns it.
 */
async function startToolServer(token: string) {
  const sdk = createRequire(
    fileURLToPath(new URL("../../../apps/host/package.json", import.meta.url)),
  );
  const { Server } = (await import(sdk.resolve("@modelcontextprotocol/sdk/server/index.js"))) as {
    Server: new (
      info: object,
      options: object,
    ) => {
      setRequestHandler(
        schema: unknown,
        handler: (request: { params: { name: string } }) => unknown,
      ): void;
      connect(transport: unknown): Promise<void>;
      close(): Promise<void>;
    };
  };
  const { StreamableHTTPServerTransport } = (await import(
    sdk.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js")
  )) as {
    StreamableHTTPServerTransport: new (options: object) => {
      handleRequest(request: unknown, response: unknown, body: unknown): Promise<void>;
    };
  };
  const { CallToolRequestSchema, ListToolsRequestSchema } = (await import(
    sdk.resolve("@modelcontextprotocol/sdk/types.js")
  )) as { CallToolRequestSchema: unknown; ListToolsRequestSchema: unknown };
  const calls: string[] = [];
  const http: HttpServer = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const server = new Server(
          { name: "opensteer", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: [
            {
              name: "thread_read",
              description: "Read the person's latest note.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        }));
        server.setRequestHandler(CallToolRequestSchema, (call) => {
          calls.push(call.params.name);
          return { content: [{ type: "text", text: toolFact }] };
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);
        const body = chunks.length
          ? (JSON.parse(Buffer.concat(chunks).toString()) as unknown)
          : undefined;
        await transport.handleRequest(request, response, body);
        await server.close();
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Tool server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

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
  it("acts on speech, takes news mid-call, and remembers it on the next call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-voice-engine-"));
    const adapter = await new CodexHarnessDriver({ launch }).create({
      instanceId: createId("harnessInstance"),
      config: {},
      sourceId: "openai",
    });
    const token = createId("run");
    const tools = await startToolServer(token);
    const browser = await chromium.launch({
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const threadId = createId("thread");
    const environmentId = createId("environment");
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const guide =
      "Voice call: replies are spoken. Use 1–3 short sentences. Use your tools. For the person's notes, call thread_read.";
    const stops: (() => Promise<void>)[] = [];

    /** One call: a browser peer, its audio, and a Run on the same Thread. */
    async function dial(reference?: string) {
      const lifetime = new AbortController();
      const page = await browser.newPage();
      const heard: string[] = [];
      const said: string[] = [];
      const runEvents: string[] = [];
      const recorded: string[] = [];
      const waiting: { pattern: RegExp; done: Deferred<void> }[] = [];
      const seen = () => JSON.stringify({ heard, said, toolCalls: tools.calls, runEvents });
      await page.exposeFunction("voiceEvent", (raw: string) => {
        const event = JSON.parse(raw) as {
          type?: string;
          turn?: { role?: string; transcript?: string };
        };
        if (event.type !== "turn.done") return;
        const text = event.turn?.transcript ?? "";
        if (event.turn?.role === "user") heard.push(text);
        if (event.turn?.role !== "assistant") return;
        said.push(text);
        for (const { pattern, done } of waiting) if (pattern.test(text)) done.resolve();
      });
      /** Resolves once the voice has said something matching, whenever that was. */
      const says = async (pattern: RegExp, what: string) => {
        if (said.some((text) => pattern.test(text))) return;
        const done = new Deferred<void>();
        waiting.push({ pattern, done });
        await withTimeout(done.promise, 90_000, {
          timeoutError: () => new Error(`${what}: ${seen()}`),
        });
      };
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
      const context = {
        accessMode: "approval-required",
        voiceCall: call,
        agentTools: {
          url: tools.url,
          token,
          instructions: guide,
          tools: ["thread_read"],
          toolsRevision: "voice-qualification",
          skills: [],
        },
        environmentId,
        harnessInstanceId: adapter.instanceId,
        history: [],
        historyWindow: { byteCount: 0, itemCount: 0, hasEarlier: false },
        instructions: "Answer in one or two short sentences.",
        // The Runner delivers the Host's Run plan instructions as the platform guide.
        platformGuide: guide,
        machineAccessNotice: "No other computers are reachable.",
        machineAccessPlatform: undefined,
        machineAccessRelaySocket: undefined,
        modelSelection: ModelSelectionSchema.parse({
          providerId: "openai",
          modelId: "gpt-6.1-terra",
          options: { effort: "low", speed: "priority" },
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
        wrapProcessLaunch: (value) => value,
        commandEnvironment: {},

        workspacePath: directory,
        writableRoots: [directory],
      } satisfies Parameters<typeof adapter.startSession>[0];
      const session: HarnessSession = reference
        ? await adapter.resumeSession(reference, context)
        : await adapter.startSession(context);
      const terminal = { count: 0 };
      const consume = (async () => {
        for await (const event of session.events) {
          runEvents.push(event.type);
          if (event.type === "voice.heard") recorded.push(event.data.text);
          // Nobody taps in qualification: decline as a person would, so the
          // agent answers with its Opensteer tool rather than waiting on a shell.
          if (event.type === "request.opened")
            void session
              .resolveRequest(event.data.request.id, { kind: "choice", optionId: "reject" })
              .catch(() => undefined);
          if (event.type === "run.interrupted" || event.type === "run.failed") terminal.count++;
        }
      })();
      const execution = session.execute({
        environment,
        inputs: [],
        requestedBy: createId("user"),
        runId: createId("run"),
        signal: lifetime.signal,
        context: {
          assignment: null,
          teamTurnContext: null,
          requesterTimeZone: null,
          threadState: { previousAssignment: null, previousRun: null },
        },
        reports: { messages: [], omittedCount: 0, throughSequence: null },
      });
      const hangUp = async () => {
        lifetime.abort();
        await withTimeout(Promise.all([execution, consume]), 10_000, {
          timeoutError: () => new Error("Voice Run did not end"),
        });
        await session.stop();
        await page.close();
      };
      stops.push(async () => {
        lifetime.abort();
        await session.stop();
      });
      await page.evaluate(
        `window.pc.setRemoteDescription({type:"answer",sdp:${JSON.stringify(await withTimeout(answer.promise, 30000, { timeoutError: () => new Error("Voice answer did not arrive") }))}})`,
      );
      await page.waitForFunction("window.pc.connectionState === 'connected'", null, {
        timeout: 15_000,
      });
      const speak = async (words: string, file: string) => {
        const wav = join(directory, file);
        await promisify(execFile)("say", ["-o", wav, "--data-format=LEI16@24000", words], {
          timeout: 15000,
        });
        await page.evaluate(
          `window.speak(${JSON.stringify((await readFile(wav)).toString("base64"))})`,
        );
      };
      return { hangUp, recorded, says, session, speak, terminal };
    }

    try {
      expect(adapter.capabilities.voiceCalls).toBe(true);
      const first = await dial();
      await first.speak("What does my latest note say?", "first.wav");
      // The voice acknowledges first ("On it…"); only speech carrying the tool's fact is the answer.
      await first.says(/4:30|four[- ]thirty/iu, "No spoken answer from the tool");
      expect(tools.calls).toContain("thread_read");
      // News from outside the call: nobody speaks, yet the agent takes it and says it.
      await first.session.steer!({
        input: {
          author: {
            kind: "platform",
            cause: "assignment-result",
            referenceId: "task",
          },
          content: [{ type: "text", text: "A task finished: your flight leaves at 6:40 PM." }],
          createdAt: new Date().toISOString(),
          kind: "continuation",
          messageId: createId("message"),
        },
      });
      await first.says(/6:40|six[- ]forty/iu, "News never reached the person");
      // An aside the realtime voice answers alone still reaches the Thread, once.
      await first.speak("By the way, my dog is called Biscuit.", "aside.wav");
      await vi.waitFor(() => expect(first.recorded.join(" ")).toMatch(/biscuit/iu), {
        timeout: 30_000,
        interval: 250,
      });
      expect(first.recorded.filter((text) => /latest note/iu.test(text))).toHaveLength(1);
      expect(first.terminal.count).toBe(0);
      const reference = first.session.providerSessionReference;
      await first.hangUp();
      expect(first.terminal.count).toBe(1);

      // The next call is the same conversation: only the first call heard this fact.
      const second = await dial(reference);
      await second.speak("What time does my flight leave?", "second.wav");
      await second.says(/6:40|six[- ]forty/iu, "The next call forgot the first");
      await second.hangUp();
      expect(second.terminal.count).toBe(1);
    } finally {
      const cleanup = await Promise.allSettled([
        ...stops.map((stop) => stop()),
        adapter.close(),
        browser.close(),
        tools.close(),
      ]);
      await rm(directory, { recursive: true, force: true });
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      expect(errors, "Voice qualification cleanup failed").toEqual([]);
    }
  });
});
