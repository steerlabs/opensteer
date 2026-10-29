import { describe, expect, it } from "vitest";
import { UserIdSchema, WorkspaceIdSchema } from "@opensteer/core";
import {
  IntegrationConnectionIdSchema,
  IntegrationGrantSchema,
  IntegrationInstallationSchema,
  IntegrationServerIdSchema,
  IntegrationSkillSchema,
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
const workspaceId = WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000002");
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
const skill = IntegrationSkillSchema.parse({
  description: "A test skill",
  digest,
  id: "isk_00000000-0000-4000-8000-000000000008",
  installationId: installation.id,
  name: "test-skill",
  status: "active",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
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
  name: "read_messages",
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
  it("resolves installation tools and skills covered by the access class", () => {
    const grant = storedGrant();
    const result = resolveEffectiveGrants(fixture({ storedGrants: [grant] }));

    expect(result.tools).toEqual([{ grant, tool: providerTool }]);
    expect(result.skills).toEqual([{ grant, skill }]);
  });

  it("keeps write tools out of a read grant", () => {
    const grant = storedGrant({ access: "read" });
    const result = resolveEffectiveGrants(
      fixture({ storedGrants: [grant], tools: [providerTool, writeTool] }),
    );
    expect(result.tools).toEqual([{ grant, tool: providerTool }]);
    expect(result.skills).toEqual([{ grant, skill }]);
  });

  it("rejects an explicit tool when its connection is revoked", () => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [{ ...connected, status: "revoked" }],
        storedGrants: [storedGrant()],
      }),
    );

    expect(result.tools).toEqual([]);
    expect(result.skills).toHaveLength(1);
  });

  it("inherits active inventory in the Main Workspace with deterministic pseudo-grants", () => {
    const input = fixture({
      inheritedMainAccess: true,
      storedGrants: [],
      tools: [connectionlessTool, providerTool],
    });
    const first = resolveEffectiveGrants(input);
    const second = resolveEffectiveGrants(input);

    expect(first.tools.map(({ grant }) => grant.connectionId)).toEqual([null, connectionId]);
    expect(first.tools[0]?.grant.alias).toBe("Fixture Integration");
    expect(first.tools[1]?.grant.alias).toBe("Primary account");
    expect(first.skills[0]?.grant).toHaveProperty("source", "main-inherited");
    expect(first.tools.map(({ grant }) => grant.id)).toEqual(
      second.tools.map(({ grant }) => grant.id),
    );
  });

  it("overlays aliases and defaults without adopting stored grant identity", () => {
    const connectionOverlay = storedGrant({ alias: "  Work account  ", isDefault: true });
    const connectionlessOverlay = storedGrant({
      alias: "  Shared tools  ",
      connectionId: null,
      id: IntegrationGrantSchema.shape.id.parse("igr_00000000-0000-4000-8000-000000000010"),
    });
    const result = resolveEffectiveGrants(
      fixture({
        inheritedMainAccess: true,
        storedGrants: [connectionOverlay, connectionlessOverlay],
        tools: [connectionlessTool, providerTool],
      }),
    );

    expect(result.tools[0]?.grant).toMatchObject({ alias: "Shared tools", isDefault: false });
    expect(result.tools[1]?.grant).toMatchObject({ alias: "Work account", isDefault: true });
    expect(result.tools[1]?.grant.id).not.toBe(connectionOverlay.id);
    expect(result.skills[0]?.grant).toMatchObject({ alias: "Shared tools", isDefault: false });
  });

  it("does not inherit disabled inventory or unusable provider authority", () => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [{ ...connected, applicationSourceAvailable: false }],
        inheritedMainAccess: true,
        installations: [{ ...installation, status: "disabled" }],
        storedGrants: [],
        tools: [connectionlessTool, providerTool],
      }),
    );

    expect(result).toEqual({ skills: [], tools: [] });
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

  it("keeps inherited access and tools below a read-only computer connection ceiling", () => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [computerConnection],
        inheritedMainAccess: true,
        tools: [computerReadTool, computerWriteTool],
      }),
    );

    expect(result.tools.map(({ tool }) => tool.name)).toEqual(["read_messages"]);
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
        inheritedMainAccess: true,
        tools: [computerReadTool],
      }),
    );

    expect(result.tools).toEqual([]);
  });

  it.each(["paused", "revoked"] as const)("does not expose a %s computer connection", (status) => {
    const result = resolveEffectiveGrants(
      fixture({
        connections: [{ ...computerConnection, status }],
        inheritedMainAccess: true,
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
    inheritedMainAccess: false,
    installations: [installation],
    ownerUserId,
    skills: [skill],
    storedGrants: [],
    tools: [providerTool],
    workspaceId,
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
    workspaceId,
    ...overrides,
  });
}
