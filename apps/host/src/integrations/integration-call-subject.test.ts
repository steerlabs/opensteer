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
const owner = createId("user");
const connectionId = "con_0f1e2d3c-4b5a-4968-8776-655443322110";
const appAddress = { account: connectionId, operation: "act" };
const gmailAddress = { operation: "search_messages" };
const runnerId = createId("runner");

function started(
  args: unknown,
  tool: { readonly name: string; readonly namespace: string } = {
    name: "integration_call",
    namespace: "opensteer",
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

    await expect(integrationCallSubject(source, started(appAddress))).resolves.toEqual({
      account: "Pixel 8",
      computerApp: null,
      effect: "write",
      integration: "Android phone",
      operation: { name: "act", title: "Act" },
      phone: { computer: "Pixel 8", runnerId },
    });
    const confused = sources(phoneAct());
    await expect(integrationCallSubject(confused, started(appAddress))).resolves.toBeUndefined();
  });

  // The one Opensteer server reports `opensteer`; a native session resumed from
  // before it still reports the retired `opensteer_integrations` server's calls.
  it("names an ordinary integration's account and operation, with no app", async () => {
    for (const namespace of ["opensteer", "opensteer.integrations"]) {
      const source = sources(gmail());

      await expect(
        integrationCallSubject(
          source,
          started(
            { ...gmailAddress, arguments: { query: "invoice" } },
            { name: "integration_call", namespace },
          ),
        ),
      ).resolves.toEqual({
        account: "Work",
        computerApp: null,
        effect: "read",
        integration: "Gmail",
        operation: { name: "search_messages", title: "Search messages" },
      });
      expect(source.getComputerConnectionForCall).not.toHaveBeenCalled();
    }
  });

  it("names what integration_describe was asked about", async () => {
    const source = sources(gmail());

    await expect(
      integrationCallSubject(
        source,
        started(gmailAddress, { name: "integration_describe", namespace: "opensteer" }),
      ),
    ).resolves.toMatchObject({ integration: "Gmail", operation: { name: "search_messages" } });
  });

  it("names nothing for an address that resolves to no tool", async () => {
    const source = sources(null);

    await expect(integrationCallSubject(source, started(gmailAddress))).resolves.toBeUndefined();
    expect(source.onError).not.toHaveBeenCalled();
  });

  it("names nothing, and looks nothing up, for an address that does not parse", async () => {
    const source = sources(gmail());

    for (const args of [
      { toolRef: `${grantId}.${toolId}.${digest}` },
      { operation: 42 },
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
      { name: "integration_search", namespace: "opensteer" },
      { name: "integration_call", namespace: "mcp:someone_else" },
      { name: "integration_call", namespace: "functions" },
    ]) {
      await expect(integrationCallSubject(source, started(gmailAddress, tool))).resolves.toBe(
        undefined,
      );
    }
    const completed: PendingAgentEvent = {
      ...started(gmailAddress),
      data: { callId: "call-1", isError: false, output: { text: "done" } },
      type: "tool.completed",
    } as PendingAgentEvent;
    await expect(integrationCallSubject(source, completed)).resolves.toBeUndefined();
    expect(source.runRequester).not.toHaveBeenCalled();
  });

  it("names nothing for a Computer use call whose app is no longer on a Mac", async () => {
    const source = sources(slackApp(), { getComputerConnectionForCall: vi.fn(async () => null) });

    await expect(integrationCallSubject(source, started(appAddress))).resolves.toBeUndefined();
    expect(source.onError).not.toHaveBeenCalled();
  });

  it("names nothing for a Computer use grant without a connection", async () => {
    const callable = slackApp();
    const source = sources({ ...callable, grant: { ...callable.grant, connectionId: null } });

    await expect(
      integrationCallSubject(source, started({ operation: "act" })),
    ).resolves.toBeUndefined();
    expect(source.getComputerConnectionForCall).not.toHaveBeenCalled();
  });

  it("names only the account the call addressed, never another one", async () => {
    const personal = {
      ...gmail(),
      grant: { ...gmail().grant, alias: "Personal", connectionId },
    } as unknown as CallableIntegrationTool;
    const source = sources(null, { listCallableTools: vi.fn(async () => [personal]) });

    await expect(
      integrationCallSubject(
        source,
        started({
          account: "con_00000000-0000-4000-8000-000000000001",
          operation: "search_messages",
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      integrationCallSubject(
        source,
        started({ account: connectionId, operation: "search_messages" }),
      ),
    ).resolves.toMatchObject({ account: "Personal" });
  });

  it("reports a failed lookup and names nothing, so the event still commits", async () => {
    const failure = new Error("the database is away");
    const source = sources(gmail(), {
      listCallableTools: vi.fn(async () => {
        throw failure;
      }),
    });
    const event = started(gmailAddress);

    await expect(integrationCallSubject(source, event)).resolves.toBeUndefined();
    expect(source.onError).toHaveBeenCalledWith(failure, event);
  });

  it("reports a subject the event contract cannot carry rather than storing it", async () => {
    const callable = gmail();
    const source = sources({
      ...callable,
      installation: { ...callable.installation, title: "G".repeat(241) },
    });

    await expect(integrationCallSubject(source, started(gmailAddress))).resolves.toBeUndefined();
    expect(source.onError).toHaveBeenCalledOnce();
  });
});
