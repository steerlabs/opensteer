import { AgentConnectionStore } from "@opensteer/database";
import { describeStore } from "@opensteer/database/test-support/store";
import { BrowserSurfaceIdSchema, createBrowserSessionId } from "@opensteer/protocol";
import Fastify from "fastify";
import { expect, vi } from "vitest";
import type { RunCaller } from "../mcp/agent-caller.js";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import { registerAgentPageBindingRoute, runBrowserCapability } from "./trigger-cdp-bridge.js";

describeStore("the page-bind gate", (it) => {
  it("uses the Run's effective mode: a lowered connection refuses its full-access Run", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("page-bind-gate");
    const { database, store } = storeFixture;
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.threadId)
      .execute();
    await database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.run.id)
      .execute();
    const claims = { runId: f.run.id, requestedBy: f.userId } as RunToolScope;
    const binding = {
      tabId: BrowserSurfaceIdSchema.parse("tab"),
      sessionId: createBrowserSessionId(),
      backend: "cdp" as const,
      reloaded: false,
    };
    const pages = { requireOpenPage: vi.fn(async () => binding) };
    const app = Fastify();
    registerAgentPageBindingRoute(
      app,
      { authenticate: async () => claims, reauthorize: async () => claims },
      pages,
      { authenticate: async () => ({ kind: "run" }) as RunCaller },
      (scope) => runBrowserCapability(store, scope),
    );
    const bind = () =>
      app.inject({
        method: "POST",
        url: "/internal/v1/browser-agent/pages/bind",
        headers: { authorization: "Bearer run-token-123456789012345" },
        payload: { tabId: "tab" },
      });
    try {
      // The person's own full-access Run binds pages.
      expect((await bind()).json()).toEqual(binding);
      const connections = new AgentConnectionStore(database);
      const agent = await connections.create({
        userId: f.userId,
        label: "Gate agent",
        clientName: "Gate agent",
        accessMode: "full-access",
        resource: "http://127.0.0.1/mcp",
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        grant: { scope: "selected", tasks: true, resources: [] },
      });
      expect(await connections.activate(agent.id, "page-bind-gate")).toBe(true);
      await database
        .updateTable("runs")
        .set({ connectionId: agent.id })
        .where("id", "=", f.run.id)
        .execute();
      expect((await bind()).json(), "a full-access connection keeps it").toEqual(binding);
      // Lowered after the Run started: its raw snapshot still says full-access.
      await connections.update(f.userId, {
        connectionId: agent.id,
        expectedRevision: 1,
        accessMode: "approval-required",
      });
      const refused = await bind();
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({
        error: { message: "Browser control requires full access for this Run." },
      });
      expect(pages.requireOpenPage).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("refuses binding once the Run's task is removed", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("page-bind-removed-task");
    const { database, store } = storeFixture;
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.threadId)
      .execute();
    await database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.run.id)
      .execute();
    const claims = {
      runId: f.run.id,
      requestedBy: f.userId,
      threadId: f.threadId,
      environmentId: f.environmentId,
    } as RunToolScope;
    const binding = {
      tabId: BrowserSurfaceIdSchema.parse("tab"),
      sessionId: createBrowserSessionId(),
      backend: "cdp" as const,
      reloaded: false,
    };
    const pages = { requireOpenPage: vi.fn(async () => binding) };
    const app = Fastify();
    registerAgentPageBindingRoute(
      app,
      { authenticate: async () => claims, reauthorize: async () => claims },
      pages,
      { authenticate: async () => ({ kind: "run" }) as RunCaller },
      (scope) => runBrowserCapability(store, scope),
    );
    const bind = () =>
      app.inject({
        method: "POST",
        url: "/internal/v1/browser-agent/pages/bind",
        headers: { authorization: "Bearer run-token-123456789012345" },
        payload: { tabId: "tab" },
      });
    try {
      expect((await bind()).json()).toEqual(binding);
      await database
        .updateTable("threads")
        .set({ removedAt: new Date() })
        .where("id", "=", f.threadId)
        .execute();
      const refused = await bind();
      expect(refused.statusCode).toBe(403);
      expect(pages.requireOpenPage).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
