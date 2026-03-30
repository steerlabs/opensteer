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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

  test("discovers reverse candidates from saved workspace network across CLI invocations", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-reverse-"));
    const workspace = `reverse-${Date.now()}`;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/page") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><html><body>ready</body></html>");
        return;
      }
      if (url.pathname === "/api/portable") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            item: url.searchParams.get("item") ?? "unknown",
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start CLI reverse fixture server");
    }
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;

    const runCli = async (args: readonly string[]) =>
      JSON.parse(
        (
          await execFile(process.execPath, [CLI_SCRIPT, ...args], {
            cwd,
            maxBuffer: 1024 * 1024 * 8,
          })
        ).stdout,
      ) as Record<string, unknown>;

    try {
      await runCli(["open", `${baseUrl}/page`, "--workspace", workspace, "--headless", "true"]);
      await runCli([
        "run",
        "page.evaluate",
        "--workspace",
        workspace,
        "--input-json",
        JSON.stringify({
          script:
            'async () => { const response = await fetch("/api/portable?item=cli"); return await response.json(); }',
        }),
      ]);

      const saved = (await runCli([
        "run",
        "network.query",
        "--workspace",
        workspace,
        "--input-json",
        JSON.stringify({
          source: "saved",
          path: "/api/portable",
          includeBodies: true,
        }),
      ])) as {
        readonly records: readonly unknown[];
      };
      expect(saved.records.length).toBeGreaterThan(0);

      const discovered = (await runCli([
        "run",
        "reverse.discover",
        "--workspace",
        workspace,
        "--input-json",
        JSON.stringify({
          objective: "CLI reverse discover from saved workspace capture",
          targetHints: { paths: ["/api/portable"] },
          network: {
            path: "/api/portable",
            includeBodies: true,
          },
        }),
      ])) as {
        readonly summary: {
          readonly recordCount: number;
          readonly candidateCount: number;
        };
      };

      expect(discovered.summary.recordCount).toBeGreaterThan(0);
      expect(discovered.summary.candidateCount).toBeGreaterThan(0);
    } finally {
      await execFile(process.execPath, [CLI_SCRIPT, "close", "--workspace", workspace], {
        cwd,
        maxBuffer: 1024 * 1024 * 4,
      }).catch(() => undefined);
      server.close();
      await once(server, "close").catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("creates and runs a portable reverse package across workspace-scoped CLI invocations", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-reverse-package-"));
    const workspace = `reverse-package-${Date.now()}`;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/page") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html>
<html>
  <body>
    <script>
      window.runPortable = async () => {
        const response = await fetch("/api/portable?item=package");
        return await response.json();
      };
    </script>
    ready
  </body>
</html>`);
        return;
      }
      if (url.pathname === "/api/portable") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            item: url.searchParams.get("item") ?? "unknown",
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start CLI reverse package fixture server");
    }
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;

    const runCli = async (args: readonly string[]) =>
      JSON.parse(
        (
          await execFile(process.execPath, [CLI_SCRIPT, ...args], {
            cwd,
            maxBuffer: 1024 * 1024 * 8,
          })
        ).stdout,
      ) as Record<string, unknown>;

    try {
      await runCli(["open", `${baseUrl}/page`, "--workspace", workspace, "--headless", "true"]);
      await runCli([
        "run",
        "page.evaluate",
        "--workspace",
        workspace,
        "--input-json",
        JSON.stringify({
          script: "async () => await window.runPortable()",
        }),
      ]);

      const discovered = (await runCli([
        "run",
        "reverse.discover",
        "--workspace",
        workspace,
        "--input-json",
        JSON.stringify({
          objective: "CLI reverse package flow from workspace capture",
          targetHints: { paths: ["/api/portable"] },
          network: {
            path: "/api/portable",
            includeBodies: true,
          },
        }),
      ])) as {
        readonly caseId: string;
      };

      const queried = (await runCli([
        "run",
        "reverse.query",
        "--workspace",
        workspace,
        "--input-json",
        JSON.stringify({
          caseId: discovered.caseId,
          view: "candidates",
          filters: {
            path: "/api/portable",
          },
        }),
      ])) as {
        readonly candidates?: Array<{
          readonly candidate: {
            readonly id: string;
            readonly advisoryTemplates: Array<{
              readonly id: string;
              readonly transport?: string;
              readonly viability: string;
            }>;
          };
        }>;
      };

      const candidate = queried.candidates?.[0]?.candidate;
      expect(candidate).toBeDefined();
      if (candidate === undefined) {
        throw new Error("expected reverse query to return a candidate");
      }

      const template = candidate.advisoryTemplates.find(
        (entry) => entry.transport === "direct-http" && entry.viability === "ready",
      );
      expect(template).toBeDefined();
      if (template === undefined) {
        throw new Error("expected reverse query to return a ready direct-http template");
      }

      const built = (await runCli([
        "run",
        "reverse.package.create",
        "--workspace",
        workspace,
        "--input-json",
        JSON.stringify({
          caseId: discovered.caseId,
          source: {
            kind: "candidate",
            id: candidate.id,
          },
          templateId: template.id,
        }),
      ])) as {
        readonly package: {
          readonly id: string;
          readonly payload: {
            readonly kind: string;
            readonly readiness: string;
          };
        };
      };

      expect(built.package.payload.kind).toBe("portable-http");
      expect(built.package.payload.readiness).toBe("runnable");

      const replayed = (await runCli([
        "run",
        "reverse.package.run",
        "--workspace",
        workspace,
        "--input-json",
        JSON.stringify({
          packageId: built.package.id,
        }),
      ])) as {
        readonly success: boolean;
        readonly status?: number;
      };

      expect(replayed.success).toBe(true);
      expect(replayed.status).toBe(200);

      const exported = (await runCli([
        "run",
        "reverse.export",
        "--workspace",
        workspace,
        "--input-json",
        JSON.stringify({
          packageId: built.package.id,
        }),
      ])) as {
        readonly package: {
          readonly id: string;
        };
        readonly requestPlan?: {
          readonly id: string;
        };
      };

      expect(exported.package.id).not.toBe(built.package.id);
      expect(exported.requestPlan?.id).toBeDefined();
    } finally {
      await execFile(process.execPath, [CLI_SCRIPT, "close", "--workspace", workspace], {
        cwd,
        maxBuffer: 1024 * 1024 * 4,
      }).catch(() => undefined);
      server.close();
      await once(server, "close").catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
