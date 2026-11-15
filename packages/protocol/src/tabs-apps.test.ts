import { HostToRunnerMessageSchema, RunnerToHostMessageSchema } from "./runner.js";
import {
  ComputerUseBindParamsSchema,
  ComputerUseTabBindingSchema,
  ComputerUseHelperRequestSchema,
} from "./computer-use.js";
import { ComputerViewTargetSchema } from "@opensteer/core";
import { expect, it } from "vitest";
import {
  AppSchema,
  TabSchema,
  TabTargetSchema,
  TabIdSchema,
  WindowIdSchema,
  createId,
} from "@opensteer/core";
import { TabCommandSchema, TabStreamSchema, HostTabsSchema } from "./tabs.js";
import { AppCommandSchema, HostAppRequestSchema, HostAppsSyncSchema } from "./apps.js";
import { BrowserResumeTabResultSchema } from "./browser-actions.js";
import { PageAgentBindingSchema } from "./browser-agent.js";
import { PersonShowMessageSchema } from "./places.js";
import { HostToClientMessageSchema } from "./client.js";
import { AgentToolRelayRequestSchema, AgentToolRelayResponseSchema } from "./agent-tool-relay.js";
import { KeyedStreamPublisher, KeyedStreamReceiver } from "./keyed-stream.js";
import { hostApi } from "./host-api.js";

