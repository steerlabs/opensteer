import { OpensteerError } from "@opensteer/core";
import { spawnSupervised, type HarnessProcessLaunch } from "@opensteer/harness";
import { normalizeAcpUpdate } from "./adapter.js";
import {
  acpProtocolOutputBytes,
  closeAcpSessionBestEffort,
  createAcpProtocolClient,
} from "./protocol.js";
import type { AcpProtocolVersion } from "./types.js";

const maximumTitleOutputCharacters = 64_000;

/**
 * Runs one tool-free ACP prompt in a process the caller has already contained.
 * The process and native session are closed before this resolves; the caller
 * can then remove its scratch workspace and provider state without racing it.
 */
export async function generateContainedAcpTitle(input: {
  readonly authenticationMethod?: string;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly initializeDeadlineMs: number;
  readonly launch: HarnessProcessLaunch;
  readonly modeId: string;
  readonly onSessionId?: (sessionId: string) => void;
  readonly prompt: string;
  readonly protocolVersion: AcpProtocolVersion;
  readonly sessionMetadata?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly transformStdout?: (stdout: AsyncIterable<Buffer>) => AsyncIterable<Buffer>;
}): Promise<{ readonly sessionId: string; readonly text: string }> {
  input.signal.throwIfAborted();
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(input.signal.reason ?? new Error("Title generation canceled"));
  input.signal.addEventListener("abort", abort, { once: true });
  const process = spawnSupervised({
    ...input.launch,
    maxOutputBytes: acpProtocolOutputBytes,
    signal: lifetime.signal,
  });
  let output = "";
  let attemptedTool = false;
  const client = createAcpProtocolClient({
    handlers: {
      elicitation: async () => null,
      permission: async () => null,
      readTextFile: async () => {
        throw new OpensteerError({
          code: "forbidden",
          message: "ACP title generation cannot read files",
        });
      },
      update: (_sessionId, update) => {
        for (const normalized of normalizeAcpUpdate(update)) {
          if (normalized.kind === "assistant") {
            if (output.length + normalized.text.length > maximumTitleOutputCharacters) {
              lifetime.abort(new Error("ACP title output was too large"));
              return;
            }
            output += normalized.text;
          } else if (normalized.kind === "tool" || normalized.kind === "subagent") {
            attemptedTool = true;
          }
        }
      },
    },
    process,
    ...(input.transformStdout ? { stdout: input.transformStdout(process.stdout) } : {}),
    version: input.protocolVersion,
  });
  const stderr = (async () => {
    for await (const _chunk of process.stderr) {
      // Provider stderr can contain authentication URLs; it is intentionally discarded.
    }
  })();
  let sessionId: string | undefined;
  try {
    const inspection = await client.initialize({
      capabilities: { elicitation: false, fileSystem: "none", terminal: false },
      deadlineMs: input.initializeDeadlineMs,
      info: input.clientInfo,
      signal: lifetime.signal,
    });
    if (inspection.protocolVersion !== input.protocolVersion) {
      throw new OpensteerError({
        code: "harness_error",
        message: `ACP engine negotiated protocol ${inspection.protocolVersion}, expected ${input.protocolVersion}`,
      });
    }
    if (input.authenticationMethod) {
      await client.authenticate(input.authenticationMethod, lifetime.signal);
    }
    const session = await client.newSession(
      {
        additionalDirectories: [],
        cwd: input.launch.cwd,
        ...(input.sessionMetadata ? { metadata: input.sessionMetadata } : {}),
        mcpServers: [],
      },
      lifetime.signal,
    );
    sessionId = session.sessionId;
    input.onSessionId?.(session.sessionId);
    if (session.modes?.availableModes.some((mode) => mode.id === input.modeId)) {
      await client.setMode(session.sessionId, input.modeId, lifetime.signal);
    }
    await client.prompt(session.sessionId, [{ type: "text", text: input.prompt }], lifetime.signal);
    if (attemptedTool) {
      throw new OpensteerError({
        code: "harness_error",
        message: "ACP attempted tool work while naming the Thread",
      });
    }
    const text = output.trim();
    if (!text) {
      throw new OpensteerError({ code: "harness_error", message: "ACP returned no Thread title" });
    }
    return { sessionId: session.sessionId, text };
  } finally {
    if (sessionId) await closeAcpSessionBestEffort(client, sessionId);
    client.close();
    lifetime.abort(new Error("Title generation finished"));
    await process.terminate().catch(() => undefined);
    await process.exited.catch(() => undefined);
    await stderr.catch(() => undefined);
    input.signal.removeEventListener("abort", abort);
  }
}
