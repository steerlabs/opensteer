import { createId, type Workspace } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { ThreadEventPageSchema, workspaceViewFromWorkspace } from "./client.js";

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
});

it("skips future history event types but still rejects malformed known events", () => {
  const reader = ThreadEventPageSchema.shape.events;
  expect(reader.parse([{ type: "future.event", sequence: "42", data: { future: true } }])).toEqual(
    [],
  );
  expect(reader.safeParse([{ type: "place.entered", data: {} }]).success).toBe(false);
});
