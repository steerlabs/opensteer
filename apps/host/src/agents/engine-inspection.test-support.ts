import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpHostClient, type WebSocketClient } from "@opensteer/client/host";
import { HarnessRegistry, nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { CursorHarnessDriver } from "@opensteer/harness-cursor";
import WebSocket from "ws";
import type { Clock } from "@opensteer/shared/clock";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/** A repository-owned CLI, isolated from every installed engine and account. */
export async function startEngineInspectionStack(
  databaseUrl: string,
  scratch: string,
  workspaceReconcileClock?: Clock,
) {
  const state = join(scratch, "scenario");
  const executable = join(scratch, "agent");
  const fixture = new URL(
    "../../../../packages/harness-cursor/src/test-fixtures/fake-cursor-agent.mjs",
    import.meta.url,
  ).href;
  await writeFile(state, "happy");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
process.env.FAKE_CURSOR_SCENARIO = readFileSync(${JSON.stringify(state)}, "utf8");
await import(${JSON.stringify(fixture)});
`,
  );
  await setFileMode(executable, 0o700);
  const stack = await startVerticalStack({
    databaseUrl,
    harnesses: () => {
      const registry = new HarnessRegistry();
      registry.registerDriver(
        new CursorHarnessDriver({ executable, nodeExecutable: process.execPath }),
      );
      return registry;
    },
    harnessInstance: { config: {}, driverKind: "cursor", sourceId: "cursor", stateKind: "ambient" },
    harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
    catalogTimeoutMs: 10_000,
    runTimeoutMs: 10_000,
    ...(workspaceReconcileClock ? { workspaceReconcileClock } : {}),
  });
  return { stack, state };
}

export function engineInspectionViewer(stack: VerticalStack): HttpHostClient {
  return new HttpHostClient({
    baseUrl: stack.hostOrigin,
    refreshIntervalMs: 0,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", stack.sessionCookie);
      headers.set("origin", stack.hostOrigin.origin);
      return fetch(input, { ...init, headers });
    },
    webSocketFactory: (url) =>
      new WebSocket(url, {
        headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
      }) as unknown as WebSocketClient,
  });
}
