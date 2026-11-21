import type { IntegrationDefinitionSummary } from "@opensteer/integration-core/adapter";
import { createId, PendingRequestSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import {
  accessPlan,
  accountsForRequirement,
  computerAccessUpgrade,
  catalogInstallDefinition,
  integrationRequestStillPending,
  loadAccessRequest,
  matchingInstallationForManifest,
  type LoadedAccessRequest,
} from "./access-request.js";

it("keeps the request body paired with its revision through the install step", () => {
  const data = loaded();
  const payload = {
    ...data.request,
    manifest: null,
    reason: "Read Messages",
    requestedConnectionId: null,
  };
  const installed = PendingRequestSchema.parse({
    callId: "connect",
    cancellationReason: null,
    createdAt: "2026-09-18T00:00:00Z",
    id: createId("request"),
    kind: "integration.access",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    payload,
    presentation: {
      kind: "external",
      title: "Connect Messages",
      subject: { id: "messages", kind: "integration.access" },
    },
    requestedBy: createId("user"),
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  });
  const prior = {
    ...installed,
    reviewedRevision: "20",
    payload: { ...payload, installationId: null, manifest: {}, requestedServerId: null },
  };
  const latest = loadAccessRequest(data, { ...installed, reviewedRevision: "21" });
  expect(loadAccessRequest(data, prior, latest)).toMatchObject({
    id: installed.id,
    request: installed.payload,
    reviewedRevision: "21",
  });
  expect(loadAccessRequest(data, { ...prior, id: createId("request") }, latest)).toMatchObject({
    request: prior.payload,
    reviewedRevision: "20",
  });
});

describe("integrationRequestStillPending", () => {
  it("finds a pending Request across durable pages", async () => {
    const rpc = vi.fn(async (input: { readonly before?: string }) =>
      input.before
        ? requestPage(["request-target"], false, null)
        : requestPage(["request-newer"], true, "older"),
    );

    await expect(
      integrationRequestStillPending(
        { rpc: { "thread.requests.list": rpc } } as never,
        "thread-one",
        "request-target",
      ),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("recognises fulfillment when the Request leaves the pending-only endpoint", async () => {
    const rpc = vi.fn(async () => requestPage([], false, null));

    await expect(
      integrationRequestStillPending(
        { rpc: { "thread.requests.list": rpc } } as never,
        "thread-one",
        "request-settled",
      ),
    ).resolves.toBe(false);
  });
});

const macMini = "rnr_11111111-1111-4111-8111-111111111111";
const macBook = "rnr_33333333-3333-4333-8333-333333333333";
const installationId = "iin_messages";
const serverId = "isv_messages";

describe("accessPlan, for an app on a computer", () => {
  it("answers with the computers the app is on, each carrying its own ceiling", () => {
    const plan = accessPlan(loaded(), null);

    expect(
      plan?.accounts.map(({ computer, displayName }) => [displayName, computer?.access]),
    ).toEqual([
      ["Mac mini", "read"],
      ["Alex's MacBook Pro", "read-write"],
    ]);
  });

  it("preserves the requested computer even when another account is selected", () => {
    const input = loaded();
    const pinned = {
      ...input,
      request: { ...input.request, requestedConnectionId: "con_macbook" },
    };
    expect(accessPlan(pinned, "con_mac_mini")?.selectedAccount?.id).toBe("con_macbook");
  });

  it("does not substitute another computer for an unavailable requested account", () => {
    const input = loaded();
    const pinned = {
      ...input,
      request: { ...input.request, requestedConnectionId: "con_missing" },
    };
    expect(accessPlan(pinned, "con_mac_mini")).toMatchObject({
      requestedAccountMissing: true,
      selectedAccount: null,
    });
  });

  // A computer app's tools exist per connection, so what a Request can reach
  // is exactly what the chosen computer's ceiling materialised — never the
  // other computer's rows, and never a server-wide row.
  it("counts only the chosen computer's operations", () => {
    expect(accessPlan(loaded(), "con_mac_mini")).toMatchObject({ readCount: 2, writeCount: 0 });
    expect(accessPlan(loaded(), "con_macbook")).toMatchObject({ readCount: 2, writeCount: 1 });
  });

  it("leaves a revoked or half-made connection out", () => {
    const withRevoked = loaded();
    const plan = accessPlan(
      {
        ...withRevoked,
        dashboard: {
          ...withRevoked.dashboard,
          connections: withRevoked.dashboard.connections.map((connection) =>
            connection.id === "con_macbook" ? { ...connection, status: "revoked" } : connection,
          ),
        },
      } as LoadedAccessRequest,
      null,
    );

    expect(plan?.accounts.map(({ id }) => id)).toEqual(["con_mac_mini"]);
  });
});

/*
 * Failure cases for definitions read back out of stored manifests:
 * - a newer Host's app that also lists an iPhone, or a platform this client
 *   has never heard of, loses its definition, so the Request card and install
 *   review fall back to bare titles and the app's own words disappear;
 * - an installation stored before definitions carried key facts (no `apiKey`)
 *   stops being read once the tolerant reader is used.
 */
describe("definitions stored in manifests", () => {
  const newerApp = {
    ...messages(),
    computerApp: {
      ...messages().computerApp!,
      platforms: ["darwin", "ios", "future-phone-os"],
    },
  };

  it("reads a newer Host's app, keeping the platforms this client knows", () => {
    const plan = accessPlan(withManifestDefinition(newerApp), null);
    expect(plan?.definition?.computerApp?.platforms).toEqual(["darwin", "ios"]);
    expect(plan?.integrationName).toBe("Messages");
  });

  it("still reads an installation stored before definitions carried key facts", () => {
    const stored: Record<string, unknown> = { ...messages() };
    delete stored["apiKey"];
    const plan = accessPlan(withManifestDefinition(stored), null);
    expect(plan?.definition).toMatchObject({ id: "apple-messages" });
  });

  it("reviews and matches a newer Host's catalog install", () => {
    const manifest = { definition: newerApp, digest: "d".repeat(43), kind: "catalog" };
    expect(catalogInstallDefinition(manifest)).toMatchObject({ name: "Messages" });
    const installed = {
      id: installationId,
      provenance: { definitionDigest: "d".repeat(43), definitionId: "apple-messages" },
      status: "active",
    };
    expect(
      matchingInstallationForManifest(
        { installations: [{ installation: installed }] } as unknown as Parameters<
          typeof matchingInstallationForManifest
        >[0],
        manifest,
      )?.installation.id,
    ).toBe(installationId);
  });

  it("still reviews a catalog install stored before definitions carried key facts", () => {
    const stored: Record<string, unknown> = { ...messages() };
    delete stored["apiKey"];
    expect(
      catalogInstallDefinition({ definition: stored, digest: "d".repeat(43), kind: "catalog" }),
    ).toMatchObject({ name: "Messages" });
  });
});

function withManifestDefinition(definition: object): LoadedAccessRequest {
  const base = loaded();
  const [entry] = base.platform.installations;
  return {
    ...base,
    platform: {
      ...base.platform,
      installations: [
        {
          ...entry!,
          installation: {
            ...entry!.installation,
            manifest: { definition, digest: "d", kind: "catalog" },
          },
        },
      ],
    },
  };
}

/**
 * The browser card and the phone's card read this one function, so a computer
 * one of them would offer is a computer the other would offer too.
 */
describe("accountsForRequirement", () => {
  const { dashboard } = loaded();

  // An app's account is a computer, and its ceiling travels with it: a surface
  // has to know a read-only computer cannot answer a request that asks to send.
  it("answers a computer requirement with the computers it is on, ceiling and all", () => {
    expect(
      accountsForRequirement({
        dashboard,
        requirement: { definitionId: "apple-messages", kind: "computer" },
      }).map(({ computer, displayName, id }) => [id, displayName, computer?.access]),
    ).toEqual([
      ["con_mac_mini", "Mac mini", "read"],
      ["con_macbook", "Alex's MacBook Pro", "read-write"],
    ]);
  });
});

describe("computerAccessUpgrade", () => {
  it("names the computer whose ceiling blocks a send this Request asked for", () => {
    expect(computerAccessUpgrade(accessPlan(loaded("read-write"), "con_mac_mini")!)).toEqual({
      definitionId: "apple-messages",
      displayName: "Mac mini",
      runnerId: macMini,
    });
  });

  it("asks for nothing when the chosen computer already allows sending", () => {
    expect(computerAccessUpgrade(accessPlan(loaded("read-write"), "con_macbook")!)).toBeNull();
  });

  it("asks for nothing when the Request only wants to read", () => {
    expect(computerAccessUpgrade(accessPlan(loaded("read"), "con_mac_mini")!)).toBeNull();
  });

  it("uses the effective access when a read Request is expanded to allow changes", () => {
    const plan = accessPlan(loaded("read"), "con_mac_mini")!;
    expect(computerAccessUpgrade(plan, "read-write")).toEqual({
      definitionId: "apple-messages",
      displayName: "Mac mini",
      runnerId: macMini,
    });
    expect(computerAccessUpgrade(plan, "read")).toBeNull();
  });

  it("asks for nothing when the app itself has no level above reading", () => {
    const readOnlyApp = messages();
    expect(
      computerAccessUpgrade({
        definition: {
          ...readOnlyApp,
          computerApp: { ...readOnlyApp.computerApp!, accessLevels: ["read"] },
        },
        requestedAccess: "read-write",
        requirement: { definitionId: "apple-messages", kind: "computer" },
        selectedAccount: {
          accountIdentifier: null,
          computer: { access: "read", runnerId: macMini },
          createdAt: "2026-09-17T12:00:00.000Z",
          displayName: "Mac mini",
          id: "con_mac_mini",
        },
      }),
    ).toBeNull();
  });
});

function messages(): IntegrationDefinitionSummary {
  return {
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    computerApp: {
      accessLabels: { read: "Read only", readWrite: "Read and send" },
      accessLevels: ["read", "read-write"],
      operations: [
        { name: "query_messages", effect: "read" },
        { name: "export_attachment", effect: "read" },
        { name: "send_message", effect: "write" },
      ],
      accessSummaries: {
        read: "Agents can search and read your conversations.",
        readWrite: "Agents can search and read your conversations, and send messages as you.",
      },
      platforms: ["darwin"],
    },
    description: "Search, read, and send Messages through an enrolled Mac.",
    id: "apple-messages",
    name: "Messages",
    provider: "apple-messages",
  } as unknown as IntegrationDefinitionSummary;
}

function tool(connectionId: string, name: string, readOnly: boolean) {
  return {
    annotations: { readOnlyHint: readOnly },
    connectionId,
    description: name,
    id: `itl_${connectionId}_${name}`,
    name,
    schemaDigest: "a".repeat(43),
    serverId,
    status: "active",
    title: name,
  };
}

function computerConnection(input: {
  readonly access: "read" | "read-write";
  readonly id: string;
  readonly name: string;
  readonly runnerId: string;
}) {
  return {
    accountIdentifier: null,
    computer: { access: input.access, runnerId: input.runnerId },
    connectionMethod: "computer",
    createdAt: "2026-09-02T10:20:00.000Z",
    definitionId: "apple-messages",
    displayName: input.name,
    externalIdentityId: null,
    externalTenantId: null,
    id: input.id,
    provider: "apple-messages",
    status: "connected",
    statusDetail: null,
    updatedAt: "2026-09-02T10:20:00.000Z",
  };
}

function loaded(access: "read" | "read-write" = "read"): LoadedAccessRequest {
  return {
    dashboard: {
      connections: [
        computerConnection({
          access: "read",
          id: "con_mac_mini",
          name: "Mac mini",
          runnerId: macMini,
        }),
        computerConnection({
          access: "read-write",
          id: "con_macbook",
          name: "Alex's MacBook Pro",
          runnerId: macBook,
        }),
        // Another app's account, which this Request must never offer.
        {
          ...computerConnection({
            access: "read",
            id: "con_github",
            name: "octocat",
            runnerId: macMini,
          }),
          computer: null,
          definitionId: "github",
        },
      ],
    },
    platform: {
      connections: [],
      installations: [
        {
          installation: {
            id: installationId,
            manifest: { definition: messages(), digest: "d", kind: "catalog" },
            title: "Messages",
          },
          servers: [
            {
              connectionRequirement: { definitionId: "apple-messages", kind: "computer" },
              id: serverId,
            },
          ],
          skills: [],
          tools: [
            tool("con_mac_mini", "query_messages", true),
            tool("con_mac_mini", "export_attachment", true),
            tool("con_macbook", "query_messages", true),
            tool("con_macbook", "export_attachment", true),
            tool("con_macbook", "send_message", false),
          ],
        },
      ],
    },
    request: { access, installationId, kind: "integration.access", requestedServerId: serverId },
  } as unknown as LoadedAccessRequest;
}

function requestPage(ids: readonly string[], hasMore: boolean, nextBefore: string | null) {
  return {
    data: {
      requests: ids.map((id) => ({ id })),
      threadId: "thread-one",
      window: {
        byteCount: 2,
        hasMore,
        itemCount: ids.length,
        nextBefore,
        totalItems: ids.length,
      },
    },
    ok: true as const,
  };
}
