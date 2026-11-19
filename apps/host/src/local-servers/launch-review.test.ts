import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPluginSnapshot,
  readVerifiedPluginSnapshot,
  snapshotLocalServerPackage,
} from "@opensteer/agent-plugins";
import { createId } from "@opensteer/core";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";
import type { LocalMcpLaunch } from "@opensteer/integration-core/local-mcp";
import { launchReview } from "./launch-review.js";
import { pendingLocalServer } from "./local-server-service.js";

/**
 * A local server's approval names one launch by digest, and its launch names the package of its
 * folder by the digest of those files: what the person allowed is what runs.
 */
const work: string[] = [];
afterEach(async () => {
  for (const directory of work.splice(0)) await rm(directory, { recursive: true, force: true });
});
const runnerId = createId("runner");
const pluginId = "inst_fixture";

async function registered(
  files: Readonly<Record<string, string>>,
  launch: { command: string; args: string[]; env: Record<string, string> } = {
    command: "python3",
    args: ["server.py"],
    env: { TV_HOST: "10.0.0.4", TV_MODEL: "living-room" },
  },
  touched = new Date("2026-01-01T00:00:00Z"),
) {
  const root = await mkdtemp(join(tmpdir(), "launch-review-"));
  work.push(root);
  const folder = join(root, "folder");
  await mkdir(join(folder, "lib"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(folder, path), content, { mode: 0o644 });
    await utimes(join(folder, path), touched, touched);
  }
  const plugin = await snapshotLocalServerPackage({
    pluginId,
    dataDirectory: join(tmpdir(), "launch-review-data"),
    directory: folder,
    registration: { name: "living-room-tv", launch },
  });
  const server = pendingLocalServer(plugin.servers[0]!, runnerId, basename(plugin.root), pluginId);
  if (server.transport.type !== "runner") throw new Error("A local server runs on a computer");
  return {
    root: plugin.root,
    digest: basename(plugin.root),
    launch: server.transport.launch as LocalMcpLaunch,
    files: await readPluginSnapshot(plugin.root),
  };
}

const server = "import tv\nprint('on')\n";
const util = "def volume(level):\n    return level\n";

describe("a local server's approved digest", () => {
  it("is the same for the same files and launch, whenever written and in whatever order", async () => {
    const first = await registered({ "server.py": server, "lib/util.py": util });
    const later = await registered(
      { "lib/util.py": util, "server.py": server },
      {
        command: "python3",
        args: ["server.py"],
        env: { TV_MODEL: "living-room", TV_HOST: "10.0.0.4" },
      },
      new Date("2026-06-01T12:00:00Z"),
    );
    expect(later.digest).toBe(first.digest);
    expect(localMcpLaunchDigest(later.launch)).toBe(localMcpLaunchDigest(first.launch));
  });

  it("changes with a file's bytes and with the command", async () => {
    const approved = await registered({ "server.py": server, "lib/util.py": util });
    const edited = await registered({ "server.py": server + "tv.reboot()\n", "lib/util.py": util });
    const command = await registered(
      { "server.py": server, "lib/util.py": util },
      {
        command: "python3",
        args: ["-u", "server.py"],
        env: { TV_HOST: "10.0.0.4", TV_MODEL: "living-room" },
      },
    );
    const digests = new Set(
      [approved, edited, command].map(({ launch }) => localMcpLaunchDigest(launch)),
    );
    expect(digests.size).toBe(3);
  });
});

describe("the approval Request of a local server", () => {
  it("says what allowing covers, and that a program from elsewhere is covered by its command only", async () => {
    const first = await registered({ "server.py": server, "lib/util.py": util });
    const review = await launchReview({
      launch: first.launch,
      approvedLaunchDigest: null,
      versions: [first.digest],
      files: async () => first.files,
    });
    expect(review).toBe(
      "Allowing it covers this command and the 2 files in its folder (58 B); a program it starts from elsewhere on this computer is covered by its command only.",
    );
  });

  it("says which files changed since it was allowed, by how much, and the first changed line", async () => {
    const approved = await registered({ "server.py": server, "lib/util.py": util, "old.py": "x" });
    const edited = await registered({
      "server.py": "import tv\nprint('on')\ntv.reboot()\n",
      "lib/util.py": "def volume(level):\n    return min(level, 40)\n",
      "new.py": "import os\n",
    });
    const packages = new Map([
      [approved.digest, approved.files],
      [edited.digest, edited.files],
    ]);
    const review = await launchReview({
      launch: edited.launch,
      approvedLaunchDigest: localMcpLaunchDigest(approved.launch),
      versions: [approved.digest, edited.digest],
      files: async (digest) => packages.get(digest) ?? null,
    });
    expect(review).toBe(
      "Changed since you allowed it: lib/util.py 36 B → 45 B, line 2 now “return min(level, 40)” (was “return level”); added new.py (10 B); removed old.py; server.py 22 B → 34 B, line 3 now “tv.reboot()”. Allowing it covers this command and the 3 files in its folder (89 B); a program it starts from elsewhere on this computer is covered by its command only.",
    );
  });

  it("says when how it runs changed, and nothing when the launch is the one allowed", async () => {
    const approved = await registered({ "server.py": server });
    const command = await registered(
      { "server.py": server },
      { command: "python3", args: ["-u", "server.py"], env: {} },
    );
    const files = async () => approved.files;
    expect(
      await launchReview({
        launch: command.launch,
        approvedLaunchDigest: localMcpLaunchDigest(approved.launch),
        versions: [approved.digest],
        files,
      }),
    ).toMatch(/^How it runs changed since you allowed it\. Allowing it covers this command/u);
    expect(
      await launchReview({
        launch: approved.launch,
        approvedLaunchDigest: localMcpLaunchDigest(approved.launch),
        versions: [approved.digest],
        files,
      }),
    ).toMatch(/^Allowing it covers this command and the 1 file in its folder/u);
  });

  it("refuses a package altered on this Host since it was registered", async () => {
    const first = await registered({ "server.py": server });
    const files = (digest: string) =>
      readVerifiedPluginSnapshot(join(dirname(first.root), digest), digest).catch(() => null);
    const review = () =>
      launchReview({ launch: first.launch, approvedLaunchDigest: null, versions: [], files });
    await expect(review()).resolves.toMatch(/^Allowing it covers/u);
    await writeFile(join(first.root, "server.py"), "import os\n");
    await expect(review()).rejects.toMatchObject({
      code: "conflict",
      message:
        "Its files on this Host no longer match what was registered, so it can't be allowed.",
    });
  });
});
