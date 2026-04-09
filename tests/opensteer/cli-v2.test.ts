import { once } from "node:events";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { ensureCliArtifactsBuilt } from "./cli-artifacts.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");

describe("Opensteer v2 CLI", () => {
  test("prints the package version", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-version-"));

    try {
      await mkdir(path.join(cwd, ".env"));

      const packageJson = JSON.parse(
        await readFile(path.resolve(process.cwd(), "packages/opensteer/package.json"), "utf8"),
      ) as {
        readonly version: string;
      };

      const result = await execFile("node", [CLI_SCRIPT, "--version"], {
        cwd,
        maxBuffer: 1024 * 1024 * 4,
      });

      expect(result.stdout).toBe(`${packageJson.version}\n`);
      expect(result.stderr).toBe("");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("prints workspace-centric help", async () => {
    await ensureCliArtifactsBuilt();

    const result = await execFile("node", [CLI_SCRIPT, "--help"], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 4,
    });

    expect(result.stdout).toContain("Opensteer CLI");
    expect(result.stdout).toContain("open <url> [--workspace <id>] [--headless] [--provider local|cloud]");
    expect(result.stdout).toContain('extract <schema> [--persist <key>]');
    expect(result.stdout).toContain("--body <json>");
    expect(result.stdout).toContain("--workspace <id>");
    expect(result.stdout).toContain("--json filters to JSON and GraphQL responses only");
    expect(result.stdout).not.toContain("opensteer run");
    expect(result.stdout).not.toContain("--body-json");
    expect(result.stdout).not.toContain("--context-json");
    expect(result.stdout).not.toContain("--input-json");
    expect(result.stdout).not.toContain("--description");
    expect(result.stdout).not.toContain("--schema <json>");
    expect(result.stdout).not.toContain("--selector");
    expect(result.stdout).not.toContain("--schema-json");
    expect(result.stdout).not.toContain("record <url> [--output <path>]");
    expect(result.stdout).not.toContain("skills install");
    expect(result.stdout).not.toContain("browser status");
    expect(result.stdout).not.toContain("browser clone");
    expect(result.stdout).not.toContain("snapshot-session");
    expect(result.stdout).not.toContain("snapshot-authenticated");
    expect(result.stdout).not.toContain("attach-live");
    expect(result.stdout).not.toContain("--name");
  }, 60_000);

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
    };

    expect(parsed).toMatchObject({
      mode: "persistent",
      workspace: "github-sync",
      live: false,
    });
    expect(parsed).not.toHaveProperty("rootPath");
    expect(parsed).not.toHaveProperty("browserPath");
    expect(parsed).not.toHaveProperty("userDataDir");
  }, 60_000);

  test("reports browser status without requiring SQLite support", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-no-sqlite-status-"));

    try {
      const result = await execFile(
        process.execPath,
        ["--no-experimental-sqlite", CLI_SCRIPT, "browser", "status", "--workspace", "sqlite-free"],
        {
          cwd,
          maxBuffer: 1024 * 1024 * 4,
        },
      );

      const parsed = JSON.parse(result.stdout) as {
        readonly mode: string;
        readonly workspace?: string;
        readonly live: boolean;
      };

      expect(parsed).toMatchObject({
        mode: "persistent",
        workspace: "sqlite-free",
        live: false,
      });
      expect(result.stderr).toBe("");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("loads engine selection from .env for browser workspace commands", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-engine-env-"));

    try {
      await writeFile(path.join(cwd, ".env"), "OPENSTEER_ENGINE=abp\n");

      const result = await execFile(
        "node",
        [CLI_SCRIPT, "browser", "status", "--workspace", "engine-from-env"],
        {
          cwd,
          maxBuffer: 1024 * 1024 * 4,
        },
      );

      const parsed = JSON.parse(result.stdout) as {
        readonly engine: string;
      };

      expect(parsed.engine).toBe("abp");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("accepts option=value syntax for launch args that start with dashes", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-arg-equals-"));

    try {
      const result = await execFile(
        "node",
        [
          CLI_SCRIPT,
          "browser",
          "status",
          "--workspace",
          "arg-equals",
          "--arg=--remote-debugging-port=9333",
        ],
        {
          cwd,
          maxBuffer: 1024 * 1024 * 4,
        },
      );

      const parsed = JSON.parse(result.stdout) as {
        readonly workspace?: string;
      };

      expect(parsed.workspace).toBe("arg-equals");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("falls back to OPENSTEER_WORKSPACE for workspace commands", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-workspace-env-"));

    try {
      const result = await execFile("node", [CLI_SCRIPT, "browser", "status"], {
        cwd,
        env: {
          ...process.env,
          OPENSTEER_WORKSPACE: "workspace-from-env",
        },
        maxBuffer: 1024 * 1024 * 4,
      });

      const parsed = JSON.parse(result.stdout) as {
        readonly workspace?: string;
      };

      expect(parsed.workspace).toBe("workspace-from-env");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("fails persisted-network CLI commands with a targeted SQLite support error", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-no-sqlite-saved-network-"));

    try {
      const execution = execFile(
        process.execPath,
        [
          "--no-experimental-sqlite",
          CLI_SCRIPT,
          "network",
          "query",
          "--workspace",
          "sqlite-required",
        ],
        {
          cwd,
          maxBuffer: 1024 * 1024 * 4,
        },
      );

      await expect(execution).rejects.toMatchObject({
        stderr: expect.stringMatching(
          /Saved-network operations require Node's built-in SQLite support\..*node:sqlite/s,
        ),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("loads provider config from .env for top-level status", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-status-"));

    try {
      await writeFile(
        path.join(cwd, ".env"),
        [
          "OPENSTEER_PROVIDER=cloud",
          "OPENSTEER_API_KEY=osk_test",
          "OPENSTEER_BASE_URL=http://127.0.0.1:8180",
        ].join("\n"),
      );
      const {
        OPENSTEER_PROVIDER: _opensteerProvider,
        OPENSTEER_API_KEY: _opensteerApiKey,
        OPENSTEER_BASE_URL: _opensteerBaseUrl,
        ...env
      } = process.env;

      const result = await execFile("node", [CLI_SCRIPT, "status", "--json"], {
        cwd,
        env,
        maxBuffer: 1024 * 1024 * 4,
      });

      const parsed = JSON.parse(result.stdout) as {
        readonly provider: {
          readonly current: string;
          readonly source: string;
          readonly cloudBaseUrl?: string;
        };
      };

      expect(parsed.provider).toEqual({
        current: "cloud",
        source: "env",
        cloudBaseUrl: "http://127.0.0.1:8180",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("exec validates provider and engine compatibility like other workspace commands", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-exec-provider-engine-"));

    try {
      const execution = execFile(
        "node",
        [
          CLI_SCRIPT,
          "exec",
          "--workspace",
          "exec-provider-engine",
          "--provider",
          "cloud",
          "--engine",
          "abp",
          "1",
        ],
        {
          cwd,
          maxBuffer: 1024 * 1024 * 4,
        },
      );

      await expect(execution).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "ABP is not supported for provider=cloud. Cloud provider currently requires Playwright.",
        ),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("exec rejects cloud-only overrides unless cloud provider is selected", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-exec-cloud-overrides-"));

    try {
      const execution = execFile(
        "node",
        [
          CLI_SCRIPT,
          "exec",
          "--workspace",
          "exec-cloud-overrides",
          "--cloud-base-url",
          "https://api.opensteer.dev",
          "1",
        ],
        {
          cwd,
          maxBuffer: 1024 * 1024 * 4,
        },
      );

      await expect(execution).rejects.toMatchObject({
        stderr: expect.stringContaining("Cloud-specific options require provider=cloud."),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
