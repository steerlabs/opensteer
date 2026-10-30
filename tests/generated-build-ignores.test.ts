import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getFileInfo } from "prettier";
import { expect, it } from "vitest";
import { z } from "zod";

it("keeps nested Swift output out of formatting and linting while checking ordinary source", async () => {
  const repository = path.resolve(import.meta.dirname, "..");
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-generated-ignores-"));
  const lint = () =>
    spawnSync(path.join(repository, "node_modules/.bin/oxlint"), [".", "--deny-warnings"], {
      cwd: root,
      encoding: "utf8",
    });
  const info = (file: string) =>
    getFileInfo(path.join(root, file), { ignorePath: path.join(root, ".prettierignore") });
  try {
    await copyFile(path.join(repository, ".prettierignore"), path.join(root, ".prettierignore"));
    const configPath = path.join(repository, ".oxlintrc.json");
    const config = z
      .object({
        jsPlugins: z
          .array(z.union([z.string(), z.object({ specifier: z.string() }).passthrough()]))
          .optional(),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(configPath, "utf8")));
    // Ignore patterns belong to the fixture tree, but plugin dependencies belong to the repo.
    const resolvePlugin = createRequire(configPath).resolve;
    const jsPlugins = config.jsPlugins?.map((plugin) =>
      typeof plugin === "string"
        ? resolvePlugin(plugin)
        : { ...plugin, specifier: resolvePlugin(plugin.specifier) },
    );
    await writeFile(path.join(root, ".oxlintrc.json"), JSON.stringify({ ...config, jsPlugins }));
    for (const folder of [
      "apps/mobile/modules/iphone-apps/ios",
      "packages/apple-data",
      "apps/desktop/native/passwords",
    ]) {
      const generated = `${folder}/.build/out/Intermediates.noindex/generated.js`;
      await mkdir(path.dirname(path.join(root, generated)), { recursive: true });
      await writeFile(path.join(root, generated), "export const generated = ;\n");
      expect((await info(generated)).ignored, generated).toBe(true);
    }
    const source = "apps/mobile/src/example.js";
    await mkdir(path.dirname(path.join(root, source)), { recursive: true });
    await writeFile(path.join(root, source), "export const source = 1;\n");
    expect((await info(source)).ignored).toBe(false);
    const ignored = lint();
    expect(ignored.status, ignored.stdout + ignored.stderr).toBe(0);
    await writeFile(path.join(root, source), "export const source = ;\n");
    expect(lint().status).toBe(1);
    await writeFile(path.join(root, source), "export const source = 1;\n");
    await writeFile(
      path.join(root, "apps/mobile/src/example.test.ts"),
      "await new Promise(resolve => setTimeout(resolve, 10));\n",
    );
    const wait = lint();
    expect(wait.status, wait.stdout + wait.stderr).toBe(1);
    expect(wait.stdout + wait.stderr).toContain("no-real-time-wait-in-tests");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
