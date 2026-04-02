import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createFilesystemOpensteerWorkspace,
  resolveFilesystemWorkspacePath,
  OPENSTEER_FILESYSTEM_WORKSPACE_LAYOUT,
} from "../../packages/opensteer/src/index.js";

describe("workspace root layout", () => {
  test("creates the repo-local workspace structure and manifest", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-workspace-root-"));
    const rootPath = resolveFilesystemWorkspacePath({
      rootDir,
      workspace: "github-sync",
    });

    const workspace = await createFilesystemOpensteerWorkspace({
      rootPath,
      workspace: "github-sync",
    });

    expect(workspace.rootPath).toBe(rootPath);
    expect(workspace.browserPath).toBe(path.join(rootPath, "browser"));
    expect(workspace.browserManifestPath).toBe(path.join(rootPath, "browser", "manifest.json"));
    expect(workspace.browserUserDataDir).toBe(path.join(rootPath, "browser", "user-data"));
    expect(workspace.liveLocalPath).toBe(path.join(rootPath, "live", "local.json"));
    expect(workspace.liveCloudPath).toBe(path.join(rootPath, "live", "cloud.json"));
    expect(workspace.registryPath).toBe(path.join(rootPath, "registry"));
    expect(workspace.tracesPath).toBe(path.join(rootPath, "traces"));
    expect(workspace.observationsPath).toBe(path.join(rootPath, "observations"));
    expect(workspace.artifactsPath).toBe(path.join(rootPath, "artifacts"));
    expect(workspace.registry.recipes.recordsDirectory).toBe(
      path.join(rootPath, "registry", "recipes", "records"),
    );
    expect(workspace.registry.authRecipes.recordsDirectory).toBe(
      path.join(rootPath, "registry", "auth-recipes", "records"),
    );

    const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as {
      readonly layout: string;
      readonly workspace?: string;
      readonly scope: string;
      readonly paths: Record<string, string>;
    };
    expect(manifest).toMatchObject({
      layout: OPENSTEER_FILESYSTEM_WORKSPACE_LAYOUT,
      workspace: "github-sync",
      scope: "workspace",
      paths: {
        browser: "browser",
        live: "live",
        registry: "registry",
        traces: "traces",
        observations: "observations",
        artifacts: "artifacts",
      },
    });
  });

  test("creates temporary workspaces without a public workspace id", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-temp-workspace-"));
    const workspace = await createFilesystemOpensteerWorkspace({
      rootPath,
      scope: "temporary",
    });

    expect(workspace.manifest.scope).toBe("temporary");
    expect(workspace.manifest.workspace).toBeUndefined();
  });

  test("persists ordered observation sessions, events, and artifacts", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-observation-workspace-"));
    const workspace = await createFilesystemOpensteerWorkspace({
      rootPath,
      workspace: "diagnostics",
    });

    const session = await workspace.observations.openSession({
      sessionId: "session:observed",
      openedAt: 100,
      config: {
        profile: "diagnostic",
        labels: {
          workflowId: "wf-123",
        },
      },
    });

    await session.writeArtifact({
      artifactId: "artifact:obs:screenshot",
      kind: "screenshot",
      createdAt: 101,
      mediaType: "image/webp",
      byteLength: 3,
      sha256: "abc",
      storageKey: "file:///tmp/shot.webp",
    });
    await session.appendBatch([
      {
        kind: "session",
        phase: "started",
        createdAt: 100,
        correlationId: "corr:open",
      },
      {
        kind: "operation",
        phase: "completed",
        createdAt: 120,
        correlationId: "corr:open",
        artifactIds: ["artifact:obs:screenshot"],
        data: {
          operation: "session.open",
        },
      },
    ]);
    await session.close();

    expect(await workspace.observations.getSession("session:observed")).toMatchObject({
      sessionId: "session:observed",
      profile: "diagnostic",
      currentSequence: 2,
      eventCount: 2,
      artifactCount: 1,
      labels: {
        workflowId: "wf-123",
      },
      closedAt: expect.any(Number),
    });
    expect(await workspace.observations.listEvents("session:observed")).toMatchObject([
      {
        sequence: 1,
        kind: "session",
        phase: "started",
      },
      {
        sequence: 2,
        kind: "operation",
        phase: "completed",
        artifactIds: ["artifact:obs:screenshot"],
      },
    ]);
    expect(await workspace.observations.listArtifacts("session:observed")).toMatchObject([
      {
        artifactId: "artifact:obs:screenshot",
        kind: "screenshot",
      },
    ]);
  });

  test("redacts configured observation data before persistence", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-observation-redaction-"));
    const workspace = await createFilesystemOpensteerWorkspace({
      rootPath,
      workspace: "diagnostics",
    });

    const session = await workspace.observations.openSession({
      sessionId: "session:redacted",
      openedAt: 100,
      config: {
        profile: "diagnostic",
        labels: {
          note: "secret-token",
          Authorization: "Bearer secret-token",
        },
        traceContext: {
          baggage: "token=secret-token",
        },
        redaction: {
          sensitiveKeys: ["token"],
          sensitiveValues: ["secret-token"],
        },
      },
    });

    await session.append({
      kind: "operation",
      phase: "failed",
      createdAt: 110,
      correlationId: "corr:redacted",
      data: {
        headers: {
          Authorization: "Bearer secret-token",
        },
        url: "https://example.com/callback?token=secret-token",
      },
      error: {
        message: "token=secret-token",
        details: {
          Cookie: "sessionid=secret-token",
        },
      },
    });
    await session.writeArtifact({
      artifactId: "artifact:redacted",
      kind: "log",
      createdAt: 111,
      storageKey: "https://example.com/artifact?token=secret-token",
      metadata: {
        Authorization: "Bearer secret-token",
      },
    });

    await session.close();

    expect(await workspace.observations.getSession("session:redacted")).toMatchObject({
      labels: {
        note: "[REDACTED]",
        Authorization: "[REDACTED]",
      },
      traceContext: {
        baggage: "token=[REDACTED]",
      },
    });
    expect(await workspace.observations.listEvents("session:redacted")).toMatchObject([
      {
        data: {
          headers: {
            Authorization: "[REDACTED]",
          },
          url: "https://example.com/callback?token=%5BREDACTED%5D",
        },
        error: {
          message: "token=[REDACTED]",
          details: {
            Cookie: "[REDACTED]",
          },
        },
      },
    ]);
    expect(await workspace.observations.listArtifacts("session:redacted")).toMatchObject([
      {
        storageKey: "https://example.com/artifact?token=%5BREDACTED%5D",
        metadata: {
          Authorization: "[REDACTED]",
        },
      },
    ]);
  });

  test("reconciles orphaned observation files before allocating the next sequence", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-observation-reconcile-"));
    const workspace = await createFilesystemOpensteerWorkspace({
      rootPath,
      workspace: "diagnostics",
    });

    const firstSession = await workspace.observations.openSession({
      sessionId: "session:reconcile",
      openedAt: 100,
      config: {
        profile: "baseline",
      },
    });
    await firstSession.append({
      kind: "session",
      phase: "started",
      createdAt: 100,
      correlationId: "corr:1",
    });

    const manifestPath = path.join(
      rootPath,
      "observations",
      "sessions",
      encodeURIComponent("session:reconcile"),
      "session.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      currentSequence: number;
      eventCount: number;
    };
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          ...manifest,
          currentSequence: 0,
          eventCount: 0,
        },
        null,
        2,
      ),
      "utf8",
    );

    const secondSession = await workspace.observations.openSession({
      sessionId: "session:reconcile",
      openedAt: 120,
      config: {
        profile: "baseline",
      },
    });
    await secondSession.append({
      kind: "operation",
      phase: "completed",
      createdAt: 120,
      correlationId: "corr:2",
      data: {
        operation: "session.resume",
      },
    });

    expect(await workspace.observations.getSession("session:reconcile")).toMatchObject({
      currentSequence: 2,
      eventCount: 2,
    });
    expect(await workspace.observations.listEvents("session:reconcile")).toMatchObject([
      { sequence: 1, correlationId: "corr:1" },
      { sequence: 2, correlationId: "corr:2" },
    ]);
  });
});
