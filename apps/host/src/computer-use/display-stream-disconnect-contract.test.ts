import { OpensteerError } from "@opensteer/core";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HostAuthenticator } from "../identity/auth.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

function collectProductionTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "dist-integration" || entry.name === "node_modules")
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectProductionTsFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".test-support.")
    ) {
      results.push(full);
    }
  }
  return results;
}

const forbiddenDisplayStreamPattern =
  /\battachViewer\s*\(|\bDisplayStreamHub\b|["'`]iphone\.display\.[a-zA-Z]+["'`]/u;

function findAgentDisplayStreamViolations(
  files: ReadonlyArray<{ readonly file: string; readonly source: string }>,
): string[] {
  return files
    .filter(({ source }) => forbiddenDisplayStreamPattern.test(source))
    .map(({ file }) => file);
}

describe("display streams are opened only by a person's own session (P7, rule 3)", () => {
  it("flags any connected-agent or engine file that opens a display stream", () => {
    expect(
      findAgentDisplayStreamViolations([
        { file: "synthetic-mcp.ts", source: "hub.attachViewer(source, userId, socket)" },
        { file: "synthetic-iphone.ts", source: 'bridge.request("iphone.display.start", ref)' },
        { file: "clean-agent.ts", source: "export const ok = true;" },
      ]),
    ).toEqual(["synthetic-mcp.ts", "synthetic-iphone.ts"]);
  });

  it("forbids every connected-agent, session, engine and agent-tool path from reaching attachViewer or iphone.display.*", () => {
    const agentDirs = [
      path.join(repoRoot, "apps/host/src/mcp"),
      path.join(repoRoot, "apps/host/src/agent-sessions"),
      path.join(repoRoot, "apps/host/src/agents"),
      path.join(repoRoot, "packages/agent-tools/src"),
    ];
    const files = agentDirs.flatMap((dir) =>
      collectProductionTsFiles(dir).map((file) => ({
        file: path.relative(repoRoot, file),
        source: readFileSync(file, "utf8"),
      })),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(findAgentDisplayStreamViolations(files)).toEqual([]);
  });

  it("calls DisplayStreamHub.attachViewer only from computer-use-display-routes behind authenticateSession", () => {
    const hostSrc = path.join(repoRoot, "apps/host/src");
    const callers = collectProductionTsFiles(hostSrc)
      .map((file) => ({
        rel: path.relative(repoRoot, file),
        source: readFileSync(file, "utf8"),
      }))
      .filter(
        ({ rel, source }) =>
          rel !== "apps/host/src/computer-use/display-stream-hub.ts" &&
          /\battachViewer\s*\(/u.test(source),
      )
      .map(({ rel }) => rel);

    expect(callers).toEqual(["apps/host/src/computer-use/computer-use-display-routes.ts"]);

    const routesSource = readFileSync(
      path.join(repoRoot, "apps/host/src/computer-use/computer-use-display-routes.ts"),
      "utf8",
    );
    expect(routesSource).toContain("options.authenticator.authenticateSession");
    expect(routesSource).not.toContain("ConnectionAuthenticator");
    expect(routesSource).not.toContain("RunToolTokenService");
  });

  it("rejects connected-agent OAuth tokens and non-session Bearer tokens in authenticateSession", async () => {
    const authenticator = new HostAuthenticator({
      publicUrl: new URL("http://127.0.0.1:4000"),
      identity: {
        authenticateNativeAccessToken: async () => {
          throw new OpensteerError({ code: "unauthorized", message: "Not a person session token" });
        },
        requireSession: async () => {
          throw new OpensteerError({ code: "unauthorized", message: "No cookie session" });
        },
        userSessionProfile: async () => {
          throw new Error("Should not resolve a profile for rejected tokens");
        },
      },
    });

    await expect(
      authenticator.authenticateSession(
        { authorization: "Bearer ost_mcp_connected_agent_token" },
        { mutation: true },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });

    await expect(
      authenticator.authenticateSession(
        { authorization: "Bearer run_tool_capability_jwt" },
        { mutation: true },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("documents in docs/architecture.md why display streams are outside any connection's Disconnect set", () => {
    const doc = readFileSync(path.join(repoRoot, "docs/architecture.md"), "utf8");
    expect(doc).toMatch(/display streams are opened only by a person's own session/iu);
    expect(doc).toMatch(/not in any connection's Disconnect set/iu);
  });
});
