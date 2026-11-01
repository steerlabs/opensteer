import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAntigravityLaunch } from "./environment.js";

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
});
