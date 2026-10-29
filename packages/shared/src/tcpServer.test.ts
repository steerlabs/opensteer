import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// A process boundary is necessary: an unowned native socket error must crash it, not the test worker.
it("the machine-access echo fixture survives a native peer reset and reaps its sockets", async ({
  signal,
}) => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./test-fixtures/reset-echo.mjs", import.meta.url))],
    { signal, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("survived peer reset");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }
  }
});
