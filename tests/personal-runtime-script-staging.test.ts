import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { expect, it } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  bundleNodeService,
  stageRuntimeTree,
  stageWorkerdWindowsLibraries,
} from "../apps/desktop/scripts/build-personal-runtime.js";
import type { ComputerReplResult } from "../apps/host/src/computer-use/computer-repl/computer-repl-service.js";
import { hostProcessEntries } from "../apps/host/src/process-entries.js";

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

it("starts the Host's computer worker from the desktop runtime bundle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-host-"));
  const hostDirectory = path.join(import.meta.dirname, "../apps/host");
  try {
    // A stand-in for the Host's main module: the real service, bundled the way
    // the runtime bundles the Host, so it locates its worker from host.mjs.
    const main = path.join(root, "main.ts");
    const service = path.join(
      hostDirectory,
      "src/computer-use/computer-repl/computer-repl-service.ts",
    );
    await writeFile(
      main,
      `import { ComputerReplService } from ${JSON.stringify(service)};
export async function run(code) {
  const service = new ComputerReplService({ invoke: async () => ({ value: [] }) });
  try {
    return await service.execute({ runId: "run_bundle", generation: 1 }, code);
  } finally {
    await service.close();
  }
}`,
    );
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
    const bundled = z
      .object({ run: z.function() })
      .parse(await import(pathToFileURL(script).href)) as {
      readonly run: (code: string) => Promise<ComputerReplResult>;
    };
    const result = await withTimeout(bundled.run("return 42"), 2_000, {
      timeoutError: () => new Error("The bundled Host's computer call never finished"),
    });
    expect(result.content).toEqual([{ type: "text", text: "42" }]);
    expect(result.isError).toBeFalsy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("places Windows workerd's Visual C++ libraries beside the executable and refuses an incomplete source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-workerd-vc-"));
  try {
    const source = path.join(root, "source");
    const staged = path.join(root, "staged");
    await mkdir(path.join(source, "bin"), { recursive: true });
    await mkdir(path.join(source, "lib"));
    const libraries = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
    for (const name of libraries)
      await writeFile(path.join(source, "bin", name.toUpperCase()), "reviewed fixture");
    const destination = "services/node_modules/@cloudflare/workerd-windows-64/bin";
    expect(await stageWorkerdWindowsLibraries(source, staged, destination)).toEqual(
      libraries.map((name) => ({ path: `${destination}/${name}`, mode: "code" })),
    );
    await rm(path.join(source, "bin", "VCRUNTIME140_1.DLL"));
    await expect(stageWorkerdWindowsLibraries(source, staged, destination)).rejects.toThrow(
      /vcruntime140_1.dll/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
