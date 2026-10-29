import { createId, type UserId } from "@opensteer/core";
import type { CallableIntegrationTool } from "@opensteer/database";
import type { PendingAgentEvent } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  integrationCallSubject,
  type IntegrationCallSubjectSources,
} from "./integration-call-subject.js";

const grantId = "igr_5b0c4c3e-1f7a-4a8e-9a53-6c1e2d3f4a5b";
const toolId = "itl_9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const digest = "a".repeat(43);
const toolRef = `${grantId}.${toolId}.${digest}`;
const owner = createId("user");
const connectionId = "icn_0f1e2d3c-4b5a-4968-8776-655443322110";
const runnerId = createId("runner");

function started(
  args: unknown,
  tool: { readonly name: string; readonly namespace: string } = {
    name: "integration_call",
    namespace: "opensteer.integrations",
  },
): PendingAgentEvent {
  return {
    bindingGeneration: 1,
    data: { arguments: args, callId: "call-1", tool },
    emittedAt: "2026-09-22T12:00:00.000Z",
    environmentId: createId("environment"),
    ordinal: 3,
    runId: createId("run"),
    threadId: createId("thread"),
    type: "tool.started",
    workspaceId: createId("workspace"),
  };
}

function slackApp(): CallableIntegrationTool {
  return {
    grant: { alias: "Slack on Alex's Mac", connectionId, id: grantId },
    installation: { title: "Computer use" },
    server: { transport: { definitionId: "macos-app", type: "computer" } },
    tool: {
      annotations: { readOnlyHint: false },
      id: toolId,
      name: "act",
      schemaDigest: digest,
      title: "Act",
    },
  } as unknown as CallableIntegrationTool;
}

function gmail(): CallableIntegrationTool {
  return {
    grant: { alias: "Work", connectionId: null, id: grantId },
    installation: { title: "Gmail" },
    server: { transport: { type: "streamable-http", url: "https://mcp.example.test" } },
    tool: {
      annotations: { readOnlyHint: true },
      id: toolId,
      name: "search_messages",
      schemaDigest: digest,
      title: "Search messages",
    },
  } as unknown as CallableIntegrationTool;
}

function sources(
  callable: CallableIntegrationTool | null,
  overrides: Partial<IntegrationCallSubjectSources> = {},
) {
  return {
    listCallableTools: vi.fn(async () => (callable ? [callable] : [])),
    getComputerConnectionForCall: vi.fn(async () => ({
      access: "read-write" as const,
      connection: {
        computer: {
          access: "read-write" as const,
          app: {
            bundleId: "com.tinyspeck.slackmacgap",
            displayName: "Slack",
            teamId: "BQR82RBBHL",
          },
          blockedAt: null,
          policyRevision: null,
          runnerId,
        },
      },
      runnerId,
      runnerName: "Alex's MacBook Pro",
      runnerRevoked: false,
    })),
    onError: vi.fn(),
    runRequester: vi.fn(async (): Promise<UserId | null> => owner),
    ...overrides,
  } as IntegrationCallSubjectSources & {
    readonly listCallableTools: ReturnType<typeof vi.fn>;
    readonly getComputerConnectionForCall: ReturnType<typeof vi.fn>;
    readonly onError: ReturnType<typeof vi.fn>;
    readonly runRequester: ReturnType<typeof vi.fn>;
  };
}

function phoneAct(): CallableIntegrationTool {
  return {
    grant: { alias: "Pixel 8", connectionId, id: grantId },
    installation: { title: "Android phone" },
    server: { transport: { definitionId: "android-phone", type: "computer" } },
    tool: {
      annotations: { readOnlyHint: false },
      id: toolId,
      name: "act",
      schemaDigest: digest,
      title: "Act",
    },
  } as unknown as CallableIntegrationTool;
}

