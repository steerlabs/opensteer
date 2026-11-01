import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { createBrowserSessionId } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { HttpAgentControlClient } from "./agent-control-client.js";

const plan = {
  token: "signed-run-capability",
  url: "https://host.example/internal/v1/agent-control",
} as const;
const delegationDefault = {
  environmentId: createId("environment"),
  harnessInstanceId: createId("harnessInstance"),
  model: { modelId: "gpt-5.6-luna", options: {}, providerId: "openai" },
};
const developmentTransport = {
  deploymentShape: {
    defaultWorkspaceBacking: "local-directory",
    kind: "server" as const,
  },
  mode: "development",
} as const;
const productionCloudTransport = {
  deploymentShape: {
    defaultWorkspaceBacking: "portablefs",
    kind: "server" as const,
  },
  mode: "production",
} as const;
const productionPersonalTransport = {
  deploymentShape: {
    defaultWorkspaceBacking: "local-directory",
    kind: "personal" as const,
  },
  mode: "production",
} as const;

describe("HttpAgentControlClient", () => {
  it("uses the run capability only on a bounded, non-redirecting Host request", async () => {
    const requestId = randomUUID();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input.toString()).toBe(plan.url);
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${plan.token}`);
      expect(JSON.parse(String(init?.body))).toEqual({ requestId, type: "workspace.inspect" });
      return Response.json({
        delegationDefault,
        environments: [],
        environmentsTruncated: false,
        harnesses: [],
        harnessesTruncated: false,
        requestId,
        threadWindow: emptyWindow(),
        threads: [],
        type: "workspace.inspect.result",
        workspaceWindow: emptyWindow(),
        workspaces: [],
      });
    });
    const client = new HttpAgentControlClient({ fetch, plan, transport: productionCloudTransport });

    await expect(
      client.request({ requestId, type: "workspace.inspect" }, new AbortController().signal),
    ).resolves.toMatchObject({ requestId, type: "workspace.inspect.result" });
    expect(fetch).toHaveBeenCalledOnce();
    // New authorization results and historical readers share the wire parser.
    for (const result of [
      {
        status: "ready",
        site: "https://example.com",
        loginRef: `lgn_${"a".repeat(32)}`,
        account: "t•••@example.com",
      },
      { status: "unavailable", site: "https://example.com", reason: "no-saved-login" },
      { status: "signed-in", site: "https://example.com", method: "saved-password" },
      { status: "needs-code", site: "https://example.com", expiresAt: new Date().toISOString() },
      { status: "failed", site: "https://example.com", reason: "needs-fresh-session" },
    ]) {
      const client = new HttpAgentControlClient({
        plan,
        transport: productionCloudTransport,
        fetch: async () => Response.json({ requestId, type: "browser.sign-in.result", result }),
      });
      await expect(
        client.request(
          {
            requestId,
            type: "browser.sign-in",
            sessionId: createBrowserSessionId(),
            site: "https://example.com",
            reason: "Read account",
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ result });
    }
  });

  it("accepts the sessionless sign-in response under its exact request identity", async () => {
    const requestId = randomUUID();
    const result = {
      status: "ready",
      site: "https://example.com",
      loginRef: `lgn_${"b".repeat(32)}`,
      account: "a•••",
    };
    const client = new HttpAgentControlClient({
      plan,
      transport: productionCloudTransport,
      fetch: async (_url, options) => {
        expect(JSON.parse(String(options?.body))).toEqual({
          requestId,
          type: "sign-in",
          site: "https://example.com",
          reason: "Sign in",
        });
        return Response.json({ requestId, type: "sign-in.result", result });
      },
    });
    await expect(
      client.request(
        { requestId, type: "sign-in", site: "https://example.com", reason: "Sign in" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ type: "sign-in.result", result });
  });

  it("permits production plaintext on loopback and rejects unsafe URLs", () => {
    expect(
      () =>
        new HttpAgentControlClient({
          plan: { ...plan, url: "http://127.0.0.1:4310/internal/v1/agent-control" },
          transport: productionCloudTransport,
        }),
    ).not.toThrow();
    expect(
      () =>
        new HttpAgentControlClient({
          plan: { ...plan, url: "http://127.0.0.1:4310/internal/v1/agent-control" },
          transport: productionPersonalTransport,
        }),
    ).not.toThrow();
    expect(
      () =>
        new HttpAgentControlClient({
          plan: { ...plan, url: "http://127.0.0.1:4310/internal/v1/agent-control" },
          transport: developmentTransport,
        }),
    ).not.toThrow();
    expect(
      () =>
        new HttpAgentControlClient({
          plan: { ...plan, url: "http://host.example/internal/v1/agent-control" },
          transport: productionPersonalTransport,
        }),
    ).toThrow("must use HTTPS");
    expect(
      () =>
        new HttpAgentControlClient({
          plan: { ...plan, url: "https://user:pass@host.example/internal/v1/agent-control" },
          transport: developmentTransport,
        }),
    ).toThrow("cannot contain credentials");
  });

  it("accepts only the correlated browser session result envelope", async () => {
    const requestId = randomUUID();
    const sessionId = createBrowserSessionId();
    const client = new HttpAgentControlClient({
      fetch: async () =>
        Response.json({
          requestId,
          sessionId,
          type: "browser.session.close.result",
        }),
      plan,
      transport: productionCloudTransport,
    });

    await expect(
      client.request(
        { requestId, sessionId, type: "browser.session.close" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      sessionId,
      type: "browser.session.close.result",
    });

    const wrongType = new HttpAgentControlClient({
      fetch: async () =>
        Response.json({
          requestId,
          sessions: [],
          type: "browser.session.list.result",
        }),
      plan,
      transport: productionCloudTransport,
    });
    await expect(
      wrongType.request(
        { requestId, sessionId, type: "browser.session.close" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("wrong agent control response type");
  });

  it("fails closed on correlation/type drift, oversized responses, and Host errors", async () => {
    const requestId = randomUUID();
    const request = { requestId, type: "workspace.inspect" } as const;
    const clientFor = (response: Response) =>
      new HttpAgentControlClient({
        fetch: async () => response,
        plan,
        transport: productionCloudTransport,
      });

    await expect(
      clientFor(
        Response.json({
          delegationDefault,
          environments: [],
          environmentsTruncated: false,
          harnesses: [],
          harnessesTruncated: false,
          requestId: randomUUID(),
          threadWindow: emptyWindow(),
          threads: [],
          type: "workspace.inspect.result",
          workspaceWindow: emptyWindow(),
          workspaces: [],
        }),
      ).request(request, new AbortController().signal),
    ).rejects.toThrow("another request");

    await expect(
      clientFor(
        Response.json({
          assignments: [],
          assignmentWindow: emptyWindow(),
          messages: [],
          requestId,
          thread: {
            accessMode: "full-access",
            capabilityProfileId: "workspace",
            continuationIdentity: null,
            createdAt: new Date().toISOString(),
            createdBy: createId("user"),
            environmentId: createId("environment"),
            harnessInstanceId: createId("harnessInstance"),
            id: createId("thread"),
            inputQueuePaused: false,
            lineageRootThreadId: createId("thread"),
            modelSelection: {
              modelId: "gpt-5.6-sol",
              options: { effort: "low" },
              providerId: "openai",
            },
            listed: true,
            parentThreadId: null,
            pendingRequests: 0,
            role: "work",
            status: "idle",
            title: "Another thread",
            updatedAt: new Date().toISOString(),
            workspaceId: createId("workspace"),
          },
          type: "thread.read.result",
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: 0,
            nextBefore: null,
            threadId: createId("thread"),
            totalItems: 0,
          },
        }),
      ).request(request, new AbortController().signal),
    ).rejects.toThrow("wrong agent control response type");

    await expect(
      clientFor(new Response(JSON.stringify("x".repeat(2 * 1_024 * 1_024)))).request(
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow("exceeds its size limit");

    await expect(
      clientFor(
        Response.json({ error: { message: "The active binding has expired" } }, { status: 403 }),
      ).request(request, new AbortController().signal),
    ).rejects.toThrow("The active binding has expired");
  });

  it("does not copy transport errors or the run token into surfaced failures", async () => {
    const client = new HttpAgentControlClient({
      fetch: async () => {
        throw new Error(`request failed with Authorization: Bearer ${plan.token}`);
      },
      plan,
      transport: productionCloudTransport,
    });

    let caught: unknown;
    try {
      await client.request(
        { requestId: randomUUID(), type: "workspace.inspect" },
        new AbortController().signal,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(plan.token);
    expect(String((caught as Error & { cause?: unknown }).cause)).not.toContain(plan.token);
  });
});

function emptyWindow() {
  return { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
}

it("maps a person notification to its exact durable message receipt", async () => {
  const requestId = randomUUID();
  const messageId = createId("message");
  const client = new HttpAgentControlClient({
    plan,
    transport: productionCloudTransport,
    fetch: async () => Response.json({ type: "person.notify.result", requestId, messageId }),
  });
  await expect(
    client.request(
      { type: "person.notify", requestId, message: "Ready." },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ type: "person.notify.result", requestId, messageId });
});
