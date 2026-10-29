import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getFileInfo } from "prettier";
import { expect, it } from "vitest";

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
    await copyFile(path.join(repository, ".oxlintrc.json"), path.join(root, ".oxlintrc.json"));
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
