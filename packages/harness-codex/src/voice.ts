import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { OpensteerError } from "@opensteer/core";
import { Deferred, type HarnessAdapter, type HarnessInspectionContext } from "@opensteer/harness";
import { isRecord } from "@opensteer/shared/isRecord";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  VoiceSdpSchema,
  voiceNextHoldMs,
  voiceToolCallTimeoutMs,
  type VoiceToolCall,
  type VoiceRefusalReason,
} from "@opensteer/protocol";
import { CodexStdioClient, type CodexStdioClientOptions } from "./process.js";
import { VOICE_AGENT_INSTRUCTIONS, voiceAgentTools } from "./voice-agent.js";
import { requireObject, requireString, type JsonObject } from "./protocol.js";

export const VOICE_PROMPT =
  'You are the person\'s ears and mouth. A separate brain handles every request and knows their work; you know nothing about their work. For each spoken utterance, say only a brief, natural acknowledgement of 2–5 words, such as "On it." or "Sure, one sec." Never answer questions or state facts yourself, even simple questions. Never delegate, hand off, call tools, or claim to have completed work. The client routes the finished transcript to the brain. When you receive content to relay, speak that content naturally and faithfully to the person. You may shorten long content, but never add or change facts. Content supplied through appendSpeech contains brain answers to speak, not new requests to acknowledge.';

export interface CodexVoiceCall {
  readonly answer: string;
  /** Resolves after process exit and private directory cleanup. */
  readonly closed: Promise<void>;
  next(signal: AbortSignal): Promise<VoiceToolCall | null>;
  answerCall(callId: string, ok: boolean, text: string): Promise<void>;
  context(text: string): Promise<void>;
  say(text: string): Promise<void>;
  stop(): Promise<void>;
}
export type CodexVoiceInput = Pick<
  HarnessInspectionContext,
  "environment" | "providerState" | "runtimeBoundary" | "signal" | "workingDirectory"
> & { readonly offer: string; readonly agent: boolean };
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
  const pending = new Map<
    string,
    { call: VoiceToolCall; finish: (ok: boolean, text: string) => Promise<void> }
  >();
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const resolve of waiters) resolve();
  };
  let injects: Promise<void> = Promise.resolve();
  let lastContext: string | undefined;
  const inject = (text: string, context?: string) => {
    const result = injects.then(async () => {
      if (context !== undefined && context === lastContext) return;
      if (ended || !client) throw voiceError("voice-ended");
      await client.request("thread/inject_items", {
        threadId,
        items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }],
      });
      if (context !== undefined) lastContext = context;
    });
    injects = result.catch(() => undefined);
    return result;
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    ended = true;
    answer.resolve(voiceError("voice-refused"));
    wake();
    stopping = (async () => {
      await Promise.all(
        [...pending.values()].map((entry) => entry.finish(false, "The call ended.")),
      );
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
          if (
            message.id !== undefined &&
            input.agent &&
            message.method === "item/tool/call" &&
            isRecord(message.params) &&
            message.params.threadId === threadId
          ) {
            const id = message.id;
            const params = message.params;
            const schema =
              params.tool === "show"
                ? z.strictObject({ link: z.string().min(1).max(16_000) })
                : params.tool === "send_to_chat"
                  ? z.strictObject({ messages: z.number().int().min(1).max(5).default(1) })
                  : undefined;
            const parsed = schema?.safeParse(params.arguments);
            const respond = (ok: boolean, text: string) =>
              client!
                .respond(id, { success: ok, contentItems: [{ type: "inputText", text }] })
                .catch(abort);
            if (!parsed?.success || ended || pending.size >= 8) {
              void respond(
                false,
                ended
                  ? "The call ended."
                  : pending.size >= 8
                    ? "Too many pending requests."
                    : "Unknown tool or invalid input.",
              );
              return;
            }
            const callId = randomUUID();
            const call: VoiceToolCall = {
              id: callId,
              tool: String(params.tool),
              input: parsed.data,
            };
            const timer = setTimeout(() => {
              void finish(
                false,
                "The person's device didn't answer, so it's unknown whether this happened.",
              );
            }, voiceToolCallTimeoutMs);
            const finish = async (ok: boolean, text: string) => {
              if (!pending.delete(callId)) return;
              clearTimeout(timer);
              await respond(ok, text);
            };
            pending.set(callId, { call, finish });
            wake();
            return;
          }
          if (message.id !== undefined) {
            void client
              ?.respondError(message.id, -32601, "Interactions are disabled for voice")
              .catch(() => undefined);
            abort();
            return;
          }
          if (!isRecord(message.params) || message.params.threadId !== threadId) return;
          if (message.method === "turn/started" && !input.agent) {
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
          dynamicTools: input.agent ? voiceAgentTools : [],
          selectedCapabilityRoots: [],
          environments: [],
          runtimeWorkspaceRoots: [],
          baseInstructions: input.agent
            ? VOICE_AGENT_INSTRUCTIONS
            : "You only acknowledge speech and relay messages. Never use tools or do work.",
          developerInstructions: "",
          config: input.agent ? { ...config, model_reasoning_effort: "low" } : config,
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
          ...(!input.agent ? { clientManagedHandoffs: true, prompt: VOICE_PROMPT } : {}),
          includeStartupContext: false,
          outputModality: "audio",
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
        if (input.agent)
          await inject(`The voice just told the person this on Chat's behalf:\n${text}`);
      } catch {
        await stop();
        throw voiceError("voice-ended");
      }
    };
    return {
      answer: sdp,
      closed: closed.promise,
      say: relay,
      stop,
      next: async (signal) => {
        if (!input.agent || ended) throw voiceError("voice-ended");
        signal.throwIfAborted();
        if (!pending.size)
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              clearTimeout(timer);
              waiters.delete(done);
              signal.removeEventListener("abort", cancelled);
            };
            const done = () => {
              cleanup();
              resolve();
            };
            const cancelled = () => {
              cleanup();
              reject(signal.reason);
            };
            const timer = setTimeout(done, voiceNextHoldMs);
            waiters.add(done);
            signal.addEventListener("abort", cancelled, { once: true });
          });
        if (ended) throw voiceError("voice-ended");
        return pending.values().next().value?.call ?? null;
      },
      answerCall: async (id, ok, text) => {
        await pending.get(id)?.finish(ok, text);
      },
      context: (text) => {
        if (!input.agent || ended) return Promise.reject(voiceError("voice-ended"));
        return inject(`What the person sees now:\n${text}`, text);
      },
    };
  } catch (error) {
    await stop();
    const unsupported =
      error instanceof OpensteerError &&
      (error.details?.rpcCode === -32601 ||
        /method not found|unknown method/iu.test(error.message));
    throw voiceError(unsupported ? "voice-engine-unsupported" : "voice-refused");
  }
}
