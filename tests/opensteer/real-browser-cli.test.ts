import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, test } from "vitest";

import {
  parseOpensteerBrowserArgs,
  runOpensteerBrowserCli,
} from "../../packages/opensteer/src/cli/browser.js";
import {
  parseOpensteerLocalProfileArgs,
  runOpensteerLocalProfileCli,
} from "../../packages/opensteer/src/cli/local-profile.js";
import { parseOpensteerProfileSyncArgs } from "../../packages/opensteer/src/cli/profile-sync.js";
import { ensureCliArtifactsBuilt } from "./cli-artifacts.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");

beforeAll(async () => {
  await ensureCliArtifactsBuilt();
}, 120_000);

describe("local browser CLI surfaces", () => {
  test("parses browser discover mode with json output", () => {
    expect(parseOpensteerBrowserArgs(["discover", "--json"])).toEqual({
      mode: "discover",
      json: true,
    });
  });

  test("parses browser inspect mode", () => {
    expect(parseOpensteerBrowserArgs(["inspect", "--endpoint", "9222"])).toEqual({
      mode: "inspect",
      endpoint: "9222",
      json: false,
    });
  });

  test("browser discover runner prints discovered endpoints", async () => {
    const stdout: string[] = [];
    const code = await runOpensteerBrowserCli(["discover"], {
      discoverBrowsers: async () => [
        {
          endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
          source: "devtools-active-port",
          userDataDir: "/tmp/chrome",
        },
      ],
      inspectBrowser: async () => ({
        endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      }),
      writeStdout: (message) => {
        stdout.push(message);
      },
      writeStderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout.join("")).toContain("ws://127.0.0.1:9222/devtools/browser/root");
    expect(stdout.join("")).toContain("devtools-active-port");
  });

  test("browser inspect runner prints structured endpoint JSON", async () => {
    const stdout: string[] = [];
    const code = await runOpensteerBrowserCli(["inspect", "--endpoint", "9222"], {
      discoverBrowsers: async () => [],
      inspectBrowser: async () => ({
        endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
        httpUrl: "http://127.0.0.1:9222/",
        port: 9222,
      }),
      writeStdout: (message) => {
        stdout.push(message);
      },
      writeStderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout.join("")).toContain('"endpoint":"ws://127.0.0.1:9222/devtools/browser/root"');
    expect(stdout.join("")).toContain(
      '"attachHint":"opensteer open --browser attach-live --attach-endpoint \\"9222\\""',
    );
  });

  test("parses local-profile list mode with json output", () => {
    expect(parseOpensteerLocalProfileArgs(["list", "--json"])).toEqual({
      mode: "list",
      json: true,
    });
  });

  test("parses local-profile inspect mode", () => {
    expect(parseOpensteerLocalProfileArgs(["inspect", "--user-data-dir", "/tmp/chrome"])).toEqual({
      mode: "inspect",
      userDataDir: "/tmp/chrome",
    });
  });

  test("parses local-profile unlock mode", () => {
    expect(parseOpensteerLocalProfileArgs(["unlock", "--user-data-dir", "/tmp/chrome"])).toEqual({
      mode: "unlock",
      userDataDir: "/tmp/chrome",
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

  test("local-profile inspect prints structured inspection JSON", async () => {
    const stdout: string[] = [];
    const code = await runOpensteerLocalProfileCli(["inspect", "--user-data-dir", "/tmp/chrome"], {
      inspectProfile: async () => ({
        status: "available",
        userDataDir: "/tmp/chrome",
      }),
      listProfiles: () => [],
      unlockProfile: async () => ({
        userDataDir: "/tmp/chrome",
        removed: [],
      }),
      writeStdout: (message) => {
        stdout.push(message);
      },
      writeStderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout.join("")).toBe(
      JSON.stringify({ status: "available", userDataDir: "/tmp/chrome" }),
    );
  });

  test("local-profile unlock prints structured JSON errors", async () => {
    const stderr: string[] = [];
    const { OpensteerLocalProfileUnavailableError } =
      await import("../../packages/opensteer/src/local-browser/profile-inspection.js");

    const code = await runOpensteerLocalProfileCli(["unlock", "--user-data-dir", "/tmp/chrome"], {
      inspectProfile: async () => ({
        status: "available",
        userDataDir: "/tmp/chrome",
      }),
      listProfiles: () => [],
      unlockProfile: async () => {
        throw new OpensteerLocalProfileUnavailableError({
          status: "available",
          userDataDir: "/tmp/chrome",
        });
      },
      writeStdout: () => undefined,
      writeStderr: (message) => {
        stderr.push(message);
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain('"code":"profile-unavailable"');
    expect(stderr.join("")).toContain('"status":"available"');
  });

  test("parses profile sync args", () => {
    expect(
      parseOpensteerProfileSyncArgs([
        "sync",
        "--profile-id",
        "bp_123",
        "--browser",
        "brave",
        "--user-data-dir",
        "/tmp/brave",
        "--profile-directory",
        "Profile 1",
        "--executable-path",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "--strategy",
        "headless",
        "--domain",
        "github.com",
        "--domain",
        ".github.com",
        "--dry-run",
        "--json",
      ]),
    ).toEqual({
      mode: "sync",
      allDomains: false,
      brandId: "brave",
      userDataDir: "/tmp/brave",
      profileDirectory: "Profile 1",
      executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      strategy: "headless",
      restoreBrowser: true,
      dryRun: true,
      domains: ["github.com"],
      yes: false,
      json: true,
      profileId: "bp_123",
    });
  });

  test("profile sync parser validates browser enum values", () => {
    expect(
      parseOpensteerProfileSyncArgs(["sync", "--profile-id", "bp_123", "--browser", "opera"]),
    ).toEqual({
      mode: "error",
      error:
        'Option "--browser" must be one of: chrome, chrome-canary, chromium, brave, edge, vivaldi, helium.',
    });
  });

  test("profile sync parser requires a profile id", () => {
    expect(parseOpensteerProfileSyncArgs(["sync", "--attach-endpoint", "9222"])).toEqual({
      mode: "error",
      error: "--profile-id is required.",
    });
  });

  test("local-profile parser rejects unknown camelCase flags", () => {
    expect(parseOpensteerLocalProfileArgs(["list", "--userDataDir", "/tmp/chrome"])).toEqual({
      mode: "error",
      error: 'unknown option "--userDataDir". Did you mean "--user-data-dir"?',
    });
  });

  test("built CLI prints root help", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-cli-help-"));

    const result = await execFile(process.execPath, [CLI_SCRIPT, "help"], {
      cwd: rootDir,
      env: {
        ...process.env,
      },
      maxBuffer: 1024 * 1024,
    });

    expect(result.stderr.trim()).toBe("");
    expect(result.stdout).toContain("Usage: opensteer <command>");
    expect(result.stdout).toContain("browser");
    expect(result.stdout).toContain("open");
    expect(result.stdout).toContain("local-profile");
  });

  test(
    "built CLI rejects unknown camelCase and command-inappropriate flags",
    { timeout: 15_000 },
    async () => {
      const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-cli-strict-"));

      await expect(
        runCliExpectFailure(rootDir, [
          "input",
          "--selector",
          "input#search",
          "--text",
          "airpods",
          "--pressEnter",
          "true",
        ]),
      ).resolves.toMatchObject({
        error: {
          message: 'unknown option "--pressEnter". Did you mean "--press-enter"?',
        },
      });

      await expect(
        runCliExpectFailure(rootDir, ["goto", "https://example.com", "--networkTag", "nav"]),
      ).resolves.toMatchObject({
        error: {
          message: 'unknown option "--networkTag". Did you mean "--network-tag"?',
        },
      });

      await expect(
        runCliExpectFailure(rootDir, ["open", "https://example.com", "--bogus", "true"]),
      ).resolves.toMatchObject({
        error: {
          message: 'unknown option "--bogus".',
        },
      });

      await expect(
        runCliExpectFailure(rootDir, ["close", "--headless", "true"]),
      ).resolves.toMatchObject({
        error: {
          message: 'unknown option "--headless".',
        },
      });
    },
  );

  test("built CLI submits input when --press-enter is provided", { timeout: 15_000 }, async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-cli-press-enter-"));
    const html = `<!doctype html><html><head><title>idle</title></head><body>
<form action="#" onsubmit="event.preventDefault(); document.querySelector('#status').textContent = document.querySelector('#search').value; document.title = 'submitted:' + document.querySelector('#search').value;">
  <input id="search" name="q" />
  <button type="submit">Go</button>
</form>
<div id="status">idle</div>
</body></html>`;
    const url = `data:text/html,${encodeURIComponent(html)}`;

    await execFile(
      process.execPath,
      [CLI_SCRIPT, "open", url, "--root-dir", rootDir, "--headless", "true"],
      {
        cwd: rootDir,
        env: {
          ...process.env,
        },
        maxBuffer: 1024 * 1024,
      },
    );

    await execFile(
      process.execPath,
      [
        CLI_SCRIPT,
        "input",
        "--selector",
        "input#search",
        "--text",
        "airpods",
        "--press-enter",
        "true",
        "--root-dir",
        rootDir,
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
        },
        maxBuffer: 1024 * 1024,
      },
    );

    const result = await execFile(
      process.execPath,
      [
        CLI_SCRIPT,
        "extract",
        "--description",
        "status",
        "--schema",
        '{"status":{"selector":"#status"},"title":{"selector":"title"}}',
        "--root-dir",
        rootDir,
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
    expect(JSON.parse(result.stdout.trim())).toEqual({
      status: "airpods",
      title: "submitted:airpods",
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
      [CLI_SCRIPT, "local-profile", "list", "--user-data-dir", userDataDir],
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

async function runCliExpectFailure(
  rootDir: string,
  args: readonly string[],
): Promise<{
  readonly error: {
    readonly message?: string;
  };
}> {
  try {
    await execFile(process.execPath, [CLI_SCRIPT, ...args], {
      cwd: rootDir,
      env: {
        ...process.env,
      },
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const result = error as {
      readonly stdout?: string;
      readonly stderr?: string;
    };
    expect((result.stdout ?? "").trim()).toBe("");
    return JSON.parse((result.stderr ?? "").trim()) as {
      readonly error: {
        readonly message?: string;
      };
    };
  }

  throw new Error("expected CLI command to fail");
}
