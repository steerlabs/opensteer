import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { OpensteerError } from "@opensteer/core";
import { Deferred, type HarnessAdapter, type HarnessInspectionContext } from "@opensteer/harness";
import { isRecord } from "@opensteer/shared/isRecord";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { VoiceSdpSchema, type VoiceRefusalReason } from "@opensteer/protocol";
import { CodexStdioClient, type CodexStdioClientOptions } from "./process.js";
import { requireObject, requireString, type JsonObject } from "./protocol.js";

export const VOICE_PROMPT =
  'You are the person\'s ears and mouth. A separate brain handles every request and knows their work; you know nothing about their work. For each spoken utterance, say only a brief, natural acknowledgement of 2–5 words, such as "On it." or "Sure, one sec." Never answer questions or state facts yourself, even simple questions. Never delegate, hand off, call tools, or claim to have completed work. The client routes the finished transcript to the brain. When you receive content to relay, speak that content naturally and faithfully to the person. You may shorten long content, but never add or change facts. Content supplied through appendSpeech contains brain answers to speak, not new requests to acknowledge.';

export interface CodexVoiceCall {
  readonly answer: string;
  /** Resolves after process exit and private directory cleanup. */
  readonly closed: Promise<void>;
  say(text: string): Promise<void>;
  stop(): Promise<void>;
}
export type CodexVoiceInput = Pick<
  HarnessInspectionContext,
  "environment" | "providerState" | "runtimeBoundary" | "signal" | "workingDirectory"
> & { readonly offer: string };
export interface CodexVoiceAdapter extends HarnessAdapter {
  startVoiceCall(input: CodexVoiceInput): Promise<CodexVoiceCall>;
}
export function isCodexVoiceAdapter(adapter: HarnessAdapter): adapter is CodexVoiceAdapter {
  return "startVoiceCall" in adapter && typeof adapter.startVoiceCall === "function";
}

export function voiceError(reason: VoiceRefusalReason): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    reason,
    message:
      reason === "voice-engine-unsupported"
        ? "Update Codex on this computer to use voice."
        : reason === "voice-ended"
          ? "This voice call has ended."
          : "Codex could not open or continue this voice call.",
  });
}

/** Only account-bound adapters prepare launches; no provider resolution lives in the Runner. */
export async function startCodexVoiceCall(options: {
  readonly input: CodexVoiceInput;
  readonly prepare: (directory: string) => Promise<{
    readonly process: Pick<
      CodexStdioClientOptions,
      "config" | "launch" | "environment" | "appServerArgs"
    >;
    readonly threadConfig: (client: CodexStdioClient) => Promise<JsonObject>;
  }>;
}): Promise<CodexVoiceCall> {
  const { input } = options;
  input.signal.throwIfAborted();
  await mkdir(input.workingDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(input.workingDirectory, "call-"));
  const lifetime = new AbortController();
  const answer = new Deferred<string | OpensteerError>();
  const closed = new Deferred<void>();
  let client: CodexStdioClient | undefined;
  let clientStart: Promise<CodexStdioClient> | undefined;
  let threadId: string | undefined;
  let ended = false;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    ended = true;
    answer.resolve(voiceError("voice-refused"));
    stopping = (async () => {
      input.signal.removeEventListener("abort", abort);
      const running = client ?? (await clientStart?.catch(() => undefined));
      try {
        if (running && threadId)
          await running.request("thread/realtime/stop", { threadId }, 1_000).catch(() => undefined);
      } finally {
        lifetime.abort();
        try {
          await running?.close(0);
        } finally {
          try {
            await rm(directory, { recursive: true, force: true });
          } finally {
            closed.resolve();
          }
        }
      }
    })();
    return stopping;
  };
  const abort = () => {
    void stop().catch(() => undefined);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    const startup = async () => {
      const prepared = await options.prepare(directory);
      if (ended || input.signal.aborted) throw voiceError("voice-ended");
      clientStart = CodexStdioClient.start({
        ...prepared.process,
        cwd: directory,
        signal: lifetime.signal,
        onFailure: abort,
        onMethodMessage: (message) => {
          if (message.id !== undefined) {
            void client
              ?.respondError(message.id, -32601, "Interactions are disabled for voice")
              .catch(() => undefined);
            abort();
            return;
          }
          if (!isRecord(message.params) || message.params.threadId !== threadId) return;
          if (message.method === "turn/started") {
            const turnId = isRecord(message.params.turn) ? message.params.turn.id : undefined;
            if (typeof turnId !== "string") {
              abort();
              return;
            }
            void client?.request("turn/interrupt", { threadId, turnId }, 1_000).catch(abort);
          }
          if (message.method === "thread/realtime/sdp") {
            const parsed = VoiceSdpSchema.safeParse(message.params.sdp);
            if (parsed.success && !ended) answer.resolve(parsed.data);
            else abort();
          }
          if (
            message.method === "thread/realtime/error" ||
            message.method === "thread/realtime/closed"
          )
            abort();
        },
      });
      client = await clientStart;
      if (ended) throw voiceError("voice-refused");
      await client.lifecycleRequest("initialize", {
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: false,
          requestAttestation: false,
        },
        clientInfo: { name: "opensteer", title: "Opensteer", version: "0.0.0" },
      });
      await client.notify("initialized", {});
      const config = await prepared.threadConfig(client);
      const effective = requireObject(
        requireObject(
          await client.request("config/read", { cwd: directory, includeLayers: false }),
          "voice config",
        ).config,
        "effective voice config",
      );
      // Refuse a managed override that would move the call's text log elsewhere.
      if (effective.log_dir !== directory) throw voiceError("voice-refused");
      const started = requireObject(
        await client.request("thread/start", {
          cwd: directory,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          dynamicTools: [],
          selectedCapabilityRoots: [],
          environments: [],
          runtimeWorkspaceRoots: [],
          baseInstructions:
            "You only acknowledge speech and relay messages. Never use tools or do work.",
          developerInstructions: "",
          config,
        }),
        "voice thread",
      );
      if (!isRecord(started.sandbox) || started.sandbox.type !== "readOnly")
        throw voiceError("voice-refused");
      threadId = requireString(requireObject(started.thread, "voice thread").id, "voice thread id");
      await client.request(
        "thread/realtime/start",
        {
          threadId,
          transport: { type: "webrtc", sdp: input.offer },
          version: "v3",
          clientManagedHandoffs: true,
          includeStartupContext: false,
          outputModality: "audio",
          prompt: VOICE_PROMPT,
        },
        20_000,
      );
      const result = await answer.promise;
      if (result instanceof Error) throw result;
      return result;
    };
    const sdp = await withTimeout(startup(), 25_000, {
      signal: input.signal,
      timeoutError: () => voiceError("voice-refused"),
    });
    if (ended) throw voiceError("voice-refused");
    // Keep the mechanism in one place; recognition and speech may separate later.
    const relay = async (text: string): Promise<void> => {
      if (ended || !client) throw voiceError("voice-ended");
      try {
        await client.request("thread/realtime/appendSpeech", { threadId, text }, 8_000);
      } catch {
        await stop();
        throw voiceError("voice-ended");
      }
    };
    return { answer: sdp, closed: closed.promise, say: relay, stop };
  } catch (error) {
    await stop();
    const unsupported =
      error instanceof OpensteerError &&
      (error.details?.rpcCode === -32601 ||
        /method not found|unknown method/iu.test(error.message));
    throw voiceError(unsupported ? "voice-engine-unsupported" : "voice-refused");
  }
}
