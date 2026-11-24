import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupPriorAutomationScripts } from "./script-executor.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Runner startup cleanup of crashed automation-scripts directories (AA14.7)", () => {
  it("removes leftover script and webhook-body files under privateStateDirectory/automation-scripts", async () => {
    const privateStateDirectory = await mkdtemp(join(tmpdir(), "opensteer-runner-boot-"));
    dirs.push(privateStateDirectory);
    const crashedDir = join(privateStateDirectory, "automation-scripts", "toc_crashed-1234");
    await mkdir(crashedDir, { recursive: true });
    await writeFile(join(crashedDir, "script.mjs"), "console.log('secret');\n");
    await writeFile(join(crashedDir, "webhook-body.bin"), Buffer.from("raw-webhook-payload"));

    await cleanupPriorAutomationScripts(privateStateDirectory);

    expect(existsSync(join(privateStateDirectory, "automation-scripts"))).toBe(false);
  });
});
