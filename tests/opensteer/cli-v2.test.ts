import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { ensureCliArtifactsBuilt } from "./cli-artifacts.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");

describe("Opensteer v2 CLI", () => {
  test("prints workspace-centric help", async () => {
    await ensureCliArtifactsBuilt();

    const result = await execFile("node", [CLI_SCRIPT, "--help"], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 4,
    });

    expect(result.stdout).toContain("Opensteer v2 CLI");
    expect(result.stdout).toContain("--workspace <id>");
    expect(result.stdout).toContain("--browser temporary|persistent|attach");
    expect(result.stdout).toContain("browser clone --workspace <id> --source-user-data-dir <path>");
    expect(result.stdout).not.toContain("snapshot-session");
    expect(result.stdout).not.toContain("snapshot-authenticated");
    expect(result.stdout).not.toContain("attach-live");
    expect(result.stdout).not.toContain("--name");
  });

  test("reports persistent browser status inside a repo-local workspace", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-v2-"));

    const result = await execFile(
      "node",
      [CLI_SCRIPT, "browser", "status", "--workspace", "github-sync"],
      {
        cwd,
        maxBuffer: 1024 * 1024 * 4,
      },
    );

    const parsed = JSON.parse(result.stdout) as {
      readonly mode: string;
      readonly workspace?: string;
      readonly live: boolean;
      readonly rootPath: string;
      readonly browserPath?: string;
      readonly userDataDir?: string;
    };

    expect(parsed).toMatchObject({
      mode: "persistent",
      workspace: "github-sync",
      live: false,
    });
    expect(parsed.rootPath).toContain(path.join(".opensteer", "workspaces", "github-sync"));
    expect(parsed.browserPath).toBe(path.join(parsed.rootPath, "browser"));
    expect(parsed.userDataDir).toBe(path.join(parsed.rootPath, "browser", "user-data"));
  });
});
