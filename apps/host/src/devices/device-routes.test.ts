import { createDeviceRpcHandlers } from "./device-routes.js";
import { DeviceIdSchema, createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { describe, expect, it } from "vitest";
import { testHostApiContext } from "../server/test-host-api-context.js";
describe("device routes", () => {
  it("includes screen Device approvals while preserving the existing self connection shape", async () => {
    const owner = createId("user"),
      runnerId = createId("runner"),
      deviceId = DeviceIdSchema.parse(createId("device"));
    const common = {
      accountIdentifier: null,
      connectionMethod: "computer",
      createdAt: "2026-11-16T12:00:00.000Z",
      definitionId: "macos-app",
      displayName: "Work Mac",
      externalIdentityId: null,
      externalTenantId: null,
      id: createIntegrationId("connection"),
      provider: "macos-app",
      status: "connected",
      statusDetail: null,
      statusReason: null,
      updatedAt: "2026-11-16T12:00:00.000Z",
    };
    const self = {
      ...common,
      computer: { runnerId, access: "read", app: null, blockedAt: null, policyRevision: null },
    };
    const screen = {
      ...common,
      id: createIntegrationId("connection"),
      provider: "iphone-screen",
      definitionId: "iphone-screen",
      displayName: "Travel iPhone",
      computer: { deviceId, access: "read", app: null, blockedAt: null, policyRevision: null },
    };
    const handlers = createDeviceRpcHandlers({
      listConnections: async () => [
        {
          ...self,
          computer: {
            deviceId: DeviceIdSchema.parse(runnerId),
            access: "read",
            app: null,
            blockedAt: null,
            policyRevision: null,
          },
        },
        screen,
      ],
      devices: {
        store: {
          connections: { assertOwner: async () => {} },
          getDeviceSelfRunnerId: async (id: string) => (id === runnerId ? runnerId : null),
        },
      },
    } as never);
    const result = await handlers["integrations.get"]({}, testHostApiContext(owner));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Integration inventory was refused");
    expect(result.data.connections).toEqual([self, screen]);
    expect(result.data.connections[1]?.computer).not.toHaveProperty("runnerId");
  });
  it("serializes a screen Device's pending owner approval without a Runner placement", async () => {
    const owner = createId("user");
    const request = {
      id: crypto.randomUUID(),
      deploymentId: createId("deployment"),
      ownerUserId: owner,
      deviceId: DeviceIdSchema.parse(createId("device")),
      definitionId: "iphone-screen",
      definitionDigest: "a".repeat(43),
      access: "read",
      kind: "app",
      app: null,
      policyAppApproval: null,
      server: null,
      reason: "Read the map",
      threadId: null,
      threadTitle: null,
      createdAt: "2026-11-16T12:00:00.000Z",
      expiresAt: "2026-11-17T12:00:00.000Z",
    };
    const handlers = createDeviceRpcHandlers({
      devices: {
        store: {
          connections: { assertOwner: async () => {} },
          getDeviceSelfRunnerId: async () => null,
          listDeviceComputerAppSetupRequests: async () => [request],
        },
      },
    } as never);
    const result = await handlers["integration.computer.setup.list"]({}, testHostApiContext(owner));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Approval inventory was refused");
    expect(result.data.requests).toEqual([request]);
    expect(result.data.requests[0]).not.toHaveProperty("runnerId");
  });
});
