import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createId, type AgentCapabilityProfileId, type Request } from "@opensteer/core";
import { toolsForCapabilityProfile } from "@opensteer/agent-tools";
import { AgentControlRequestSchema, createBrowserSessionId } from "@opensteer/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentControlService, type AgentControlTokenService } from "./agent-control-service.js";
import { AgentToolsMcpService } from "./agent-tools-mcp-service.js";
import type {
  TriggerControlService,
  TriggerControlTokenService,
} from "../triggers/trigger-control-service.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe("AgentToolsMcpService", () => {
  it("bounds tool argument elements before validation and remains usable", async () => {
    const handle = vi.fn(async (_token: string, request: unknown) => ({
      requestId: (request as { requestId: string }).requestId,
      result: { accepted: true },
      type: "thread.message.result" as const,
    }));
    const fixture = await startService({
      agentControl: { handle } as unknown as AgentControlService,
      profiles: { "run-token": "workspace" },
    });
    const client = await connectClient(fixture.url, "run-token");
    try {
      const message = { delivery: "queue", message: "hello", threadId: createId("thread") };
      const atLimit = await client.callTool({
        name: "thread_message",
        arguments: {
          ...message,
          extra: Array.from({ length: 9_996 }, () => 1),
        },
      });
      expect(atLimit.isError).toBe(true);
      expect(JSON.stringify(atLimit.content)).not.toContain("maximum of 10000 elements");
      const rejected = await client.callTool({
        name: "thread_message",
        arguments: {
          ...message,
          extra: Array.from({ length: 10_001 }, () => 1),
        },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content)).toContain("maximum of 10000 elements");
      expect(
        (await client.callTool({ name: "thread_message", arguments: message })).isError,
      ).not.toBe(true);
      const places = Array.from({ length: 63 }, (_, index) => ({
        type: "browser-page",
        sessionId: createBrowserSessionId(),
        tabId: `tab-${index}`,
        title: "A page",
        url: "https://example.com/",
      }));
      await client.callTool({
        name: "thread_delegate",
        arguments: { threadId: message.threadId, task: "Continue", places },
      });
      expect(handle).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await fixture.service.close();
    }
  });

  it("rejects oversized JSON-RPC batches on an established session", async () => {
    const fixture = await startService({
      agentControl: { handle: vi.fn() } as unknown as AgentControlService,
      profiles: { "run-token": "workspace" },
    });
    const client = await connectClient(fixture.url, "run-token");
    try {
      const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId;
      if (!sessionId) throw new Error("Missing session");
      const response = await fetch(fixture.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer run-token",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify(
          Array.from({ length: 101 }, (_, id) => ({ jsonrpc: "2.0", id, method: "tools/list" })),
        ),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Batch must not exceed 100");
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await fixture.service.close();
    }
  });
  it.each(["main", "workspace", "delegated", "trigger"] as const)(
    "offers environment discovery to %s without legacy workspace inputs",
    async (profile) => {
      const fixture = await startService({
        agentControl: { handle: vi.fn() } as unknown as AgentControlService,
        profiles: { "run-token": profile },
      });
      const client = await connectClient(fixture.url, "run-token");
      try {
        const { tools } = await client.listTools();
        expect(tools.map(({ name }) => name)).toContain("environment_list");
        const workspace = tools.find(({ name }) => name === "workspace_list");
        if (workspace) {
          expect(workspace.inputSchema.properties).not.toHaveProperty("modelPage");
          expect(workspace.inputSchema.properties).not.toHaveProperty("harnessCursor");
        }
        expect(tools.find(({ name }) => name === "thread_delegate")?.description).toContain(
          "environment_list",
        );
      } finally {
        await client.close();
        await fixture.service.close();
      }
    },
  );

  /*
   * A Run outlives the Host process and the Host's idle sweep, so its engine
   * keeps sending the MCP session id it was given:
   * - a session the Host no longer holds answered 404 leaves an engine that
   *   never re-initializes without its tools for the rest of the Run;
   * - serving such a session must still demand the Run's valid token;
   * - a stream request for it must be answered, not fail the Host.
   */
  it("serves a Run's session after the Host forgot it, on the Run's token alone", async () => {
    const handle = vi.fn(async (_token: string, request: unknown) => ({
      requestId: (request as { requestId: string }).requestId,
      result: { accepted: true },
      type: "thread.message.result" as const,
    }));
    const fixture = await startService({
      agentControl: { handle } as unknown as AgentControlService,
      profiles: { "run-token": "workspace" },
    });
    const client = await connectClient(fixture.url, "run-token");
    const message = { delivery: "queue", message: "hello", threadId: createId("thread") };
    expect(
      (await client.callTool({ arguments: message, name: "thread_message" })).isError,
    ).not.toBe(true);
    const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId;
    if (!sessionId) throw new Error("The client was given no session");

    // What a Host restart or the idle sweep leaves behind.
    await fixture.service.close();

    expect(
      (await client.callTool({ arguments: message, name: "thread_message" })).isError,
    ).not.toBe(true);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(handle).toHaveBeenCalledTimes(2);
    const [first, second] = handle.mock.calls.map(
      ([, request]) => (request as { requestId: string }).requestId,
    );
    expect(second).not.toBe(first);

    const refused = await fetch(fixture.url, {
      body: JSON.stringify({ id: 9, jsonrpc: "2.0", method: "tools/list" }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer someone-else",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      method: "POST",
    });
    expect(refused.status).toBe(401);

    const stream = await fetch(fixture.url, {
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer run-token",
        "mcp-session-id": sessionId,
      },
      method: "GET",
    });
    expect(stream.status).toBe(405);
    await client.close();
    await fixture.service.close();
  });

  it("decides a previous-release Run's inventory once per session, from the Run's Runner", async () => {
    let advertisesCurrentCatalog = false;
    const runnerCapabilities = vi.fn(async () =>
      runnerRelease({ previousRelease: !advertisesCurrentCatalog }),
    );
    const fixture = await startService({
      agentControl: { handle: vi.fn() } as unknown as AgentControlService,
      runnerCapabilities,
      profiles: { "run-token": "main" },
    });
    const client = await connectClient(fixture.url, "run-token");
    const names = async () => (await client.listTools()).tools.map(({ name }) => name);
    expect(await names()).toEqual(expect.arrayContaining(["browser_profile_save"]));
    // A held session keeps what it was given, whatever the source says while
    // its Runner reconnects.
    advertisesCurrentCatalog = true;
    expect(await names()).toEqual(expect.arrayContaining(["browser_profile_save"]));
    expect(await names()).toEqual(expect.arrayContaining(["browser_sign_in"]));
    expect(runnerCapabilities).toHaveBeenCalledTimes(1);

    // A session the Host forgot asks its Run's Runner again.
    advertisesCurrentCatalog = false;
    await fixture.service.close();
    expect(await names()).toEqual(expect.arrayContaining(["browser_profile_save"]));
    expect(runnerCapabilities).toHaveBeenCalledTimes(2);
    await client.close();
    await fixture.service.close();
  });

  it("accepts legacy message delivery syntax for a version 1 Trigger session", async () => {
    const handle = vi.fn(async (_token: string, request: unknown) => ({
      requestId: (request as { requestId: string }).requestId,
      result: { accepted: true },
      type: "thread.message.result" as const,
    }));
    const fixture = await startService({
      agentControl: { handle: vi.fn() } as unknown as AgentControlService,
      profiles: {},
      triggerControl: { handle } as unknown as TriggerControlService,
      triggerToken: "legacy-trigger",
    });
    const client = await connectClient(fixture.url, "legacy-trigger");
    const listed = await client.listTools();
    expect(listed.tools.find(({ name }) => name === "thread_message")?.description).toContain(
      "delivery queue records passive context",
    );
    expect(listed.tools.find(({ name }) => name === "trigger_write")?.description).toContain(
      "do not accept toolContractVersion",
    );

    for (const delivery of ["queue", "trigger"] as const) {
      const result = await client.callTool({
        arguments: { delivery, message: "legacy", threadId: createId("thread") },
        name: "thread_message",
      });
      expect(result.isError).not.toBe(true);
    }
    expect(
      handle.mock.calls.map(([, request]) => (request as { delivery: string }).delivery),
    ).toEqual(["queue", "trigger"]);
    await client.close();
    await fixture.service.close();
  });

  it("projects the complete Main profile through authenticated Streamable HTTP", async () => {
    const workspaceId = createId("workspace");
    const createdRequest = pendingBrowserRequest(workspaceId);
    const withdrawnRequest: Request = {
      ...createdRequest,
      resolvedAt: "2026-08-22T20:00:00.000Z",
      resolvedBy: createdRequest.requestedBy,
      status: "withdrawn",
    };
    const handle = vi.fn(async (_token: string, request: unknown) => {
      const value = request as { readonly requestId: string; readonly type: string };
      if (value.type === "request.list") {
        return {
          requestId: value.requestId,
          requests: [createdRequest],
          type: "request.list.result" as const,
          window: { ...emptyWindow(), itemCount: 1, totalItems: 1 },
        };
      }
      if (value.type === "request.withdraw") {
        return {
          request: withdrawnRequest,
          requestId: value.requestId,
          type: "request.withdraw.result" as const,
        };
      }
      if (value.type === "browser.profile.list") {
        return {
          profiles: [],
          requestId: value.requestId,
          type: "browser.profile.list.result" as const,
        };
      }
      if (value.type === "browser.session.list") {
        return {
          requestId: value.requestId,
          sessions: [],
          type: "browser.session.list.result" as const,
        };
      }
      if (value.type === "browser.access.request") {
        return {
          requestId: value.requestId,
          result: {
            kind: "browser.access" as const,
            replayed: false,
            requestId: createdRequest.id,
            status: "pending" as const,
          },
          type: "browser.access.request.result" as const,
        };
      }
      if (value.type === "workspace.create") {
        return {
          requestId: value.requestId,
          type: "workspace.create.result" as const,
          workspace: {
            capacity: { kind: "managed-quota" as const },
            createdAt: "2026-09-24T00:00:00.000Z",
            id: workspaceId,
            kind: "specialized" as const,
            location: { kind: "shared-storage" as const },
            name: "Travel",
            status: "ready" as const,
            storageIssue: null,
            updatedAt: "2026-09-24T00:00:00.000Z",
          },
        };
      }
      if (value.type !== "workspace.list") throw new Error("unexpected tool request");
      return {
        environments: [],
        environmentsTruncated: false,
        harnesses: [],
        harnessesTruncated: false,
        requestId: value.requestId,
        threads: [],
        threadWindow: emptyWindow(),
        type: "workspace.list.result" as const,
        workspaces: [
          {
            id: workspaceId,
            kind: "specialized" as const,
            name: "Client",
            status: "ready" as const,
          },
        ],
        window: { ...emptyWindow(), itemCount: 1, totalItems: 1 },
      };
    });
    const fixture = await startService({
      agentControl: { handle } as unknown as AgentControlService,
      profiles: { "main-token": "main" },
    });
    const client = await connectClient(fixture.url, "main-token");

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toContain("browser_profile_list");
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "request_list",
      "request_withdraw",
      "environment_list",
      "workspace_list",
      "workspace_create",
      "workspace_mount",
      "thread_read",
      "thread_list",
      "thread_delegate",
      "assignment_cancel",
      "thread_message",
      "thread_write",
      "browser_profile_list",
      "sign_in",
      "browser_access_request",
      "machine_full_disk_access_request",
      "browser_tab_read",
      "browser_tab_write",
      "browser_session_list",
      "browser_session_open",
      "browser_profile_create",
      "browser_session_close",
      "trigger_read",
      "trigger_write",
    ]);
    // What the agent discovers is the whole creation contract, icons included.
    const createSchema = listed.tools.find(({ name }) => name === "workspace_create")?.inputSchema;
    expect(Object.keys(createSchema?.properties ?? {}).sort()).toEqual([
      "backing",
      "color",
      "environmentId",
      "icon",
      "name",
    ]);
    expect(createSchema?.properties?.icon).toMatchObject({
      enum: expect.arrayContaining(["mail", "plane", "tag"]),
    });
    expect(createSchema?.required).toEqual(["name"]);
    const created = await client.callTool({
      arguments: { backing: "portablefs", icon: "plane", name: "Travel" },
      name: "workspace_create",
    });
    expect(created.isError).not.toBe(true);
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({
        icon: "plane",
        name: "Travel",
        storage: { backing: "portablefs" },
        type: "workspace.create",
      }),
    );
    const misplacedMachine = await client.callTool({
      arguments: { backing: "portablefs", environmentId: createId("environment"), name: "Travel" },
      name: "workspace_create",
    });
    expect(misplacedMachine.isError).toBe(true);
    const result = await client.callTool({
      arguments: { limit: 10 },
      name: "workspace_list",
    });
    expect(result.structuredContent).toEqual({
      window: { ...emptyWindow(), itemCount: 1, totalItems: 1 },
      workspaces: [{ id: workspaceId, kind: "specialized", name: "Client", status: "ready" }],
    });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({ limit: 10, type: "workspace.list" }),
    );
    const browserProfiles = await client.callTool({
      arguments: {},
      name: "browser_profile_list",
    });
    expect(browserProfiles.structuredContent).toEqual({ profiles: [] });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({ type: "browser.profile.list" }),
    );
    const browserSessions = await client.callTool({
      arguments: {},
      name: "browser_session_list",
    });
    expect(browserSessions.structuredContent).toEqual({ sessions: [] });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({ type: "browser.session.list" }),
    );
    const browserAccess = await client.callTool({
      arguments: {
        reason: "Sign in to the client portal",
        suggestion: { kind: "user_choice" },
        workspaceId,
      },
      name: "browser_access_request",
    });
    expect(browserAccess.structuredContent).toEqual({
      kind: "browser.access",
      replayed: false,
      requestId: createdRequest.id,
      status: "pending",
    });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({
        reason: "Sign in to the client portal",
        suggestion: { kind: "user_choice" },
        type: "browser.access.request",
        workspaceId,
      }),
    );
    const requests = await client.callTool({ arguments: { limit: 10 }, name: "request_list" });
    expect(requests.structuredContent).toEqual({
      requests: [createdRequest],
      window: { ...emptyWindow(), itemCount: 1, totalItems: 1 },
    });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({ limit: 10, type: "request.list" }),
    );
    const withdrawn = await client.callTool({
      arguments: { requestId: createdRequest.id },
      name: "request_withdraw",
    });
    expect(withdrawn.structuredContent).toEqual({ request: withdrawnRequest });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({
        targetRequestId: createdRequest.id,
        type: "request.withdraw",
      }),
    );
    await client.close();
    await fixture.service.close();
  });

  it("includes thread_list, workspace-only listing, and the message delivery outcome", async () => {
    const workspaceId = createId("workspace");
    const environmentId = createId("environment");
    const harnessInstanceId = createId("harnessInstance");
    const threadId = createId("thread");
    const workspace = {
      id: workspaceId,
      kind: "specialized" as const,
      name: "Client",
      status: "ready" as const,
    };
    const environment = {
      compatibleHarnessInstanceIds: [harnessInstanceId],
      connected: true,
      id: environmentId,
      kind: "local" as const,
      name: "Local Runner",
    };
    const summary = {
      environmentConnected: true,
      environmentId,
      id: threadId,
      parentThreadId: null,
      status: "idle" as const,
      title: "Research",
      updatedAt: "2026-08-09T09:00:00.000Z",
      workspaceId,
      workspaceName: "Client",
    };
    const handle = vi.fn(async (_token: string, request: unknown) => {
      const value = request as { readonly requestId: string; readonly type: string };
      if (value.type === "workspace.list") {
        return {
          environments: [environment],
          environmentsTruncated: false,
          harnesses: [],
          harnessesTruncated: false,
          requestId: value.requestId,
          threads: [],
          threadWindow: emptyWindow(),
          type: "workspace.list.result" as const,
          workspaces: [workspace],
          window: { ...emptyWindow(), itemCount: 1, totalItems: 1 },
        };
      }
      if (value.type === "thread.list") {
        return {
          requestId: value.requestId,
          threads: [summary],
          type: "thread.list.result" as const,
          window: { ...emptyWindow(), itemCount: 1, totalItems: 1 },
        };
      }
      if (value.type !== "thread.message") throw new Error("unexpected tool request");
      return {
        requestId: value.requestId,
        result: {
          disposition: "pending" as const,
          input: { messageId: createId("message") },
          message: { id: createId("message") },
          run: null,
          thread: { id: threadId },
        },
        type: "thread.message.result" as const,
      };
    });
    const fixture = await startService({
      agentControl: { handle } as unknown as AgentControlService,
      profiles: { "main-token": "main" },
    });
    const client = await connectClient(fixture.url, "main-token");

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "request_list",
      "request_withdraw",
      "environment_list",
      "workspace_list",
      "workspace_create",
      "workspace_mount",
      "thread_read",
      "thread_list",
      "thread_delegate",
      "assignment_cancel",
      "thread_message",
      "thread_write",
      "browser_profile_list",
      "sign_in",
      "browser_access_request",
      "machine_full_disk_access_request",
      "browser_tab_read",
      "browser_tab_write",
      "browser_session_list",
      "browser_session_open",
      "browser_profile_create",
      "browser_session_close",
      "trigger_read",
      "trigger_write",
    ]);

    const workspaces = await client.callTool({ arguments: { limit: 10 }, name: "workspace_list" });
    expect(workspaces.structuredContent).toEqual({
      window: { ...emptyWindow(), itemCount: 1, totalItems: 1 },
      workspaces: [workspace],
    });

    const threads = await client.callTool({
      arguments: { limit: 5, query: "res", workspaceId },
      name: "thread_list",
    });
    expect(threads.structuredContent).toEqual({
      threads: [summary],
      window: { ...emptyWindow(), itemCount: 1, totalItems: 1 },
    });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({ limit: 5, query: "res", type: "thread.list", workspaceId }),
    );

    const delivered = await client.callTool({
      arguments: { delivery: "queue", message: "Status?", threadId },
      name: "thread_message",
    });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({ delivery: "queue", type: "thread.message" }),
    );
    expect(delivered.structuredContent).toMatchObject({ disposition: "pending" });
    expect(JSON.parse((delivered.content as { text: string }[])[0]!.text)).toMatchObject({
      disposition: "pending",
    });
    await client.close();
    await fixture.service.close();
  });

  it("gives the model no way to author message attribution", async () => {
    const threadId = createId("thread");
    const handle = vi.fn(async (_token: string, request: unknown) => ({
      requestId: (request as { readonly requestId: string }).requestId,
      result: {
        disposition: "pending" as const,
        input: { messageId: createId("message") },
        message: { id: createId("message") },
        run: null,
        thread: { id: threadId },
      },
      type: "thread.message.result" as const,
    }));
    const fixture = await startService({
      agentControl: { handle } as unknown as AgentControlService,
      profiles: { "main-token": "main" },
    });
    const client = await connectClient(fixture.url, "main-token");

    // Attribution is Host-authored: the published tool contract has nowhere to put it.
    const listed = await client.listTools();
    const messageTool = listed.tools.find(({ name }) => name === "thread_message");
    expect(Object.keys(messageTool?.inputSchema.properties ?? {}).sort()).toEqual([
      "delivery",
      "message",
      "observationId",
      "threadId",
    ]);
    const delegateTool = listed.tools.find(({ name }) => name === "thread_delegate");
    expect(Object.keys(delegateTool?.inputSchema.properties ?? {})).not.toContain("sourceThreadId");
    expect(Object.keys(delegateTool?.inputSchema.properties ?? {})).not.toContain("sourceRunId");

    // A crafted call carrying source fields is refused before it reaches the Host.
    const crafted = await client.callTool({
      arguments: {
        delivery: "queue",
        message: "Status?",
        sourceRunId: createId("run"),
        sourceThreadId: createId("thread"),
        threadId,
      },
      name: "thread_message",
    });
    expect(crafted.isError).toBe(true);
    expect(handle).not.toHaveBeenCalled();

    // The same call without them is ordinary, and still carries no attribution.
    await client.callTool({
      arguments: { delivery: "queue", message: "Status?", threadId },
      name: "thread_message",
    });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({ threadId, type: "thread.message" }),
    );
    for (const [, request] of handle.mock.calls) {
      expect(request).not.toHaveProperty("sourceRunId");
      expect(request).not.toHaveProperty("sourceThreadId");
    }
    await client.close();
    await fixture.service.close();
  });

  it("registers only the bounded delegated profile", async () => {
    const fixture = await startService({
      agentControl: { handle: vi.fn() } as unknown as AgentControlService,
      profiles: { "delegated-token": "delegated" },
    });
    const client = await connectClient(fixture.url, "delegated-token");

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        { name: "request_list" },
        { name: "request_withdraw" },
        { name: "environment_list" },
        { name: "thread_read" },
        { name: "thread_list" },
        { name: "thread_delegate" },
        { name: "assignment_cancel" },
        { name: "thread_message" },
        { name: "thread_write" },
        { name: "browser_profile_list" },
        { name: "sign_in" },
        { name: "browser_tab_read" },
        { name: "browser_tab_write" },
        { name: "browser_session_list" },
        { name: "browser_session_open" },
        { name: "trigger_read" },
        { name: "trigger_write" },
      ],
    });
    await client.close();
    await fixture.service.close();
  });

  it("publishes role-specific browser access schemas", async () => {
    const fixture = await startService({
      agentControl: { handle: vi.fn() } as unknown as AgentControlService,
      profiles: { "main-token": "main", "workspace-token": "workspace" },
    });
    const mainClient = await connectClient(fixture.url, "main-token");
    const workspaceClient = await connectClient(fixture.url, "workspace-token");

    const mainTool = (await mainClient.listTools()).tools.find(
      ({ name }) => name === "browser_access_request",
    );
    const workspaceTool = (await workspaceClient.listTools()).tools.find(
      ({ name }) => name === "browser_access_request",
    );
    expect(mainTool?.inputSchema.required).toContain("workspaceId");
    expect(mainTool?.inputSchema.properties).toHaveProperty("workspaceId");
    expect(workspaceTool?.inputSchema.required).not.toContain("workspaceId");
    expect(workspaceTool?.inputSchema.properties).not.toHaveProperty("workspaceId");
    expect(mainTool?.description).toContain("its exact workspaceId");
    expect(workspaceTool?.description).toContain("the target is this Workspace");

    await mainClient.close();
    await workspaceClient.close();
    await fixture.service.close();
  });

  it("returns an actionable browser domain error to the model verbatim", async () => {
    const message =
      "browser_access_request grants a browser profile only to a specialized Workspace. From Main, pass that Workspace's workspaceId. To browse in Main, open a session with an inherited profile from browser_profile_list, or with fresh: true for signed-out browsing.";
    const fixture = await startService({
      agentControl: {
        handle: vi.fn(async () => {
          throw new Error(message);
        }),
      } as unknown as AgentControlService,
      profiles: { "main-token": "main" },
    });
    const client = await connectClient(fixture.url, "main-token");

    const result = await client.callTool({
      arguments: {
        reason: "Research in the client Workspace",
        suggestion: { kind: "user_choice" },
        workspaceId: createId("workspace"),
      },
      name: "browser_access_request",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ text: message, type: "text" }]);
    await client.close();
    await fixture.service.close();
  });

  it("returns a ready lease for a Browser Session and rejects removed fields", async () => {
    const ready = {
      status: "ready",
      site: "https://example.com",
      account: "t•••@example.com",
      loginRef: "lgn_" + "1".repeat(32),
    };
    const handle = vi.fn(async (_token: string, request: unknown) => ({
      requestId: (request as { readonly requestId: string }).requestId,
      result: ready,
      type: "sign-in.result" as const,
    }));
    const fixture = await startService({
      agentControl: { handle } as unknown as AgentControlService,
      profiles: { "main-token": "main" },
    });
    const client = await connectClient(fixture.url, "main-token");
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "sign_in");
    expect(tool?.inputSchema.properties).not.toHaveProperty("code");
    expect(tool?.inputSchema.properties).not.toHaveProperty("targetId");
    const call = {
      reason: "Read the statement",
      sessionId: `bsn_${randomUUID()}`,
      site: "https://example.com",
    };
    const result = await client.callTool({ arguments: call, name: "sign_in" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(ready);
    expect(AgentControlRequestSchema.parse(handle.mock.lastCall?.[1])).toEqual({
      ...call,
      requestId: expect.any(String),
      type: "sign-in",
    });
    for (const args of [
      { ...call, code: "123456" },
      { ...call, targetId: "old-page" },
      { ...call, surfaceId: "unexpected" },
    ]) {
      expect((await client.callTool({ arguments: args, name: "sign_in" })).isError).toBe(true);
    }
    expect(handle).toHaveBeenCalledTimes(1);
    await client.close();
    await fixture.service.close();
  });

  it("expands the split Trigger tools onto the single control operation", async () => {
    const triggerId = createId("trigger");
    const occurrenceId = createId("triggerOccurrence");
    const handle = vi.fn(async (_token: string, request: unknown) => {
      const value = request as { readonly requestId: string };
      return { requestId: value.requestId, result: { ok: true }, type: "trigger.control.result" };
    });
    const fixture = await startService({
      agentControl: { handle } as unknown as AgentControlService,
      profiles: { "main-token": "main" },
    });
    const client = await connectClient(fixture.url, "main-token");

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "request_list",
      "request_withdraw",
      "environment_list",
      "workspace_list",
      "workspace_create",
      "workspace_mount",
      "thread_read",
      "thread_list",
      "thread_delegate",
      "assignment_cancel",
      "thread_message",
      "thread_write",
      "browser_profile_list",
      "sign_in",
      "browser_access_request",
      "machine_full_disk_access_request",
      "browser_tab_read",
      "browser_tab_write",
      "browser_session_list",
      "browser_session_open",
      "browser_profile_create",
      "browser_session_close",
      "trigger_read",
      "trigger_write",
    ]);

    const read = await client.callTool({
      arguments: { action: "get", occurrenceLimit: 5, triggerId },
      name: "trigger_read",
    });
    expect(read.structuredContent).toEqual({ ok: true });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({
        input: { occurrenceLimit: 5, operation: "get", triggerId },
        tool: "trigger.read",
        type: "trigger.control",
      }),
    );

    await client.callTool({
      arguments: { action: "cancel", occurrenceId, triggerId },
      name: "trigger_write",
    });
    expect(handle).toHaveBeenCalledWith(
      "main-token",
      expect.objectContaining({
        input: { occurrenceId, operation: "cancel", triggerId },
        tool: "trigger.write",
        type: "trigger.control",
      }),
    );

    await client.callTool({
      arguments: {
        action: "create",
        anchorThreadId: createId("thread"),
        name: "Nightly report",
        program: {
          toolContractVersion: 2,
          language: "javascript",
          source: "export default () => {}",
        },
        source: { cron: "0 9 * * *", kind: "schedule", timezone: "America/Los_Angeles" },
      },
      name: "trigger_write",
    });
    const created = handle.mock.calls.at(-1)?.[1] as {
      readonly input: { readonly idempotencyKey: string; readonly source: unknown };
      readonly requestId: string;
    };
    expect(created.input.source).toEqual({
      kind: "schedule",
      schedule: {
        expression: "0 9 * * *",
        kind: "cron",
        timezone: "America/Los_Angeles",
      },
    });
    // The model never supplies the key; the control service rewrites it.
    expect(created.input.idempotencyKey).toBe(created.requestId);

    await client.close();
    await fixture.service.close();
  });

  it("reports the missing field and action for an incomplete Trigger tool call", async () => {
    const handle = vi.fn(async () => {
      throw new Error("Unexpected control call");
    });
    const fixture = await startService({
      agentControl: { handle } as unknown as AgentControlService,
      profiles: { "main-token": "main" },
    });
    const client = await connectClient(fixture.url, "main-token");

    const missingTriggerId = await client.callTool({
      arguments: { action: "get" },
      name: "trigger_read",
    });
    expect(missingTriggerId.isError).toBe(true);
    expect(missingTriggerId.content).toEqual([
      { text: 'trigger_read action "get" requires triggerId', type: "text" },
    ]);

    const missingName = await client.callTool({
      arguments: {
        action: "create",
        anchorThreadId: createId("thread"),
        program: {
          toolContractVersion: 2,
          language: "javascript",
          source: "export default () => {}",
        },
        source: { kind: "webhook" },
      },
      name: "trigger_write",
    });
    expect(missingName.isError).toBe(true);
    expect(missingName.content).toEqual([
      { text: 'trigger_write action "create" requires name', type: "text" },
    ]);

    const badSource = await client.callTool({
      arguments: {
        action: "create",
        anchorThreadId: createId("thread"),
        name: "Nightly report",
        program: {
          toolContractVersion: 2,
          language: "javascript",
          source: "export default () => {}",
        },
        source: { cron: "0 9 * * *", kind: "schedule" },
      },
      name: "trigger_write",
    });
    expect(badSource.isError).toBe(true);
    expect(badSource.content).toEqual([
      {
        text: 'source kind "schedule" with cron requires timezone as an IANA name',
        type: "text",
      },
    ]);

    expect(handle).not.toHaveBeenCalled();
    await client.close();
    await fixture.service.close();
  });
});

