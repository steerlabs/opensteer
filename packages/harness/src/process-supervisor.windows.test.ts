import { withTimeout } from "@opensteer/shared/withTimeout";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { spawnSupervised } from "./process-supervisor.js";

it("lets a Node service finish its shutdown when the supervisor stops it with CTRL_BREAK", async () => {
  const service = spawnSupervised({
    args: [
      "--import",
      "tsx",
      fileURLToPath(new URL("./graceful-service.test-support.ts", import.meta.url)),
    ],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    environment: process.env as Record<string, string>,
    executable: process.execPath,
    output: "raw",
    stdin: "closed",
  });
  let output = "";
  const ready = Promise.withResolvers<void>();
  const read = (async () => {
    for await (const chunk of service.stdout) {
      output += chunk.toString("utf8");
      if (output.includes("ready\n")) ready.resolve();
    }
    ready.reject(new Error(`The service exited before it was ready: ${output}`));
  })();
  try {
    await withTimeout(ready.promise, 30_000, {
      timeoutError: () => new Error("The service never reported ready"),
    });
    // Unhandled, CTRL_BREAK ends Node at once with STATUS_CONTROL_C_EXIT, not 0.
    await service.terminate(10_000);
    await expect(service.exited).resolves.toEqual({ code: 0, signal: null });
    await read;
    expect(output).toContain("closed on SIGBREAK");
  } finally {
    await service.terminate(0);
  }
});
