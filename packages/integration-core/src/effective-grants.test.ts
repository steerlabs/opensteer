import { describe, expect, it } from "vitest";
import { UserIdSchema } from "@opensteer/core";
import {
  IntegrationConnectionIdSchema,
  IntegrationGrantSchema,
  IntegrationInstallationSchema,
  IntegrationServerIdSchema,
  IntegrationToolSchema,
  type IntegrationGrant,
} from "./index.js";
import {
  resolveEffectiveGrants,
  type EffectiveGrantConnection,
  type EffectiveGrantTool,
  type ResolveEffectiveGrantsInput,
} from "./effective-grants.js";

const ownerUserId = UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001");
const installation = IntegrationInstallationSchema.parse({
  createdAt: "2026-01-01T00:00:00.000Z",
  description: "Tests effective authority",
  id: "iin_00000000-0000-4000-8000-000000000003",
  manifest: {},
  name: "fixture",
  provenance: {},
  revision: 1,
  sourceKind: "built-in",
  status: "active",
  title: "Fixture Integration",
  trust: "built-in",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: null,
});
const serverId = IntegrationServerIdSchema.parse("isv_00000000-0000-4000-8000-000000000004");
const connectionId = IntegrationConnectionIdSchema.parse(
  "con_00000000-0000-4000-8000-000000000005",
);
const digest = "a".repeat(43);
const providerTool: EffectiveGrantTool = {
  ...IntegrationToolSchema.parse({
    annotations: { readOnlyHint: true },
    connectionId: null,
    description: "Provider tool",
    id: "itl_00000000-0000-4000-8000-000000000006",
    name: "provider_tool",
    schemaDigest: digest,
    serverId,
    status: "active",
    title: "Provider tool",
  }),
  connectionRequirement: {
    definitionId: "google-gmail",
    kind: "provider",
    provider: "google",
    providerApplicationRequired: true,
  },
  installationId: installation.id,
  serverStatus: "active",
};
const connectionlessTool: EffectiveGrantTool = {
  ...providerTool,
  connectionRequirement: { kind: "none" },
  id: IntegrationToolSchema.shape.id.parse("itl_00000000-0000-4000-8000-000000000007"),
  name: "connectionless_tool",
  title: "Connectionless tool",
};
const writeTool: EffectiveGrantTool = {
  ...providerTool,
  annotations: { readOnlyHint: false },
  id: IntegrationToolSchema.shape.id.parse("itl_00000000-0000-4000-8000-000000000011"),
  name: "write_tool",
  title: "Write tool",
};
const connected: EffectiveGrantConnection = {
  applicationSourceAvailable: true,
  computerAccess: null,
  connectionKind: "provider-account",
  definitionId: "google-gmail",
  displayName: "Primary account",
  id: connectionId,
  integrationServerId: null,
  ownerUserId,
  provider: "google",
  status: "connected",
};
const computerReadTool: EffectiveGrantTool = {
  ...providerTool,
  connectionId,
  connectionRequirement: { definitionId: "apple-messages", kind: "computer" },
  name: "query_messages",
  title: "Read messages",
};
const computerWriteTool: EffectiveGrantTool = {
  ...computerReadTool,
  annotations: { readOnlyHint: false },
  id: IntegrationToolSchema.shape.id.parse("itl_00000000-0000-4000-8000-000000000012"),
  name: "send_message",
  title: "Send message",
};
const computerConnection: EffectiveGrantConnection = {
  ...connected,
  computerAccess: "read",
  connectionKind: "computer",
  definitionId: "apple-messages",
  displayName: "Mac mini",
  provider: "apple-messages",
};

