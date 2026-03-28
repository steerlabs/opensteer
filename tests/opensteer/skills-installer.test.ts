import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createOpensteerSkillsInvocation,
  runOpensteerSkillsInstaller,
} from "../../packages/opensteer/src/cli/skills-installer.js";

describe("Opensteer skills installer", () => {
  test("defaults to the opensteer skill when no explicit selection is provided", () => {
    const invocation = createOpensteerSkillsInvocation({
      options: {
        agents: ["codex"],
        global: true,
      },
      skillsCliPath: "/tmp/skills-cli.mjs",
      skillSourcePath: "/tmp/opensteer-skills",
    });

    expect(invocation).toEqual({
      cliPath: "/tmp/skills-cli.mjs",
      cliArgs: [
        "add",
        "/tmp/opensteer-skills",
        "--skill",
        "opensteer",
        "--agent",
        "codex",
        "--global",
      ],
    });
  });

  test("does not force the opensteer skill when listing packaged skills", () => {
    const invocation = createOpensteerSkillsInvocation({
      options: {
        list: true,
      },
      skillsCliPath: "/tmp/skills-cli.mjs",
      skillSourcePath: "/tmp/opensteer-skills",
    });

    expect(invocation).toEqual({
      cliPath: "/tmp/skills-cli.mjs",
      cliArgs: ["add", "/tmp/opensteer-skills", "--list"],
    });
  });

  test("uses the resolved packaged skill directory when running", async () => {
    let receivedInvocation:
      | {
          readonly cliPath: string;
          readonly cliArgs: readonly string[];
        }
      | undefined;

    const exitCode = await runOpensteerSkillsInstaller(
      {
        yes: true,
      },
      {
        resolveSkillsCliPath: () => "/tmp/skills-cli.mjs",
        resolveSkillSourcePath: () => path.join("/tmp", "packaged-skills"),
        spawnInvocation: async (invocation) => {
          receivedInvocation = invocation;
          return 0;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(receivedInvocation).toEqual({
      cliPath: "/tmp/skills-cli.mjs",
      cliArgs: ["add", "/tmp/packaged-skills", "--skill", "opensteer", "--yes"],
    });
  });
});
