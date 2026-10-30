import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { stageRuntimeTree } from "../apps/desktop/scripts/build-personal-runtime.js";

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
