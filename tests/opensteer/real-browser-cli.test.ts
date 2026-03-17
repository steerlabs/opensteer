import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, test } from "vitest";

import {
  parseOpensteerLocalProfileArgs,
  runOpensteerLocalProfileCli,
} from "../../packages/opensteer/src/cli/local-profile.js";
import {
  parseOpensteerProfileUploadArgs,
} from "../../packages/opensteer/src/cli/profile-upload.js";
import { ensureCliArtifactsBuilt } from "./cli-artifacts.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");

beforeAll(async () => {
  await ensureCliArtifactsBuilt();
});

describe("local browser CLI surfaces", () => {
  test("parses local-profile list mode with json output", () => {
    expect(parseOpensteerLocalProfileArgs(["list", "--json"])).toEqual({
      mode: "list",
      json: true,
    });
  });

  test("local-profile runner prints discovered profiles with user-data-dir", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-local-profile-cli-"));
    await writeFile(
      path.join(userDataDir, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Personal" },
          },
        },
      }),
    );

    const stdout: string[] = [];
    const code = await runOpensteerLocalProfileCli(["list", "--user-data-dir", userDataDir], {
      writeStdout: (message) => {
        stdout.push(message);
      },
      writeStderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout.join("")).toContain(`Default\tPersonal\t${userDataDir}`);
  });

  test("parses profile upload args", () => {
    expect(
      parseOpensteerProfileUploadArgs([
        "upload",
        "--profile-id",
        "bp_123",
        "--from-user-data-dir",
        "/tmp/chrome",
        "--profile-directory",
        "Profile 1",
        "--json",
      ]),
    ).toEqual({
      mode: "upload",
      json: true,
      profileId: "bp_123",
      fromUserDataDir: "/tmp/chrome",
      profileDirectory: "Profile 1",
    });
  });

  test("profile upload parser requires a profile id", () => {
    expect(
      parseOpensteerProfileUploadArgs([
        "upload",
        "--from-user-data-dir",
        "/tmp/chrome",
      ]),
    ).toEqual({
      mode: "error",
      error: "--profile-id is required.",
    });
  });

  test("built CLI local-profile command lists profiles", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-cli-local-profile-"));
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-cli-user-data-"));
    await writeFile(
      path.join(userDataDir, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            "Profile 1": { name: "Work" },
          },
        },
      }),
    );

    const result = await execFile(
      process.execPath,
      [
        CLI_SCRIPT,
        "local-profile",
        "list",
        "--user-data-dir",
        userDataDir,
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
        },
        maxBuffer: 1024 * 1024,
      },
    );

    expect(result.stderr.trim()).toBe("");
    expect(result.stdout).toContain(`Profile 1\tWork\t${userDataDir}`);
  });
});
