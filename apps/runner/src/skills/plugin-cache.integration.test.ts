import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { maximumPluginPackageFiles } from "@opensteer/agent-plugins";
import { fixtureDirectories, launchFixture } from "./plugin-cache.test-support.js";

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    fixtureDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// Writes and verifies over 30,000 real files, which takes the integration lane's time.
it("launches a package of the most files a package may hold", async () => {
  const extra = Array.from({ length: maximumPluginPackageFiles - 2 }, (_, index) => ({
    path: `files/${index}`,
    mode: 0o600,
    bytes: Buffer.alloc(0),
  }));
  const f = await launchFixture(extra);
  try {
    await f.open("one");
    expect(f.frames.at(-1)?.type).toBe("runner.integrations.mcp.opened");
    expect((await readdir(join((await f.observed()).root, "files"))).length).toBe(extra.length);
  } finally {
    await f.mcp.close({ sessionId: "one" } as Parameters<typeof f.mcp.close>[0]);
    f.mcp.detach();
  }
});
