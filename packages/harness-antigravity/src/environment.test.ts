import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAntigravityLaunch, prepareAntigravityTitleLaunch } from "./environment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Antigravity launch environment", () => {
  it("isolates the profile, strips ambient Google credentials, and uses the supplied Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-profile-"));
    temporaryDirectories.push(root);
    const launch = await prepareAntigravityLaunch({
      apiKey: "account-owned-key",
      authMethod: "gemini-api-key",
      baseEnvironment: {
        AGY_ACP_ENABLE_OAUTH: "ambient",
        GEMINI_API_KEY: "ambient-secret",
        google_api_key: "case-insensitive-secret",
        GOOGLE_CLOUD_PROJECT: "ambient-project",
        PATH: "/usr/bin",
      },
      config: { gcpLocation: "", gcpProject: "" },
      nodeExecutable: "/opt/Opensteer Runtime/bin/node",
      providerState: {
        continuationKey: "profile-1",
        kind: "isolated",
        privateStateRoot: root,
        providerHomeDirectory: join(root, "profile"),
        store: { directory: join(root, "profile"), id: "profile-1" },
      },
      runtime: {
        executable: join(root, "runtime", "agy_acp_server.par"),
        harness: join(root, "runtime", "localharness_external"),
      },
    });

    expect(launch.environment).toMatchObject({
      ANTIGRAVITY_HARNESS_PATH: join(root, "runtime", "localharness_external"),
      GEMINI_API_KEY: "account-owned-key",
      GEMINI_HOME: join(root, "profile"),
      PATH: "/usr/bin",
    });
    expect(launch.environment).not.toHaveProperty("google_api_key");
    expect(launch.environment).not.toHaveProperty("GOOGLE_CLOUD_PROJECT");
    expect(launch.environment).not.toHaveProperty("AGY_ACP_ENABLE_OAUTH");
    expect(launch.environment.BROWSER).toContain("/opt/Opensteer Runtime/bin/node");
    expect(launch.environment.BROWSER).toContain("process.exit(0)");
    const settings = await readFile(
      join(root, "profile", "antigravity-acp", "settings.json"),
      "utf8",
    );
    expect(settings).not.toContain("account-owned-key");
    expect(JSON.parse(settings)).toEqual({ auth: { type: "gemini-api-key" } });
  });

  it("copies only authentication into an ephemeral title home", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-title-profile-"));
    temporaryDirectories.push(root);
    const source = join(root, "account");
    const sourceAcp = join(source, "antigravity-acp");
    const title = join(root, "title");
    await mkdir(join(source, "config", "skills"), { recursive: true });
    await mkdir(sourceAcp, { recursive: true });
    await writeFile(join(sourceAcp, "acp_token.json"), '{"token":"account-owned"}\n', {
      mode: 0o600,
    });
    await writeFile(join(sourceAcp, "hooks.json"), '{"ambient":"must-not-copy"}\n');
    await writeFile(join(source, "config", "skills", "SKILL.md"), "must not copy\n");

    const launch = await prepareAntigravityTitleLaunch({
      authMethod: "oauth-personal",
      baseEnvironment: { HOME: "/Users/person", PATH: "/usr/bin" },
      config: { gcpLocation: "", gcpProject: "" },
      directory: title,
      nodeExecutable: "/opt/Opensteer Runtime/bin/node",
      providerState: {
        continuationKey: "profile-1",
        kind: "isolated",
        privateStateRoot: root,
        providerHomeDirectory: source,
        store: { directory: source, id: "profile-1" },
      },
      runtime: {
        executable: join(root, "runtime", "agy_acp_server.par"),
        harness: join(root, "runtime", "localharness_external"),
      },
    });

    expect(launch.environment).toMatchObject({
      GEMINI_HOME: join(title, "home"),
      HOME: title,
      XDG_CONFIG_HOME: join(title, "config"),
      XDG_DATA_HOME: join(title, "data"),
    });
    expect(await readdir(join(title, "home", "antigravity-acp"))).toEqual([
      "acp_token.json",
      "settings.json",
    ]);
    await expect(
      readFile(join(title, "home", "antigravity-acp", "acp_token.json"), "utf8"),
    ).resolves.toBe('{"token":"account-owned"}\n');
  });
});