/** What a Runner of a given release advertises, as far as its tool inventory depends on it. */
function runnerRelease(input: {
  readonly legacyEnvironment?: boolean;
  readonly previousRelease?: boolean;
}): readonly string[] {
  return [
    "task-done-v1",
    ...(input.legacyEnvironment ? [] : ["environment-list-v1"]),
    ...(input.previousRelease ? [] : ["browser-profile-create-v1"]),
  ];
}

async function startService(input: {
  readonly agentControl: AgentControlService;
  readonly profiles: Readonly<Record<string, AgentCapabilityProfileId>>;
  readonly legacyEnvironment?: boolean;
  readonly previousRelease?: boolean;
  readonly runnerCapabilities?: () => Promise<readonly string[]>;
  readonly triggerControl?: TriggerControlService;
  readonly triggerToken?: string;
}): Promise<{ readonly service: AgentToolsMcpService; readonly url: URL }> {
  let service: AgentToolsMcpService;
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readJson(request);
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      await service.handle(request, response, body, token);
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error("Test MCP request failed")),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const url = new URL(`http://127.0.0.1:${address.port}/internal/v1/mcp`);
  const claimsByToken = new Map<string, unknown>();
  const triggerClaims = {
    occurrenceId: createId("triggerOccurrence"),
    toolContractVersion: 1,
  } as Awaited<ReturnType<TriggerControlTokenService["authenticate"]>>;
  service = new AgentToolsMcpService({
    agentControl: input.agentControl,
    runnerCapabilities:
      input.runnerCapabilities ??
      (async () =>
        runnerRelease({
          legacyEnvironment: input.legacyEnvironment ?? false,
          previousRelease: input.previousRelease ?? false,
        })),
    publicUrl: url,
    store: {
      getThreadForOwner: async () =>
        ({ capabilityProfileId: "main" }) as import("@opensteer/core").Thread,
    },
    tokens: {
      authenticate: async (token: string) => {
        const profile = input.profiles[token];
        if (!profile) throw new Error("invalid token");
        const existing = claimsByToken.get(token);
        if (existing) {
          return existing as Awaited<ReturnType<AgentControlTokenService["authenticate"]>>;
        }
        const claims = {
          bindingGeneration: 1,
          capabilityProfileId: profile,
          environmentId: createId("environment"),
          membershipGeneration: 1,
          requestedBy: createId("user"),
          runId: createId("run"),
          runnerBootId: "test-boot",
          runnerId: createId("runner"),
          threadId: createId("thread"),
          workspaceId: createId("workspace"),
        } as Awaited<ReturnType<AgentControlTokenService["authenticate"]>>;
        claimsByToken.set(token, claims);
        return claims;
      },
    } as AgentControlTokenService,
    ...(input.triggerControl ? { triggerControl: input.triggerControl } : {}),
    ...(input.triggerToken
      ? {
          triggerTokens: {
            authenticate: async (token: string) => {
              if (token !== input.triggerToken) throw new Error("invalid token");
              return triggerClaims;
            },
          } as TriggerControlTokenService,
        }
      : {}),
  });
  return { service, url };
}

