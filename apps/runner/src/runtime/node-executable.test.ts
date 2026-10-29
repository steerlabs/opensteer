import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyNodeExecutable } from "./node-executable.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("verifyNodeExecutable", () => {
  it("accepts the real Node 24 or newer executable", async () => {
    await expect(verifyNodeExecutable(process.execPath)).resolves.toBeUndefined();
  });

  it("rejects a missing executable with the configured path", async () => {
    const directory = await temporaryDirectory();
    const executable = join(directory, "missing-node");
    await expect(verifyNodeExecutable(executable)).rejects.toThrow(
      `OPENSTEER_NODE_EXECUTABLE could not be started: ${executable}`,
    );
  });

  it("rejects an executable that reports an old Node version", async () => {
    const executable = await versionScript("v22.19.0");
    await expect(verifyNodeExecutable(executable)).rejects.toThrow(/Node 24 or newer.*v22\.19\.0/u);
  });

  it("rejects an executable that reports garbage", async () => {
    const executable = await versionScript("not node");
    await expect(verifyNodeExecutable(executable)).rejects.toThrow(/did not report/u);
  });

  it("rejects an executable that surrounds a version line with other output", async () => {
    const executable = await versionScript('printf "warning\\nv24.0.0\\n"', false);
    await expect(verifyNodeExecutable(executable)).rejects.toThrow(/exactly one stable/u);
  });

  it("rejects an executable that writes to stderr", async () => {
    const executable = await versionScript(
      'printf "v24.0.0\\n"\nprintf "loader warning\\n" >&2',
      false,
    );
    await expect(verifyNodeExecutable(executable)).rejects.toThrow(/wrote to stderr/u);
  });

  it("kills a probe that ignores termination and reports the timeout", async () => {
    const executable = await versionScript("trap '' TERM\nexec sleep 30", false);
    const startedAt = Date.now();
    await expect(verifyNodeExecutable(executable, { timeoutMs: 300 })).rejects.toThrow(
      /verification timed out/u,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("kills a probe that floods its output", async () => {
    const executable = await versionScript("exec yes v24.0.0", false);
    await expect(verifyNodeExecutable(executable, { timeoutMs: 5_000 })).rejects.toThrow(
      /too much version output/u,
    );
  });

  it("passes only HOME and PATH to the version probe", async () => {
    const executable = await versionScript(
      'if [ -n "$ELECTRON_RUN_AS_NODE" ]; then exit 9; fi\nprintf "v24.0.0\\n"',
      false,
    );
    await expect(
      verifyNodeExecutable(executable, {
        environment: {
          ELECTRON_RUN_AS_NODE: "1",
          HOME: "/tmp/opensteer-home",
          PATH: process.env.PATH,
        },
      }),
    ).resolves.toBeUndefined();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-node-executable-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function versionScript(output: string, quoteOutput = true): Promise<string> {
  const directory = await temporaryDirectory();
  const executable = join(directory, "node-version");
  const body = quoteOutput ? `printf '%s\\n' ${JSON.stringify(output)}` : output;
  await writeFile(executable, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}
