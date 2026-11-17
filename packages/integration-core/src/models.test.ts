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
