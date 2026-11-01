import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  harnessCatalog,
  harnessExecutableEnvironmentVariable,
  shipsHarnessRuntimeBytes,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  computerConnectionCommands,
  runnerDistribution,
  runnerDistributionPrefix,
  runnerImage,
  runnerImageReference,
} from "./connection-commands.js";

const revision = "9c1f0a3b5d7e2468acbd1357024689fedcba9753";
const base = {
  enrollmentId: "ren_9f3c1d20-7a44-4c11-8b02-6d5e8f0a1b2c",
  hostOrigin: "https://steer.example",
  name: "Office Mac",
  runnerDistribution: `https://artifacts.opensteer.example/runner/sha-${revision}`,
  token: "token-with-more-than-thirty-two-characters",
} as const;

describe("computerConnectionCommands", () => {
  it("uses the runner repository published by the container release", () => {
    const revision = import.meta.env.OPENSTEER_SOURCE_REVISION;
    const tag = revision ? `sha-${revision}` : "local";
    expect(runnerImage).toBe(`opensteer/runner:${tag}`);
  });

  it("refuses to generate a mutable or malformed release image reference", () => {
    expect(() => runnerImageReference("latest")).toThrow(/canonical source revision/u);
  });

  it("pins the runner download to the published base URL and this exact release", () => {
    expect(runnerDistributionPrefix("https://artifacts.opensteer.example/runner/", revision)).toBe(
      `https://artifacts.opensteer.example/runner/sha-${revision}`,
    );
    expect(() =>
      runnerDistributionPrefix("https://artifacts.opensteer.example/runner", "latest"),
    ).toThrow(/canonical source revision/u);
    expect(() => runnerDistributionPrefix("http://artifacts.invalid", revision)).toThrow(
      /plain https URL/u,
    );
    // A build with no published artifacts, or no release identity, has none.
    expect(runnerDistributionPrefix("", revision)).toBeNull();
    expect(runnerDistributionPrefix("https://artifacts.opensteer.example", undefined)).toBeNull();
    expect(runnerDistribution).toBe(
      runnerDistributionPrefix(
        import.meta.env.OPENSTEER_RUNNER_ARTIFACT_BASE_URL,
        import.meta.env.OPENSTEER_SOURCE_REVISION,
      ),
    );
  });

  it("builds complete local-directory commands without FUSE privileges", () => {
    const commands = computerConnectionCommands({
      ...base,
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
    });

    expect(commands.container).toContain("OPENSTEER_LOCAL_WORKSPACE_ROOT");
    expect(commands.container).toContain("OPENSTEER_RUNNER_KIND='local'");
    expect(commands.container).not.toContain("/dev/fuse");
    expect(commands.bareHost).toContain(
      'OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH="$HOME/.opensteer/computers/9f3c1d207a444c118b026d5e8f0a1b2c/workspace-bindings.v1.json"',
    );
    expect(commands.sharedStorage).toBeNull();
  });

  it("installs the pinned runner distribution before running it", () => {
    const commands = computerConnectionCommands({
      ...base,
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
    });

    execFileSync("sh", ["-n"], { input: commands.bareHost ?? "", stdio: ["pipe", "pipe", "pipe"] });
    expect(commands.bareHost).toContain(
      `curl -fsSL "https://artifacts.opensteer.example/runner/sha-${revision}/opensteer-runner-$os-$arch.tar.gz" -o "$dir.installing/archive.tar.gz"`,
    );
    expect(commands.bareHost).toContain(
      `dir="$HOME/.opensteer/computers/9f3c1d207a444c118b026d5e8f0a1b2c/runtime/${revision}"`,
    );
    expect(commands.bareHost).toContain('exec "$dir/bin/opensteer-runner"');
    expect(commands.bareHost).toContain(
      'OPENSTEER_NATIVE_FS_HELPER="$dir/bin/opensteer-native-fs"',
    );
    expect(commands.bareHost).toContain('OPENSTEER_AGENT_SKILLS_DIRECTORY="$dir/agent-skills"');
    expect(commands.bareHost).toContain('OPENSTEER_BROWSER_HARNESS="$dir/bin/browser-harness"');
    for (const entry of harnessCatalog) {
      if (!shipsHarnessRuntimeBytes(entry)) {
        expect(commands.bareHost).not.toContain(harnessExecutableEnvironmentVariable(entry.kind));
        continue;
      }
      expect(commands.bareHost).toContain(
        `${harnessExecutableEnvironmentVariable(entry.kind)}="$dir/${entry.runtime.path}"`,
      );
    }
    // The old command ended in an executable a fresh computer does not have.
    expect(commands.bareHost).not.toMatch(/ opensteer-runner$/u);
  });

  it("executes the installer and reuses its completed runtime on a re-copy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-command-install-"));
    try {
      const bundle = join(directory, "bundle");
      const tools = join(directory, "tools");
      await mkdir(join(bundle, "bin"), { recursive: true });
      await mkdir(join(bundle, "node/bin"), { recursive: true });
      for (const entry of harnessCatalog) {
        if (!shipsHarnessRuntimeBytes(entry)) continue;
        await mkdir(dirname(join(bundle, entry.runtime.path)), { recursive: true });
      }
      await mkdir(join(bundle, "agent-skills"));
      await mkdir(tools);
      const archive = join(directory, "runner.tar.gz");
      const downloads = join(directory, "downloads");
      await writeFile(
        join(tools, "curl"),
        '#!/bin/sh\nprintf x >> "$OPENSTEER_TEST_DOWNLOADS"\ncp "$OPENSTEER_TEST_ARCHIVE" "$4"\n',
        { mode: 0o700 },
      );
      for (const file of [
        "bin/opensteer-native-fs",
        "bin/browser-harness",
        ...harnessCatalog.flatMap((entry) =>
          shipsHarnessRuntimeBytes(entry) ? [entry.runtime.path] : [],
        ),
        "node/bin/node",
      ]) {
        await writeFile(join(bundle, file), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      }
      await writeFile(
        join(bundle, "bin/opensteer-runner"),
        `#!/bin/sh
set -eu
test -x "$OPENSTEER_NATIVE_FS_HELPER"
test -x "$OPENSTEER_BROWSER_HARNESS"
${harnessCatalog
  // The command exports nothing for an engine the person installs, so the
  // Runner it starts must not be asked for one either.
  .filter(shipsHarnessRuntimeBytes)
  .map((entry) => `test -e "$${harnessExecutableEnvironmentVariable(entry.kind)}"`)
  .join("\n")}
test -x "$OPENSTEER_NODE_EXECUTABLE"
test -d "$OPENSTEER_AGENT_SKILLS_DIRECTORY"
echo "runner ready"
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(bundle, "runner-release.json"),
        JSON.stringify({ release: { sourceRevision: revision, version: "0.1.50" } }),
      );
      execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
      const commands = computerConnectionCommands({
        ...base,
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
      });
      if (!commands.bareHost) throw new Error("Expected native installation command");
      // A runtime left by an earlier release stays untouched beside this one:
      // it may still be running, and it lacks what this release names.
      const installed = join(directory, ".opensteer", "computers");
      const [slug] = /computers\/([^/"]+)/u.exec(commands.bareHost)?.slice(1) ?? [];
      if (!slug) throw new Error("Expected the command to name its storage");
      const earlier = join(installed, slug, "runtime", "0".repeat(40));
      await mkdir(earlier, { recursive: true });
      await writeFile(join(earlier, "runner-release.json"), "{}");
      expect(commands.bareHost).toContain(`runtime/${revision}"`);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          execFileSync("sh", ["-c", commands.bareHost], {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: directory,
              PATH: `${tools}:${process.env.PATH}`,
              OPENSTEER_TEST_ARCHIVE: archive,
              OPENSTEER_TEST_DOWNLOADS: downloads,
            },
          }),
        ).toBe("runner ready\n");
      }
      expect(await readFile(downloads, "utf8")).toBe("x");
      expect(await readFile(join(earlier, "runner-release.json"), "utf8")).toBe("{}");
      expect(
        JSON.parse(
          await readFile(join(installed, slug, "runtime", revision, "runner-release.json"), "utf8"),
        ),
      ).toMatchObject({ release: { sourceRevision: revision } });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("offers no bare-host command when this build has no published distribution", () => {
    const commands = computerConnectionCommands({
      ...base,
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      runnerDistribution: null,
    });

    expect(commands.bareHost).toBeNull();
    expect(commands.sharedStorage?.bareHost).toBeNull();
    expect(commands.container).toContain("docker run");
  });

  it("gives every issued addition storage of its own, and the same one on a re-copy", () => {
    const first = computerConnectionCommands({
      ...base,
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
    });
    const again = computerConnectionCommands({
      ...base,
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
    });
    const second = computerConnectionCommands({
      ...base,
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
      enrollmentId: "ren_41ba77e8-1c39-4f7a-9d55-2e0c4b6a8d31",
    });

    expect(first.container).toContain(
      "--volume opensteer-computer-9f3c1d207a444c118b026d5e8f0a1b2c:/var/lib/opensteer",
    );
    expect(again.container).toBe(first.container);
    expect(again.bareHost).toBe(first.bareHost);
    expect(second.container).toContain(
      "--volume opensteer-computer-41ba77e81c394f7a9d552e0c4b6a8d31:/var/lib/opensteer",
    );
    expect(second.container).not.toContain("opensteer-computer-9f3c1d20");
    expect(second.bareHost).toContain(
      'OPENSTEER_RUNNER_DATA_DIR="$HOME/.opensteer/computers/41ba77e81c394f7a9d552e0c4b6a8d31"',
    );
    expect(second.bareHost).not.toContain("9f3c1d20");
  });

  it("keeps enrollments with the same UUID prefix on separate disks", () => {
    const commands = (enrollmentId: string) =>
      computerConnectionCommands({
        ...base,
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
        enrollmentId,
      });
    const first = commands(base.enrollmentId);
    const second = commands("ren_9f3c1d20-7a44-4c11-8b02-6d5e8f0a1b2d");
    expect(first.container).not.toBe(second.container);
    expect(first.bareHost).not.toBe(second.bareHost);
  });

  it("refuses to generate a command without the issued enrollment id", () => {
    expect(() =>
      computerConnectionCommands({
        ...base,
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
        enrollmentId: "ren_",
      }),
    ).toThrow(/issued enrollment/u);
  });

  it("still lends a local-only computer to a deployment that defaults to shared storage", () => {
    const commands = computerConnectionCommands({
      ...base,
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
    });

    expect(commands.container).not.toContain("/dev/fuse");
    expect(commands.container).not.toContain("OPENSTEER_PORTABLEFS_MOUNT_BINARY");
    expect(commands.bareHost).toContain("OPENSTEER_RUNNER_WORKSPACE_BACKINGS='local-directory'");
    expect(commands.bareHost).toContain("OPENSTEER_DEFAULT_WORKSPACE_BACKING='portablefs'");
    expect(commands.bareHost).toContain("OPENSTEER_LOCAL_WORKSPACE_ROOT");
  });

  it("adds only the portable filesystem requirements to the shared-storage variant", () => {
    const commands = computerConnectionCommands({
      ...base,
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
    });
    const shared = commands.sharedStorage;
    if (!shared) throw new Error("A portablefs deployment offers a shared-storage variant.");

    expect(shared.container).toContain("--device /dev/fuse --cap-add SYS_ADMIN");
    expect(shared.container).toContain(
      "OPENSTEER_PORTABLEFS_MOUNT_BINARY='/opt/portablefs/portablefs'",
    );
    expect(shared.container).toContain(
      "--volume /usr/local/bin/portablefs:/opt/portablefs/portablefs:ro",
    );
    expect(shared.container).toContain("OPENSTEER_PORTABLEFS_MOUNT_SHA256=");
    expect(shared.bareHost).toContain(
      "OPENSTEER_RUNNER_WORKSPACE_BACKINGS='local-directory,portablefs'",
    );
    expect(shared.bareHost).toContain(
      'OPENSTEER_LOCAL_WORKSPACE_ROOT="$HOME/.opensteer/computers/9f3c1d207a444c118b026d5e8f0a1b2c/workspaces"',
    );
    // A mounted cloud Workspace must not land inside this computer's own folders.
    expect(shared.bareHost).toContain(
      'OPENSTEER_RUNNER_WORKSPACE_ROOT="$HOME/.opensteer/computers/9f3c1d207a444c118b026d5e8f0a1b2c/mounts"',
    );
  });

  it("does not expand shell expressions in names that start with a home path", () => {
    const commands = computerConnectionCommands({
      ...base,
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
      name: "$HOME/$(touch injected)",
    });
    expect(commands.bareHost).toContain("OPENSTEER_RUNNER_NAME='$HOME/$(touch injected)'");
    expect(commands.container).toContain("OPENSTEER_RUNNER_NAME='$HOME/$(touch injected)'");
  });

  it("quotes names and tokens as shell data", () => {
    const commands = computerConnectionCommands({
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      enrollmentId: base.enrollmentId,
      hostOrigin: base.hostOrigin,
      name: "Pat's laptop",
      runnerDistribution: base.runnerDistribution,
      token: "token-with-'quote'-and-more-than-thirty-two-characters",
    });

    expect(commands.bareHost).toContain(`OPENSTEER_RUNNER_NAME='Pat'"'"'s laptop'`);
    expect(commands.container).toContain(
      `OPENSTEER_RUNNER_ENROLLMENT_TOKEN='token-with-'"'"'quote'`,
    );
  });
});
