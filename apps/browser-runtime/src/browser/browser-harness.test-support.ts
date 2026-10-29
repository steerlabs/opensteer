import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CdpParameters } from "@opensteer/browser-core";
import type { BrowserClientMessage, BrowserServerMessage } from "@opensteer/protocol";
import type { FakeSink } from "@opensteer/browser-runtime-core/test-support";
import { browserTestSignal, withBrowserTestSignal } from "./browser-test-lifecycle.js";

export const harnessScript = fileURLToPath(
  new URL("../../../runner/browser-harness/browser-harness.mjs", import.meta.url),
);

export { HarnessRunError } from "@opensteer/browser-runtime-core/test-support/harness-transport";
import {
  startHarnessBridge as startBridge,
  runHarnessExecutable,
} from "@opensteer/browser-runtime-core/test-support/harness-transport";

export function startHarnessBridge(
  request: (method: string, parameters?: CdpParameters, sessionId?: string) => Promise<unknown>,
  sink?: Pick<FakeSink, "sendServerImplementation">,
) {
  return startBridge(
    request,
    sink
      ? (listener) => {
          const previous = sink.sendServerImplementation;
          sink.sendServerImplementation = async (message) => {
            await previous?.(message);
            listener(message);
          };
          return () => {
            sink.sendServerImplementation = previous;
          };
        }
      : undefined,
  );
}

export function runHarness(
  url: string,
  sessionId: string,
  targetId: string | undefined,
  program: string,
  options: { readonly timeoutMs?: number; readonly onStderrLine?: (line: string) => void } = {},
) {
  return runHarnessExecutable(url, sessionId, targetId, program, {
    executable: process.execPath,
    args: [harnessScript],
    signal: browserTestSignal(),
    ...options,
  });
}

/** Speaks to a session as the Host's broker does for Browser Harness. */
export async function sendAsAgent(
  deliver: (message: BrowserClientMessage) => Promise<void>,
  messages: readonly BrowserServerMessage[],
  method: string,
  parameters?: CdpParameters,
  sessionId?: string,
): Promise<unknown> {
  const requestId = randomUUID();
  await withBrowserTestSignal(
    deliver({
      command: {
        method,
        ...(parameters ? { parameters: { ...parameters } } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
      requestId,
      type: "cdp.command",
    }),
  );
  const reply = messages.find(
    (message) =>
      (message.type === "cdp.result" || message.type === "cdp.error") &&
      message.requestId === requestId,
  );
  if (reply?.type === "cdp.error")
    throw Object.assign(new Error(reply.error.message), {
      code: reply.error.code,
      reason: reply.error.reason,
    });
  if (reply?.type !== "cdp.result") throw new Error(`${method} was not answered.`);
  return reply.result;
}
