import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntegrationId } from "@opensteer/integration-core";
import { createId } from "@opensteer/core";
import type { IntegrationPlatformStore } from "@opensteer/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationSkillBundleService,
  type IntegrationSkillsTokenService,
} from "./integration-skill-bundle-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("IntegrationSkillBundleService", () => {
  it("bundles only the exact skill granted to the requesting user and Workspace", async () => {
    const snapshotDirectory = await mkdtemp(join(tmpdir(), "opensteer-agent-plugin-snapshots-"));
    temporaryDirectories.push(snapshotDirectory);
    const snapshotDigest = "a".repeat(64);
    const root = join(snapshotDirectory, snapshotDigest);
    await mkdir(root);
    await mkdir(join(root, "skills", "allowed", "scripts"), { recursive: true });
    await mkdir(join(root, "skills", "hidden"), { recursive: true });
    await writeFile(join(root, "skills", "allowed", "SKILL.md"), "allowed instructions");
    await writeFile(join(root, "skills", "allowed", "scripts", "run.sh"), "#!/bin/sh\n");
    await chmod(join(root, "skills", "allowed", "scripts", "run.sh"), 0o700);
    await writeFile(join(root, "skills", "hidden", "SKILL.md"), "hidden instructions");

    const installationId = createIntegrationId("installation");
    const requestedBy = createId("user");
    const workspaceId = createId("workspace");
    const installation = {
      createdAt: new Date().toISOString(),
      description: "Example Agent Plugin",
      id: installationId,
      manifest: {},
      name: "example-plugin",
      provenance: { snapshotDigest },
      revision: 1,
      sourceKind: "plugin" as const,
      status: "active" as const,
      title: "Example Plugin",
      trust: "administrator-approved" as const,
      updatedAt: new Date().toISOString(),
      version: "1.0.0",
    };
    const store = {
      plugins: {
        current: vi.fn(async () => [
          {
            id: installationId,
            name: installation.name,
            digest: snapshotDigest,
            manifest: { skills: [{ name: "allowed" }] },
          },
        ]),
      },
    };
    const tokens = {
      authenticate: vi.fn(async () => ({ requestedBy, workspaceId })),
    };
    const service = new IntegrationSkillBundleService({
      snapshotDirectory,
      store: store as unknown as IntegrationPlatformStore,
      tokens: tokens as unknown as IntegrationSkillsTokenService,
    });

    const bundle = await service.bundle("signed-run-token");
    expect(tokens.authenticate).toHaveBeenCalledWith("signed-run-token");
    expect(store.plugins.current).toHaveBeenCalledWith(workspaceId);
    expect(bundle.plugins).toHaveLength(1);
    expect(bundle.plugins[0]?.skills.map(({ name }) => name)).toEqual(["allowed"]);
    expect(bundle.plugins[0]?.skills[0]?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executable: false, path: "SKILL.md" }),
        expect.objectContaining({ executable: true, path: "scripts/run.sh" }),
      ]),
    );
    expect(JSON.stringify(bundle)).not.toContain("hidden instructions");
  });
});
