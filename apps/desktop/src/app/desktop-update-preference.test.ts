import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadDesktopUpdatePreference } from "./desktop-update-preference.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), "update-preference-"));
  directories.push(dir);
  return dir;
}
it("defaults to stable and reloads persisted selection after restart", async () => {
  const dir = await directory();
  const preference = await loadDesktopUpdatePreference(dir, vi.fn());
  expect(preference.channel).toBe("stable");
  await preference.save("beta");
  expect(JSON.parse(await readFile(path.join(dir, "update-channel.json"), "utf8"))).toEqual({
    channel: "beta",
  });
  expect((await loadDesktopUpdatePreference(dir, vi.fn())).channel).toBe("beta");
  await preference.save("stable");
  expect((await loadDesktopUpdatePreference(dir, vi.fn())).channel).toBe("stable");
});
it.each([
  ['{"channel":"nightly"}', "invalid"],
  ['{"channel":', "corrupt"],
])("defaults safely with a fixed log reason: %s", async (content, reason) => {
  const dir = await directory();
  await writeFile(path.join(dir, "update-channel.json"), content!);
  const log = vi.fn();
  expect((await loadDesktopUpdatePreference(dir, log)).channel).toBe("stable");
  expect(log).toHaveBeenCalledWith("desktop.update.preference-defaulted", { reason });
});