describe("resolveEffectiveGrants", () => {
  it("requires explicit personal consent even for connected and connectionless tools", () => {
    expect(
      resolveEffectiveGrants(fixture({ tools: [providerTool, connectionlessTool] })).tools,
    ).toEqual([]);
  });

  it("treats a revoked device ceiling as no authority", () => {
    expect(
      resolveEffectiveGrants(
        fixture({
          connections: [{ ...computerConnection, computerAccess: null }],
          storedGrants: [storedGrant()],
          tools: [computerReadTool, computerWriteTool],
        }),
      ).tools,
    ).toEqual([]);
  });

  it("never lends a another person's explicit consent to the requester", () => {
    const grant = storedGrant({
      ownerUserId: UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000099"),
    });
    const result = resolveEffectiveGrants(fixture({ storedGrants: [grant] }));
    expect(result.tools).toEqual([]);
  });

  it("resolves installation tools covered by the access class", () => {
    const grant = storedGrant();
    const result = resolveEffectiveGrants(fixture({ storedGrants: [grant] }));

    expect(result).not.toHaveProperty("skills");
    expect(result.tools).toEqual([{ grant, tool: providerTool }]);
  });

  it("keeps write tools out of a read grant", () => {
    const grant = storedGrant({ access: "read" });
    const result = resolveEffectiveGrants(
      fixture({ storedGrants: [grant], tools: [providerTool, writeTool] }),
    );
    expect(result.tools).toEqual([{ grant, tool: providerTool }]);
  });

  it("rejects an explicit tool when its connection is revoked", () => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [{ ...connected, status: "revoked" }],
        storedGrants: [storedGrant()],
      }),
    );

    expect(result.tools).toEqual([]);
  });

  it("does not expose disabled inventory or unusable provider authority", () => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [{ ...connected, applicationSourceAvailable: false }],
        installations: [{ ...installation, status: "disabled" }],
        storedGrants: [],
        tools: [connectionlessTool, providerTool],
      }),
    );

    expect(result).toEqual({ tools: [] });
  });

  it("keeps a write operation out of a stored read grant on a read-write computer", () => {
    const grant = storedGrant({ access: "read" });
    const result = resolveEffectiveGrants(
      fixture({
        connections: [{ ...computerConnection, computerAccess: "read-write" }],
        storedGrants: [grant],
        tools: [computerReadTool, computerWriteTool],
      }),
    );

    expect(result.tools).toEqual([{ grant, tool: computerReadTool }]);
  });

  it("keeps consent and tools below a read-only computer connection ceiling", () => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [computerConnection],
        storedGrants: [storedGrant()],
        tools: [computerReadTool, computerWriteTool],
      }),
    );

    expect(result.tools.map(({ tool }) => tool.name)).toEqual(["query_messages"]);
    expect(result.tools[0]?.grant.access).toBe("read");
  });

  it("reports a stored grant at no more than the computer connection ceiling", () => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [computerConnection],
        storedGrants: [storedGrant({ access: "read-write" })],
        tools: [computerReadTool],
      }),
    );

    expect(result.tools[0]?.grant.access).toBe("read");
  });

  it("never matches another owner's computer connection", () => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [
          {
            ...computerConnection,
            ownerUserId: UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000099"),
          },
        ],
        storedGrants: [storedGrant()],
        tools: [computerReadTool],
      }),
    );

    expect(result.tools).toEqual([]);
  });

  it.each(["paused", "revoked"] as const)("does not expose a %s computer connection", (status) => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [{ ...computerConnection, status }],
        storedGrants: [storedGrant()],
        tools: [computerReadTool],
      }),
    );

    expect(result.tools).toEqual([]);
  });
});

function fixture(
  overrides: Partial<ResolveEffectiveGrantsInput> = {},
): ResolveEffectiveGrantsInput {
  return {
    connections: [connected],
    installations: [installation],
    ownerUserId,
    storedGrants: [],
    tools: [providerTool],
    ...overrides,
  };
}

function storedGrant(overrides: Partial<IntegrationGrant> = {}): IntegrationGrant {
  return IntegrationGrantSchema.parse({
    access: "read-write",
    alias: "Primary",
    connectionId,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "igr_00000000-0000-4000-8000-000000000009",
    installationId: installation.id,
    isDefault: false,
    ownerUserId,
    revokedAt: null,
    status: "active",
    ...overrides,
  });
}

it("intersects external writes with the Run access mode", async () => {
  const { integrationAccessCeilingForRun } = await import("./effective-grants.js");
  expect(integrationAccessCeilingForRun("approval-required")).toBe("read");
  expect(integrationAccessCeilingForRun("auto-accept-edits")).toBe("read");
  expect(integrationAccessCeilingForRun("auto")).toBe("read-write");
  expect(integrationAccessCeilingForRun("full-access")).toBe("read-write");
});
