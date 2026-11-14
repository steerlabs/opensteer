import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readAgentHomeSettings, watchAgentHomeSettings } from "./agent-home-settings.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function home() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "agent-home-settings-")));
  homes.push(path);
  return path;
}

it("reads settings.json and says exactly where a broken one is wrong", async () => {
  const path = await home();
  const file = join(path, "settings.json");
  expect(await readAgentHomeSettings(path)).toEqual({ status: "missing" });
  await writeFile(file, JSON.stringify({ backgroundModels: { light: [{ engine: "codex" }] } }));
  expect(await readAgentHomeSettings(path)).toEqual({
    status: "valid",
    settings: { backgroundModels: { light: [{ engine: "codex" }] } },
  });
  await writeFile(file, '{\n  "backgroundModels": {\n    "light": [,]\n  }\n}');
  expect(await readAgentHomeSettings(path)).toMatchObject({
    status: "invalid",
    error: { path: file, line: 3, column: 15, message: "Unexpected token ','" },
  });
  await writeFile(file, "");
  expect(await readAgentHomeSettings(path)).toMatchObject({
    status: "invalid",
    error: { path: file, line: 1, column: 1, message: "Unexpected end of JSON input" },
  });
  await writeFile(file, JSON.stringify({ backgroundModels: { light: [{ engine: "nope" }] } }));
  expect(await readAgentHomeSettings(path)).toEqual({
    status: "invalid",
    error: { path: file, at: "backgroundModels.light.0.engine", message: "Unknown engine" },
  });
  await rm(file);
  const elsewhere = join(await home(), "secret.json");
  await writeFile(elsewhere, "{}");
  await symlink(elsewhere, file);
  expect(await readAgentHomeSettings(path)).toMatchObject({
    status: "invalid",
    error: { path: file, message: "It must be a regular file, not a link or a folder" },
  });
});

it("notices settings.json replaced the way editors and agents write it, and nothing else", async () => {
  const path = await home();
  const changed = vi.fn();
  const stop = watchAgentHomeSettings(path, changed);
  try {
    await mkdir(join(path, "notes"));
    await writeFile(join(path, "notes", "today.md"), "plan");
    await writeFile(join(path, "settings.json.tmp"), "{}");
    await rename(join(path, "settings.json.tmp"), join(path, "settings.json"));
    await vi.waitFor(
      () => expect(changed, "the replaced settings.json went unnoticed").toHaveBeenCalled(),
      {
        timeout: 5_000,
      },
    );
  } finally {
    stop();
  }
});
