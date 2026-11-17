import { describe, expect, it } from "vitest";
import { createIntegrationId, resolveIntegrationReadiness } from "./index.js";

describe("integration readiness", () => {
  const serverId = createIntegrationId("server");
  const connectionId = createIntegrationId("connection");
  const base = {
    connectionRequirement: { definitionId: "apple-calendar", kind: "computer" as const },
    connections: [],
    hasAccess: () => false,
    installationStatus: "active" as const,
    requiredAccess: "read" as const,
    requiredConnectionId: null,
    serverId,
    serverStatus: "active" as const,
  };
  const connection = {
    connectionKind: "computer" as const,
    definitionId: "apple-calendar",
    id: connectionId,
    integrationServerId: serverId,
    status: "connected" as const,
  };

  it("distinguishes a missing computer, a missing grant, and ready access", () => {
    expect(resolveIntegrationReadiness(base).code).toBe("USER_AUTHORIZATION_REQUIRED");
    const connected = { ...base, connections: [connection] };
    expect(resolveIntegrationReadiness(connected)).toMatchObject({
      code: "ACCESS_GRANT_REQUIRED",
      connectionId,
      requiredAccess: "read",
    });
    expect(
      resolveIntegrationReadiness({ ...connected, hasAccess: (id) => id === connectionId }),
    ).toMatchObject({ code: "READY", connectionId, requiredAccess: null });
    expect(
      resolveIntegrationReadiness({
        ...connected,
        hasAccess: () => true,
        requiredAccess: "read-write",
        runAccess: "read",
      }),
    ).toMatchObject({ code: "READ_ONLY_TASK", requiredAccess: null });
  });

  it("reports reauthorization instead of pretending a broken connection is usable", () => {
    expect(
      resolveIntegrationReadiness({
        ...base,
        connections: [{ ...connection, status: "needs-attention" }],
      }),
    ).toMatchObject({ code: "REAUTHORIZATION_REQUIRED", connectionId });
  });

  it("never counts another app's computer connection", () => {
    expect(
      resolveIntegrationReadiness({
        ...base,
        connections: [{ ...connection, definitionId: "apple-contacts" }],
        hasAccess: () => true,
      }).code,
    ).toBe("USER_AUTHORIZATION_REQUIRED");
  });
});

describe("canonical Device integration targets", () => {
  it("normalizes old target records without accepting ambiguous or malformed identities", async () => {
    const { createId } = await import("@opensteer/core");
    const {
      DeviceRequestComputerAppSetupReaderSchema,
      DeviceRequestComputerAppSetupSchema,
      DeviceComputerAppSetupRequestReaderSchema,
    } = await import("./computer-app-setup.js");
    const runnerId = createId("runner");
    const legacy = {
      kind: "app",
      access: "read",
      app: null,
      definitionId: "android-phone",
      runnerId,
    };
    const canonical = {
      kind: "app",
      access: "read",
      app: null,
      definitionId: "android-phone",
      deviceId: runnerId,
    };
    expect(DeviceRequestComputerAppSetupReaderSchema.parse(legacy)).toEqual(canonical);
    expect(DeviceRequestComputerAppSetupSchema.parse(canonical)).toEqual(canonical);
    expect(
      DeviceRequestComputerAppSetupReaderSchema.safeParse({ ...canonical, runnerId }).success,
    ).toBe(false);
    expect(
      DeviceRequestComputerAppSetupReaderSchema.safeParse({
        ...canonical,
        deviceId: createId("user"),
      }).success,
    ).toBe(false);
    const screen = { ...canonical, definitionId: "iphone-screen", deviceId: createId("device") };
    expect(DeviceRequestComputerAppSetupReaderSchema.parse(screen)).toEqual(screen);
    const request = {
      ...legacy,
      id: "00000000-0000-4000-8000-000000000001",
      deploymentId: createId("deployment"),
      ownerUserId: createId("user"),
      definitionDigest: "digest",
      policyAppApproval: null,
      server: null,
      reason: null,
      threadId: null,
      threadTitle: null,
      createdAt: "2026-10-01T00:00:00Z",
      expiresAt: "2026-10-02T00:00:00Z",
    };
    const { runnerId: legacyId, ...rest } = request;
    expect(DeviceComputerAppSetupRequestReaderSchema.parse(request)).toEqual({
      ...rest,
      deviceId: legacyId,
    });
  });
});