const computerId = createId("runner");
const tabId = TabIdSchema.parse("page-existing-surface");
const row = TabSchema.parse({
  tabId,
  kind: "page",
  title: "Page",
  url: "https://example.test",
  profile: null,
  computer: { computerId, name: "Mac" },
  groupId: null,
  state: "asleep",
  openedBy: "person",
  usedBy: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const fence = {
  runnerId: computerId,
  bootId: `rbt_${crypto.randomUUID()}`,
  connectionGeneration: 1,
  connectionId: `rcn_${crypto.randomUUID()}`,
  connectionLeaseId: `rls_${crypto.randomUUID()}`,
  environmentId: createId("environment"),
  bindingGeneration: 1,
};
const runtime = {
  appId: `app_${crypto.randomUUID()}`,
  version: 1,
  generation: 1,
  port: 49152,
  folder: { computerId, path: "/tmp/app" },
  agentHome: { computerId, path: "/tmp" },
  command: "node server.mjs",
};

it("validates target authority choices, kind descriptors, usage and unavailable states", () => {
  expect(
    TabTargetSchema.safeParse({ kind: "page", url: "https://example.test", guest: true }).success,
  ).toBe(true);
  for (const target of [
    { kind: "page", url: "https://example.test" },
    { kind: "page", url: "https://user:pass@example.test", guest: true },
    { kind: "page", url: "file:///tmp/file", guest: true },
    {
      kind: "page",
      url: "https://example.test",
      guest: true,
      profileId: createId("browserProfile"),
    },
    { kind: "window", computerId, windowId: 123 },
  ])
    expect(TabTargetSchema.safeParse(target).success).toBe(false);
  expect(
    TabTargetSchema.parse({
      kind: "window",
      computerId,
      windowId: WindowIdSchema.parse(`win_${crypto.randomUUID()}`),
    }),
  ).toHaveProperty("windowId");
  for (const patch of [
    { appId: runtime.appId },
    { profile: undefined },
    { state: "unavailable" },
    { unavailableReason: "No" },
    {
      usedBy: [{ taskId: createId("thread") }, { taskId: createId("thread") }].sort((a, b) =>
        b.taskId.localeCompare(a.taskId),
      ),
    },
  ])
    expect(TabSchema.safeParse({ ...row, ...patch }).success).toBe(false);
  expect(
    TabSchema.safeParse({
      ...row,
      state: "unavailable",
      unavailableCode: "computer-offline",
      unavailableReason: "Computer offline",
    }).success,
  ).toBe(true);
});

it("declares bounded strict commands, personal reads and explicit Show targets", () => {
  const close = { type: "tab.close", tabIds: [tabId], idempotencyKey: "close" };
  expect(hostApi["commands.dispatch"].payload.parse(close)).toEqual(close);
  for (const patch of [
    { tabIds: [] },
    { tabIds: [tabId, tabId] },
    { tabIds: Array.from({ length: 501 }, (_, i) => `tab_${i}`) },
    { tabId },
  ])
    expect(TabCommandSchema.safeParse({ ...close, ...patch }).success).toBe(false);
  expect(
    TabCommandSchema.safeParse({
      type: "tab.group.update",
      groupId: createId("tabGroup"),
      idempotencyKey: "update",
    }).success,
  ).toBe(false);
  for (const name of ["tabs.get", "tabs.state", "apps.list", "apps.get"] as const)
    expect(hostApi[name].method).toBe("GET");
  expect(
    AppCommandSchema.safeParse({ type: "app.stop", appId: runtime.appId, idempotencyKey: "stop" })
      .success,
  ).toBe(true);
  const show = {
    type: "host.show",
    threadId: createId("thread"),
    runId: createId("run"),
    target: { tabId },
  };
  expect(PersonShowMessageSchema.parse(show)).toEqual(show);
  for (const target of [
    { current: true },
    { runId: createId("run") },
    { threadId: createId("thread") },
  ])
    expect(PersonShowMessageSchema.safeParse({ ...show, target }).success).toBe(false);
});

it("streams tabId patches without an id alias or repeated layout", () => {
  type Row = { tabId: string; title: string };
  type Meta = { layout: { revision: number } };
  const rows = new Map([[tabId, { tabId, title: "Before" }]]);
  const source = new KeyedStreamPublisher<Row, Meta, "tabId">({
    key: "tabId",
    ids: () => rows.keys(),
    read: (id) => rows.get(TabIdSchema.parse(id)),
    meta: () => ({ layout: { revision: 1 } }),
    targetBytes: 64 * 1024,
    envelopeBytes: 64,
  });
  const receiver = new KeyedStreamReceiver<Row, Meta, "tabId">({ key: "tabId" });
  const drain = () => {
    const result = [];
    for (let frame = source.next(); frame; frame = source.next()) {
      receiver.apply(frame);
      source.settled(frame, true);
      result.push(frame);
    }
    return result;
  };
  drain();
  rows.set(tabId, { tabId, title: "After" });
  source.mark(tabId);
  expect(drain()).toEqual([
    {
      op: "change",
      generation: expect.any(String),
      base: 0,
      revision: 1,
      update: [{ tabId, title: "After" }],
    },
  ]);
  expect(receiver.rows.get(tabId)).toEqual({ tabId, title: "After" });
  const frame = {
    type: "host.tabs",
    stream: { op: "rows", rows: [{ ...row, future: "ignored" }] },
  };
  expect(HostTabsSchema.parse(frame)).toEqual({
    type: "host.tabs",
    stream: { op: "rows", rows: [row] },
  });
  expect(HostToClientMessageSchema.parse(frame)).toEqual(HostTabsSchema.parse(frame));
  expect(
    TabStreamSchema.safeParse({
      op: "change",
      generation: "g",
      base: 0,
      revision: 1,
      update: [{ title: "Missing key" }],
    }).success,
  ).toBe(false);
});

it("freezes fixed-port lifecycle and complete-set synchronization frames", () => {
  const start = { type: "host.app.start", requestId: crypto.randomUUID(), fence, spec: runtime };
  expect(HostAppRequestSchema.parse(start)).toEqual(start);
  expect(HostToRunnerMessageSchema.parse(start)).toEqual(start);
  expect(
    RunnerToHostMessageSchema.parse({
      type: "runner.app.state",
      fence,
      appId: runtime.appId,
      version: 1,
      generation: 1,
      state: "running",
    }),
  ).toHaveProperty("generation", 1);
  expect(HostAppRequestSchema.safeParse({ ...start, spec: { ...runtime, port: 0 } }).success).toBe(
    false,
  );
  expect(
    HostAppRequestSchema.parse({
      type: "host.app.stop",
      requestId: start.requestId,
      fence,
      appId: runtime.appId,
      generation: 2,
    }),
  ).not.toHaveProperty("spec");
  expect(
    HostAppsSyncSchema.parse({
      type: "host.apps.sync",
      requestId: start.requestId,
      fence,
      apps: [],
    }),
  ).toHaveProperty("apps", []);
  expect(
    AppSchema.safeParse({
      appId: runtime.appId,
      name: "App",
      kind: "html",
      state: "running",
      computerId,
      taskId: null,
      version: 1,
      server: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }).success,
  ).toBe(true);
});

it("keeps the relay JSON-only and carries full MCP results and resume snapshots", () => {
  const call = { callId: crypto.randomUUID(), name: "tab_list", input: { query: "Page" } };
  expect(AgentToolRelayRequestSchema.parse(call)).toEqual(call);
  expect(
    AgentToolRelayRequestSchema.safeParse({ ...call, ownerId: createId("user") }).success,
  ).toBe(false);
  const result = {
    content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
    structuredContent: { tabs: [] },
  };
  expect(AgentToolRelayResponseSchema.parse(result)).toEqual(result);
  expect(
    PageAgentBindingSchema.parse({
      tabId,
      sessionId: `bsn_${crypto.randomUUID()}`,
      backend: "cdp",
      reloaded: false,
    }),
  ).toHaveProperty("tabId", tabId);
  const resume = {
    surfaceId: tabId,
    targetId: "target",
    documentId: "document",
    reloaded: false,
    dialog: null,
    userActivity: null,
    pageResize: null,
  };
  expect(BrowserResumeTabResultSchema.parse(resume)).toEqual(resume);
  expect(
    BrowserResumeTabResultSchema.safeParse({
      ...resume,
      dialog: { id: "d", type: "alert", message: "x".repeat(10001) },
    }).success,
  ).toBe(false);
});

it("accepts only opaque exact-window discovery and binding identities", () => {
  const windowId = WindowIdSchema.parse(`win_${crypto.randomUUID()}`);
  expect(ComputerUseBindParamsSchema.parse({ windowId })).toEqual({ windowId });
  expect(ComputerUseBindParamsSchema.safeParse({ window: 17 }).success).toBe(false);
  expect(ComputerUseBindParamsSchema.safeParse({ windowId: 17 }).success).toBe(false);
  expect(
    ComputerUseTabBindingSchema.parse({
      kind: "window",
      connectionId: "connection",
      tabId,
      window: { windowId, title: "Editor", ref: "bound-ref" },
    }),
  ).toHaveProperty("tabId", tabId);
  const app = { bundleId: "com.example.Editor", displayName: "Editor", teamId: null };
  expect(ComputerViewTargetSchema.parse({ kind: "app", app, windowId })).toHaveProperty(
    "windowId",
    windowId,
  );
  expect(ComputerViewTargetSchema.safeParse({ kind: "app", app, window: 17 }).success).toBe(false);
  const bind = {
    id: 1,
    method: "session.bind",
    params: {
      windowId,
      sessionId: `cus_${crypto.randomUUID()}`,
      app: { access: "read-write", identity: app },
    },
  };
  expect(ComputerUseHelperRequestSchema.parse(bind)).toEqual(bind);
  expect(
    ComputerUseHelperRequestSchema.safeParse({
      id: 1,
      method: "session.bind",
      params: {
        window: 17,
        sessionId: `cus_${crypto.randomUUID()}`,
        app: { access: "read-write", identity: app },
      },
    }).success,
  ).toBe(false);
});

it("requires a stable tab identity in persisted place-use events", async () => {
  const { TabPlaceEnteredEventSchema } = await import("@opensteer/core");
  const data = { tabId, title: "Page", site: "https://example.test" };
  expect(TabPlaceEnteredEventSchema.shape.data.parse(data)).toEqual(data);
  expect(
    TabPlaceEnteredEventSchema.shape.data.safeParse({
      ...data,
      place: { kind: "browser", surfaceId: tabId },
    }).success,
  ).toBe(false);
});
