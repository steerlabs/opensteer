import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../scripts/install-beta-mac-local.js";
import { prepareLocalMac, type MacContext } from "../scripts/release-beta-mac.js";

vi.mock("../scripts/release-beta-mac.js", async (original) => ({
  ...(await original<typeof import("../scripts/release-beta-mac.js")>()),
  preflightLocalMac: vi.fn(),
  prepareLocalMac: vi.fn(),
  installLocalMac: vi.fn(),
  verifyLocalMac: vi.fn(),
}));
vi.mock("../scripts/release-agent-phone.js", async (original) => ({
  ...(await original<typeof import("../scripts/release-agent-phone.js")>()),
  preflightAgentPhone: vi.fn(),
}));

const execute = promisify(execFile);
let directory: string | undefined;
afterEach(async () => {
  vi.clearAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it("builds and resumes the exact source's derived version through the canonical stamp", async () => {
  directory = await mkdtemp(path.join(tmpdir(), "opensteer-local-version-"));
  const source = path.join(directory, "repository");
  const stateDirectory = path.join(directory, "state");
  const applications = path.join(directory, "Applications");
  await mkdir(source);
  await mkdir(applications);
  const git = async (...args: string[]) =>
    (await execute("git", ["-C", source, ...args])).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.test");
  await writeFile(path.join(source, "package.json"), '{"version":"0.1.10"}\n');
  await git("add", "package.json");
  await git("commit", "--quiet", "-m", "base");
  await writeFile(path.join(source, "change.txt"), "release input\n");
  await git("add", "change.txt");
  await git("commit", "--quiet", "-m", "change");
  const revision = await git("rev-parse", "HEAD");
  const binary = { path: path.join(directory, "binary"), sha256: "a".repeat(64), version: "1" };
  const config = path.join(directory, "install.json");
  await writeFile(
    config,
    JSON.stringify({
      stateDirectory,
      agentPhone: {
        keystorePath: path.join(directory, "fixture.p12"),
        keyAlias: "fixture",
        keychainService: "fixture",
        sdkDirectory: path.join(directory, "sdk"),
      },
      runtimeInputs: {
        postgres: path.join(directory, "postgres"),
        node: path.join(directory, "node"),
      },
      mac: {
        architecture: "arm64",
        signingIdentity: "Fixture",
        supervisor: binary,
        cloudflared: binary,
        passwordsProvisioningProfile: path.join(directory, "fixture.profile"),
        targets: [
          {
            id: "local",
            stagingDirectory: path.join(directory, "staging"),
            applicationPath: path.join(applications, "Opensteer Beta.app"),
            runtimeStatusUrl: "http://127.0.0.1:1/healthz",
          },
        ],
      },
    }),
  );
  const run: MacContext["run"] = async (command, args, options) => {
    if (command === "pnpm") return "";
    expect(command).toBe("git");
    return (await execute(command, [...args], { cwd: options.cwd })).stdout.trim();
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await main(["--source-sha", revision, "--config", config], run, source);
    expect(vi.mocked(prepareLocalMac).mock.calls.at(-1)?.[1].identity).toEqual({
      sourceRevision: revision,
      version: "0.1.11",
    });
    const frozen = path.join(stateDirectory, revision, "source");
    expect(JSON.parse(await readFile(path.join(frozen, "package.json"), "utf8"))).toEqual({
      version: "0.1.11",
    });
    expect(
      JSON.parse(await readFile(path.join(stateDirectory, revision, "local-install.json"), "utf8")),
    ).toMatchObject({ sourceRevision: revision, version: "0.1.11", verified: true });
  }
});
