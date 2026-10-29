import { createId, type Workspace } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { workspaceViewFromWorkspace } from "./client.js";

const timestamps = {
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:01:00.000Z",
} as const;

describe("workspaceViewFromWorkspace", () => {
  it("projects a local Workspace without exposing its binding", () => {
    const workspace: Workspace = {
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory",
        ownerEnvironmentId: createId("environment"),
        storageAuthorityId: createId("storageAuthority"),
      },
      capacityPolicy: { kind: "host-filesystem" },
      createdBy: createId("user"),
      icon: null,
      homeThreadId: null,
      id: createId("workspace"),
      kind: "main",
      name: "Main",
      status: "ready",
      storageIssue: null,
      ...timestamps,
    };

    const view = workspaceViewFromWorkspace(workspace);

    expect(view).toMatchObject({
      capacity: { kind: "host-filesystem" },
      location: { kind: "machine", name: null },
    });
    expect(view).not.toHaveProperty("backing");
    expect(view).not.toHaveProperty("createdBy");
  });

  it("describes PortableFS capacity without exposing service, volume, or quota details", () => {
    const workspace: Workspace = {
      backing: {
        generation: 3,
        kind: "portablefs",
        serviceId: "storage-primary",
        volumeId: "volume_private_123",
      },
      capacityPolicy: {
        blockHardLimitBytes: 1_073_741_824,
        inodeHardLimit: 100_000,
        kind: "hard-quota",
      },
      createdBy: createId("user"),
      icon: null,
      homeThreadId: null,
      id: createId("workspace"),
      kind: "specialized",
      name: "Research",
      status: "ready",
      storageIssue: null,
      ...timestamps,
    };

    const view = workspaceViewFromWorkspace(workspace);

    expect(view).toMatchObject({
      capacity: { kind: "managed-quota" },
      location: { kind: "shared-storage" },
    });
    expect(JSON.stringify(view)).not.toContain("storage-primary");
    expect(JSON.stringify(view)).not.toContain("volume_private_123");
    expect(JSON.stringify(view)).not.toContain("1073741824");
  });
});
