import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  bundleNodeService,
  stageRuntimeTree,
} from "../apps/desktop/scripts/build-personal-runtime.js";
import { hostProcessEntries, hostWorkerUrl } from "../apps/host/src/process-entries.js";

it("omits debugger maps while retaining runnable script code and runtime metadata within the manifest budget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-script-"));
  try {
    const source = path.join(root, "source");
    const staged = path.join(root, "staged");
    await mkdir(source);
    for (const [name, bytes] of [
      ["cli.js", "console.log('fixture');"],
      ["cli.js.map", "{}"],
      ["package.json", '{"type":"module"}'],
    ] as const)
      await writeFile(path.join(source, name), bytes);
    const artifacts = await stageRuntimeTree(source, staged, "pi", "darwin", {
      shape: "script",
      entryScript: "pi/cli.js",
    });
    expect(artifacts).toEqual(
      expect.arrayContaining([
        { mode: "code", path: "pi/cli.js" },
        { mode: "data", path: "pi/package.json" },
      ]),
    );
    expect(await readdir(path.join(staged, "pi"))).toEqual(["cli.js", "package.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("ships each Host worker where the bundled Host starts it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-host-"));
  const hostDirectory = path.join(import.meta.dirname, "../apps/host");
  try {
    // The main module's contents do not matter here: only where its workers land.
    const main = path.join(root, "main.ts");
    await writeFile(main, "export {};");
    const script = path.join(root, "services", "host.mjs");
    await bundleNodeService(
      script,
      "host",
      main,
      Object.fromEntries(
        Object.entries(hostProcessEntries.workers).map(([name, entry]) => [
          name,
          path.join(hostDirectory, entry),
        ]),
      ),
    );
    const worker = new Worker(hostWorkerUrl("computer-repl-worker", pathToFileURL(script).href));
    try {
      const messages: unknown[] = [];
      const done = new Promise<{ readonly error?: unknown }>((resolve, reject) => {
        worker.on("message", (message: { readonly type?: string; readonly error?: unknown }) => {
          messages.push(message);
          if (message.type === "done") resolve(message);
        });
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`The computer worker exited (${code})`)));
      });
      worker.postMessage({ type: "execute", context: "c", callId: "c", code: "return 42" });
      const result = await withTimeout(done, 2_000, {
        timeoutError: () => new Error("The bundled computer worker never finished a call"),
      });
      expect(result.error).toBeUndefined();
      expect(messages).toContainEqual({ type: "text", context: "c", callId: "c", text: "42" });
    } finally {
      await worker.terminate();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