async function connectClient(url: URL, token: string): Promise<Client> {
  const client = new Client({ name: "opensteer-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
  );
  return client;
}

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function emptyWindow() {
  return {
    byteCount: 0,
    hasMore: false,
    itemCount: 0,
    nextBefore: null,
    totalItems: 0,
  };
}

function pendingBrowserRequest(
  workspaceId: Request["targetWorkspaceId"],
): Extract<Request, { status: "pending" }> {
  const requestId = createId("request");
  return {
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: "2026-08-22T19:00:00.000Z",
    id: requestId,
    kind: "browser.access",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    originatingWorkspaceId: workspaceId,
    payload: {
      kind: "browser.access",
      reason: "Sign in to the client portal",
      suggestion: { kind: "user_choice" },
    },
    presentation: {
      kind: "external",
      subject: { id: requestId, kind: "browser.access" },
      title: "Browser profile access",
    },
    requestedBy: createId("user"),
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: workspaceId,
  };
}

it("routes sessionless sign_in and the previous-release browser alias to the same handler", async () => {
  const ready = {
    status: "ready",
    site: "https://example.com",
    account: "masked",
    loginRef: "lgn_" + "1".repeat(32),
  };
  const handle = vi.fn(async (_token: string, request: unknown) => ({
    requestId: (request as { requestId: string }).requestId,
    result: ready,
    type: "sign-in.result" as const,
  }));
  const fixture = await startService({
    agentControl: { handle } as unknown as AgentControlService,
    profiles: { "main-token": "main" },
    previousRelease: true,
  });
  const client = await connectClient(fixture.url, "main-token");
  try {
    const result = await client.callTool({
      name: "sign_in",
      arguments: { site: ready.site, reason: "Sign in" },
    });
    expect(result.structuredContent).toEqual(ready);
    expect(handle.mock.lastCall?.[1]).toMatchObject({ type: "sign-in", site: ready.site });
    expect(handle.mock.lastCall?.[1]).not.toHaveProperty("sessionId");
    const call = { site: ready.site, reason: "Sign in", sessionId: createBrowserSessionId() };
    const listed = await client.listTools();
    expect(
      listed.tools.find(({ name }) => name === "browser_sign_in")?.inputSchema.required,
    ).toEqual(["reason", "sessionId", "site"]);
    for (const name of ["sign_in", "browser_sign_in"]) {
      const result = await client.callTool({ name, arguments: call });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(ready);
      expect(AgentControlRequestSchema.parse(handle.mock.lastCall?.[1])).toEqual({
        ...call,
        requestId: expect.any(String),
        type: "sign-in",
      });
    }
    for (const arguments_ of [
      { site: ready.site, reason: "Sign in" },
      { ...call, code: "123456" },
      { ...call, targetId: "old-page" },
    ]) {
      expect(
        (await client.callTool({ name: "browser_sign_in", arguments: arguments_ })).isError,
      ).toBe(true);
    }
    expect(handle).toHaveBeenCalledTimes(3);
  } finally {
    await client.close();
    await fixture.service.close();
  }
});

// Profile inventories pinned from 04fb7ce4, before browser_sign_in was renamed.
const previousBrowserProfileTools = [
  "thread_read",
  "thread_list",
  "thread_delegate",
  "thread_message",
  "assignment_cancel",
  "request_list",
  "request_withdraw",
  "browser_profile_list",
  "browser_sign_in",
  "browser_session_list",
  "browser_session_open",
] as const;
const previousWorkspaceProfileTools = [
  ...previousBrowserProfileTools,
  "browser_profile_save",
  "browser_access_request",
  "browser_session_close",
  "machine_full_disk_access_request",
] as const;

it.each([
  [
    "main",
    [
      ...previousWorkspaceProfileTools,
      "workspace_list",
      "workspace_create",
      "workspace_mount",
      "trigger_read",
      "trigger_write",
    ],
  ],
  ["workspace", previousWorkspaceProfileTools],
  ["delegated", previousBrowserProfileTools],
  [
    "trigger",
    [
      "workspace_list",
      "workspace_create",
      "thread_read",
      "thread_delegate",
      "thread_message",
      "trigger_read",
      "trigger_write",
    ],
  ],
] as const)("still serves every previous-release %s tool", async (profile, previousTools) => {
  const fixture = await startService({
    agentControl: { handle: vi.fn() } as unknown as AgentControlService,
    profiles: { token: profile },
    previousRelease: true,
  });
  const client = await connectClient(fixture.url, "token");
  try {
    const served = (await client.listTools()).tools.map(({ name }) => name);
    expect(served).toEqual(expect.arrayContaining([...previousTools]));
    // Codex exposes only the enabled tools before checking its exact inventory.
    expect(served.filter((name) => previousTools.some((tool) => tool === name)).sort()).toEqual(
      [...previousTools].sort(),
    );
    const current = toolsForCapabilityProfile(profile).map(({ name }) => name);
    expect(served.filter((name) => current.some((tool) => tool === name)).sort()).toEqual(
      [...current].sort(),
    );
    expect(served.includes("browser_sign_in")).toBe(profile !== "trigger");
  } finally {
    await client.close();
    await fixture.service.close();
  }
});

/*
 * Inventory failures: current Runners see legacy tools; Main loses create;
 * Workspace/delegated/Trigger gain create; old Runners lose save or sign-in;
 * delegated/Trigger gain save; a listed legacy save is rejected by admission.
 * Runtime wiring must also match the Runner id and boot before using its capability.
 */
it.each([false, true])(
  "gates browser profile tools per Runner (previous release: %s)",
  async (previousRelease) => {
    for (const profile of ["main", "workspace", "delegated", "trigger"] as const) {
      const claims = {
        capabilityProfileId: profile,
        environmentId: createId("environment"),
        requestedBy: createId("user"),
        runId: createId("run"),
        threadId: createId("thread"),
        workspaceId: createId("workspace"),
      };
      const admitAgentControlRequest = vi.fn(async () => ({
        actionClass: "browser.profile.save",
        wasDuplicate: false,
      }));
      const requestSaveProfile = vi.fn(async () => ({
        kind: "browser.profile.save",
        replayed: false,
        requestId: createId("request"),
        status: "pending",
      }));
      const control = new AgentControlService({
        tokens: { authenticate: async () => claims },
        store: {
          getThreadForOwner: async () => ({ ...claims, id: claims.threadId }),
          workspaceMembershipForUser: async () => ({ state: "active", role: "owner" }),
          admitAgentControlRequest,
        },
        browser: { requestSaveProfile },
      } as unknown as ConstructorParameters<typeof AgentControlService>[0]);
      const fixture = await startService({
        agentControl: control,
        profiles: { token: profile },
        previousRelease,
      });
      const client = await connectClient(fixture.url, "token");
      try {
        const names = (await client.listTools()).tools.map(({ name }) => name);
        expect(names.includes("browser_profile_create")).toBe(profile === "main");
        expect(names.includes("browser_profile_save")).toBe(
          previousRelease && (profile === "main" || profile === "workspace"),
        );
        expect(names.includes("browser_sign_in")).toBe(previousRelease && profile !== "trigger");
        const result = await client.callTool({
          name: "browser_profile_save",
          arguments: { reason: "Keep this identity", sessionId: createBrowserSessionId() },
        });
        if (previousRelease && (profile === "main" || profile === "workspace")) {
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({
            kind: "browser.profile.save",
            status: "pending",
          });
          expect(admitAgentControlRequest).toHaveBeenCalledWith(
            expect.objectContaining({ action: "browser.profile.save", runId: claims.runId }),
          );
          expect(requestSaveProfile).toHaveBeenCalledOnce();
        } else {
          expect(result.isError).toBe(true);
          expect(admitAgentControlRequest).not.toHaveBeenCalled();
          expect(requestSaveProfile).not.toHaveBeenCalled();
        }
      } finally {
        await client.close();
        await fixture.service.close();
      }
    }
  },
);

it.each([false, true])(
  "keeps the environment contract independent of browser aliases (legacy browser: %s)",
  async (legacyBrowser) => {
    const inventories: unknown[] = [];
    for (const profile of ["main", "workspace", "delegated", "trigger"] as const) {
      let legacyEnvironment = true;
      const selection = vi.fn(async () =>
        runnerRelease({ legacyEnvironment, previousRelease: legacyBrowser }),
      );
      const legacyResult = {
        delegationDefault: {
          environmentId: createId("environment"),
          harnessInstanceId: createId("harnessInstance"),
          model: { modelId: "sol", providerId: "openai", options: {} },
        },
        environments: [],
        environmentsTruncated: false,
        harnesses: [],
        harnessesTruncated: false,
        threads: [],
        threadWindow: emptyWindow(),
        workspaceWindow: emptyWindow(),
        workspaces: [],
      };
      const handle = vi.fn(async (_token: string, value: unknown) => {
        const request = AgentControlRequestSchema.parse(value);
        if (request.type === "workspace.inspect")
          return {
            ...legacyResult,
            requestId: request.requestId,
            type: "workspace.inspect.result" as const,
          };
        if (request.type === "workspace.list")
          return {
            requestId: request.requestId,
            type: "workspace.list.result" as const,
            workspaces: [],
            window: emptyWindow(),
          };
        throw new Error("Unexpected compatibility journey request");
      });
      const fixture = await startService({
        agentControl: { handle } as unknown as AgentControlService,
        profiles: { token: profile },
        runnerCapabilities: selection,
      });
      const client = await connectClient(fixture.url, "token");
      try {
        const legacy = (await client.listTools()).tools;
        expect(legacy.map(({ name }) => name)).not.toContain("environment_list");
        for (const [name, hash] of Object.entries({
          workspace_list: "73c4e227619784907796f4779d37f020dca2f8dca8a255ccab8057dac73bb633",
          workspace_create: "ceee05f38f402957dd3adadf9d68774564486df88b3def17711d2364e29197a9",
          thread_delegate: "0ae90e18d6b458996d2828b9b583b59b3ffe148aa3e6d8247ec8926e1b83225e",
        })) {
          const definition = legacy.find((tool) => tool.name === name);
          if (definition)
            expect(
              createHash("sha256")
                .update(definition.description ?? "")
                .digest("hex"),
            ).toBe(hash);
        }

        expect(legacy.find(({ name }) => name === "thread_delegate")?.description).toContain(
          "workspace_list shows",
        );
        const expectedLegacyNames: readonly string[] = legacyBrowser
          ? profile === "main"
            ? [
                ...previousWorkspaceProfileTools,
                "workspace_list",
                "workspace_create",
                "workspace_mount",
                "trigger_read",
                "trigger_write",
              ]
            : profile === "workspace"
              ? previousWorkspaceProfileTools
              : profile === "delegated"
                ? previousBrowserProfileTools
                : [
                    "workspace_list",
                    "workspace_create",
                    "thread_read",
                    "thread_delegate",
                    "thread_message",
                    "trigger_read",
                    "trigger_write",
                  ]
          : toolsForCapabilityProfile(profile)
              .map(({ name }) => name)
              .filter((name) => name !== "environment_list");
        expect(
          legacy
            .filter(({ name }) => expectedLegacyNames.includes(name))
            .map(({ name }) => name)
            .sort(),
        ).toEqual([...expectedLegacyNames].sort());
        const workspace = legacy.find(({ name }) => name === "workspace_list");
        if (profile === "main" || profile === "trigger") {
          expect(Object.keys(workspace!.inputSchema.properties ?? {}).sort()).toEqual([
            "before",
            "harnessCursor",
            "limit",
            "modelPage",
          ]);
          const result = await client.callTool({ name: "workspace_list", arguments: {} });
          expect(result.structuredContent).toEqual({
            delegationDefault: legacyResult.delegationDefault,
            environments: [],
            environmentsTruncated: false,
            harnesses: [],
            harnessesTruncated: false,
            workspaces: [],
            window: emptyWindow(),
          });
        } else expect(workspace).toBeUndefined();
        legacyEnvironment = false;
        expect((await client.listTools()).tools).toEqual(legacy);
        expect(selection).toHaveBeenCalledTimes(1);
        legacyEnvironment = true;
        await fixture.service.close();
        expect((await client.listTools()).tools).toEqual(legacy);
        legacyEnvironment = false;
        await fixture.service.close();
        const current = (await client.listTools()).tools;
        expect(current.map(({ name }) => name)).toContain("environment_list");
        expect(current.find(({ name }) => name === "thread_delegate")?.description).toContain(
          "environment_list",
        );
        expect(current.some(({ name }) => name === "browser_sign_in")).toBe(
          legacyBrowser && profile !== "trigger",
        );
        const currentNames = toolsForCapabilityProfile(profile).map(({ name }) => name);
        // These are the enabled names the release-local Codex inventory check compares.
        expect(
          current
            .filter(({ name }) => currentNames.includes(name as (typeof currentNames)[number]))
            .map(({ name }) => name)
            .sort(),
        ).toEqual([...currentNames].sort());
        if (workspace) {
          const schema = current.find(({ name }) => name === "workspace_list")!.inputSchema;
          expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["before", "limit"]);
          expect(
            (await client.callTool({ name: "workspace_list", arguments: {} })).structuredContent,
          ).toEqual({ workspaces: [], window: emptyWindow() });
        }
        inventories.push({
          profile,
          legacyBrowser,
          legacy,
          current,
          legacyHash: createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
          currentHash: createHash("sha256").update(JSON.stringify(current)).digest("hex"),
        });
      } finally {
        await client.close();
        await fixture.service.close();
      }
    }
    const directory = join(
      process.env.OPENSTEER_ENVIRONMENT_EVIDENCE_DIR ??
        join(tmpdir(), "opensteer-environment-list"),
      `browser-${legacyBrowser ? "legacy" : "current"}`,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "inventories.json"),
      JSON.stringify(
        {
          scenario: "environment catalog compatibility across reconnect and Host session loss",
          inventories,
        },
        null,
        2,
      ),
    );
  },
);