describe("integrationCallSubject", () => {
  // A phone's connection names no app, so its call names the phone instead,
  // and a phone connection that somehow names an app names nothing at all.
  it("names the phone for an Android phone call, and no app", async () => {
    const phoneConnection = {
      access: "read-write" as const,
      connection: {
        computer: {
          access: "read-write" as const,
          app: null,
          blockedAt: null,
          policyRevision: null,
          runnerId,
        },
      },
      runnerId,
      runnerName: "Pixel 8",
      runnerRevoked: false,
    };
    const source = sources(phoneAct(), {
      getComputerConnectionForCall: vi.fn(async () => phoneConnection) as never,
    });

    await expect(integrationCallSubject(source, started({ toolRef }))).resolves.toEqual({
      account: "Pixel 8",
      computerApp: null,
      effect: "write",
      integration: "Android phone",
      operation: { name: "act", title: "Act" },
      phone: { computer: "Pixel 8", runnerId },
    });
    const confused = sources(phoneAct());
    await expect(integrationCallSubject(confused, started({ toolRef }))).resolves.toBeUndefined();
  });

  it("names an ordinary integration's account and operation, with no app", async () => {
    const source = sources(gmail());

    await expect(
      integrationCallSubject(source, started({ arguments: { query: "invoice" }, toolRef })),
    ).resolves.toEqual({
      account: "Work",
      computerApp: null,
      effect: "read",
      integration: "Gmail",
      operation: { name: "search_messages", title: "Search messages" },
    });
    expect(source.getComputerConnectionForCall).not.toHaveBeenCalled();
  });

  it("names what integration_describe was asked about", async () => {
    const source = sources(gmail());

    await expect(
      integrationCallSubject(
        source,
        started({ toolRef }, { name: "integration_describe", namespace: "opensteer.integrations" }),
      ),
    ).resolves.toMatchObject({ integration: "Gmail", operation: { name: "search_messages" } });
  });

  it("names nothing for a reference that resolves to no tool", async () => {
    const source = sources(null);

    await expect(integrationCallSubject(source, started({ toolRef }))).resolves.toBeUndefined();
    expect(source.onError).not.toHaveBeenCalled();
  });

  it("names nothing, and looks nothing up, for a reference that does not parse", async () => {
    const source = sources(gmail());

    for (const args of [
      { toolRef: "gmail.search_messages" },
      { toolRef: `${grantId}.${toolId}` },
      { toolRef: 42 },
      {},
      "not an object",
      null,
    ]) {
      await expect(integrationCallSubject(source, started(args))).resolves.toBeUndefined();
    }
    expect(source.runRequester).not.toHaveBeenCalled();
    expect(source.listCallableTools).not.toHaveBeenCalled();
  });

  it("leaves every other tool and event alone", async () => {
    const source = sources(gmail());

    for (const tool of [
      { name: "integration_search", namespace: "opensteer.integrations" },
      { name: "integration_call", namespace: "mcp:someone_else" },
      { name: "integration_call", namespace: "opensteer" },
    ]) {
      await expect(integrationCallSubject(source, started({ toolRef }, tool))).resolves.toBe(
        undefined,
      );
    }
    const completed: PendingAgentEvent = {
      ...started({ toolRef }),
      data: { callId: "call-1", isError: false, output: { text: "done" } },
      type: "tool.completed",
    } as PendingAgentEvent;
    await expect(integrationCallSubject(source, completed)).resolves.toBeUndefined();
    expect(source.runRequester).not.toHaveBeenCalled();
  });

  it("names nothing for a Computer use call whose app is no longer on a Mac", async () => {
    const source = sources(slackApp(), { getComputerConnectionForCall: vi.fn(async () => null) });

    await expect(integrationCallSubject(source, started({ toolRef }))).resolves.toBeUndefined();
    expect(source.onError).not.toHaveBeenCalled();
  });

  it("names nothing for a Computer use grant without a connection", async () => {
    const callable = slackApp();
    const source = sources({ ...callable, grant: { ...callable.grant, connectionId: null } });

    await expect(integrationCallSubject(source, started({ toolRef }))).resolves.toBeUndefined();
    expect(source.getComputerConnectionForCall).not.toHaveBeenCalled();
  });

  it("names only the grant and tool the reference names", async () => {
    const otherGrant = {
      ...gmail(),
      grant: { ...gmail().grant, id: "igr_00000000-0000-4000-8000-000000000001" },
    } as unknown as CallableIntegrationTool;
    const otherTool = {
      ...gmail(),
      tool: { ...gmail().tool, id: "itl_00000000-0000-4000-8000-000000000002" },
    } as unknown as CallableIntegrationTool;
    const source = sources(null, {
      listCallableTools: vi.fn(async () => [otherGrant, otherTool]),
    });

    await expect(integrationCallSubject(source, started({ toolRef }))).resolves.toBeUndefined();
  });

  it("reports a failed lookup and names nothing, so the event still commits", async () => {
    const failure = new Error("the database is away");
    const source = sources(gmail(), {
      listCallableTools: vi.fn(async () => {
        throw failure;
      }),
    });
    const event = started({ toolRef });

    await expect(integrationCallSubject(source, event)).resolves.toBeUndefined();
    expect(source.onError).toHaveBeenCalledWith(failure, event);
  });

  it("reports a subject the event contract cannot carry rather than storing it", async () => {
    const callable = gmail();
    const source = sources({
      ...callable,
      installation: { ...callable.installation, title: "G".repeat(241) },
    });

    await expect(integrationCallSubject(source, started({ toolRef }))).resolves.toBeUndefined();
    expect(source.onError).toHaveBeenCalledOnce();
  });
});
