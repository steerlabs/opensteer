import { mkdtemp, readFile } from "node:fs/promises";
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
    expect(workspace.liveSessionPath).toBe(path.join(rootPath, "live", "session.json"));
    expect(workspace.liveBrowserPath).toBe(path.join(rootPath, "live", "browser.json"));
    expect(workspace.registryPath).toBe(path.join(rootPath, "registry"));
    expect(workspace.tracesPath).toBe(path.join(rootPath, "traces"));
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
});
