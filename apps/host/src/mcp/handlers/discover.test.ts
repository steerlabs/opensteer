import { agentToolFailureResult } from "@opensteer/agent-tools";
import { discover } from "@opensteer/agent-tools/discover";
import { createId, OpensteerError, TabIdSchema, type Tab } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { AgentOperationFailure } from "../../agent-sessions/agent-session-service.js";
import type { ConnectionCaller } from "../agent-caller.js";
import { agentToolFailure } from "../agent-tool-failure.js";
import { discoverHandler } from "./discover.js";
import type { ToolCall } from "./types.js";

const browserId = createId("browserProfile");
const chromeId = createId("browserSource");
const macId = createId("device");
const phoneId = createId("device");
const taskId = createId("thread");
const childId = createId("thread");
const directTask = createId("thread");
const operationId = createId("agentOperation");
const time = "2026-11-20T12:00:00.000Z";
const connection: ConnectionCaller = {
  kind: "connection",
  connectionId: "test-discover",
  key: "connection:test-discover",
  userId: createId("user"),
  accessMode: "full-access",
  grantRevision: 1,
  grant: { scope: "everything" },
};

function chromeLookup(visible: boolean) {
  return {
    browserSources: {
      grantableChromeTabs: async () => [
        { sourceId: chromeId, computerName: "Studio", paired: true as const },
      ],
    },
    store: {
      admitExecution: async ({
        ownerUserId,
        subject,
      }: {
        ownerUserId: ConnectionCaller["userId"];
        subject: import("@opensteer/database").AuthoritySubject;
      }) => ({
        ownerUserId,
        subject,
        actor: "agent" as const,
        threadId: null,
        runId: null,
        taskMode: null,
        runMode: null,
        mode: connection.accessMode,
        agentConnection: {
          agentConnectionId: connection.connectionId,
          grantRevision: 1,
          consentVersion: 2,
          grant: visible
            ? connection.grant
            : { scope: "selected" as const, tasks: false, resources: [] },
          accessMode: connection.accessMode,
        },
      }),
    },
  };
}

function fixture(visible = true, chromeHasTabs = true) {
  const computer = { computerId: macId, name: "Studio" };
  const common = {
    tabId: TabIdSchema.parse("tab_profile"),
    title: "An untrusted title",
    computer,
    state: "open",
    groupId: null,
    openedBy: "person",
    usedBy: [],
    createdAt: time,
    updatedAt: time,
  } as const;
  const page: Tab = {
    ...common,
    usedBy: [],
    kind: "page",
    profile: { profileId: browserId, name: "Research" },
    url: "https://example.test/",
  };
  const chrome: Tab = {
    ...page,
    tabId: TabIdSchema.parse("tab_chrome"),
    profile: null,
    sharedByPerson: { sourceId: chromeId, computerName: "Studio" },
  };
  const window: Tab = {
    ...common,
    usedBy: [],
    kind: "window",
    tabId: TabIdSchema.parse("tab_window"),
    appName: "Notes",
    bundleId: "com.apple.Notes",
  };
  const tabs = visible ? [page, ...(chromeHasTabs ? [chrome] : []), window] : [];
  const tabList = vi.fn(async () => ({
    tabs,
    groups: [],
    nextCursor: null,
    status: "completed",
    taskId: directTask,
    operationId,
  }));
  const app = { name: "Notes", bundleId: "com.apple.Notes", access: "read" };
  const installed = { appId: "installed-app", label: "Phone Notes" };
  const computerApps = vi.fn(async ({ input }: ToolCall<"computer_apps">) =>
    input.computerId === phoneId && visible
      ? {
          apps: [installed],
          total: 1,
          nextCursor: null,
          status: "completed",
          taskId: directTask,
          operationId,
        }
      : input.computerId === macId && visible
        ? { computer: { ...computer, apps: [app] }, nextCursor: null }
        : {
            computers: visible ? [{ ...computer, apps: [app] }] : [],
            phones: visible
              ? [
                  {
                    computerId: phoneId,
                    name: "Phone",
                    definitionId: "android-phone",
                    access: "read-write",
                  },
                ]
              : [],
          },
  );
  const taskList = vi.fn(async ({ input }: ToolCall<"opensteer_task_list">) => ({
    threads: !visible
      ? []
      : [
          {
            id: input.parentTaskId ? childId : taskId,
            title: input.parentTaskId ? "Delegated work" : "Latest task",
            status: "idle",
            taskStatus: null,
            pendingRequests: 0,
            assignmentId: null,
            parentThreadId: input.parentTaskId ?? null,
            updatedAt: time,
          },
        ],
    hasMore: false,
    nextBefore: null,
  }));
  const plugin = {
    id: "plg-test",
    name: "Calendar",
    slug: "calendar",
    activeVersion: "version",
    versions: [],
    versionCount: 1,
    requirements: {},
    access: "read-only",
    links: [],
    status: "active",
  };
  const pluginTool = {
    path: "tools.calendar.read",
    description: "Read events",
    input: "{limit:number}",
  };
  const instruction = { name: "Guide", version: "version", revision: "revision" };
  const handler = discoverHandler(
    {
      browser_profile_list: async () => ({
        profiles: visible ? [{ id: browserId, name: "Research", home: { reachable: true } }] : [],
        sites: [{ site: "https://not-part-of-discovery.test" }],
      }),
      tab_list: tabList,
      computer_apps: computerApps,
      opensteer_plugin_list: async () => ({
        local: [],
        plugins: visible ? [plugin] : [],
        cursor: null,
      }),
      plugin_search: async () => ({
        items: visible ? [pluginTool] : [],
        namespaces: [],
        remaining: 0,
        next: null,
      }),
      plugin_describe: async ({ input }) => ({
        items:
          visible && input.paths.includes(pluginTool.path)
            ? [{ ...pluginTool, signature: "(args: {limit:number}) => Event[]" }]
            : [],
        namespaces: [],
        missing: [],
      }),
      plugin_skills: async ({ input }) =>
        input.name
          ? { content: input.file ? "Reference text" : "Instruction text", files: ["guide.md"] }
          : { skills: visible ? [instruction] : [] },
      opensteer_task_list: taskList,
      opensteer_task_read: async ({ input }) => {
        if (!visible || input.taskId !== taskId)
          throw new OpensteerError({
            code: "forbidden",
            message: "task is unavailable to this user",
            next: "Do not show this",
          });
        return { thread: { title: "Latest task", status: "idle" } };
      },
    },
    {
      ...chromeLookup(visible),
      tabs: { project: async () => ({ tabs, layout: { revision: 0, items: [] } }) },
    },
  );
  const read = (input: z.input<typeof discover.input> = {}, caller = connection) =>
    handler({
      caller,
      input: discover.input.parse(input),
      operationKey: "discover-call",
    });
  return { read, tabList, computerApps, taskList };
}

describe("discover before registration", () => {
  it("lists authorized choices with reusable IDs, smallest hints and no cached receipt", async () => {
    const { read, tabList } = fixture();
    const result = await read();
    expect(result.items.map(({ kind }) => kind)).toEqual([
      "browser-profile",
      "chrome-tabs",
      "app",
      "phone",
      "plugin",
      "task",
    ]);
    expect(result.items[0]).toMatchObject({
      id: browserId,
      use: { tool: "browser_use", argument: "profileId", value: browserId },
    });
    expect(result.items[4]).toMatchObject({ access: "read-only", id: "tools.calendar" });
    expect(result).not.toHaveProperty("taskId");
    expect(result).not.toHaveProperty("operationId");
    expect(JSON.stringify(result)).not.toContain("not-part-of-discovery");
    expect(tabList).not.toHaveBeenCalled();
    const chromeOnly: ConnectionCaller = {
      ...connection,
      grant: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "chrome-tabs", sourceId: chromeId }],
      },
    };
    const empty = await fixture(false).read({}, chromeOnly);
    expect(empty).toEqual({ items: [], nextCursor: null });
  });

  it("keeps a paired Chrome source reachable by ID even when it has no visible tabs", async () => {
    const { read, tabList } = fixture(true, false);
    const list = await read();
    expect(list.items.find((entry) => entry.id === chromeId)).toMatchObject({
      kind: "chrome-tabs",
      reachable: false,
    });
    expect(tabList).not.toHaveBeenCalled();
    expect(await read({ id: chromeId })).toMatchObject({
      item: { id: chromeId },
      items: [],
      nextCursor: null,
    });
  });

  it.each([
    [browserId, "tab_profile"],
    [chromeId, "tab_chrome"],
  ])("uses the recorded tab handler for %s", async (id, tabId) => {
    const { read, tabList } = fixture();
    const result = await read({ id, taskId: directTask });
    expect(tabList).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        caller: connection,
        operationKey: "discover-call",
        input: expect.objectContaining({ taskId: directTask }),
      }),
    );
    expect(result).toMatchObject({
      status: "completed",
      taskId: directTask,
      operationId,
      items: [
        {
          id: tabId,
          untrusted: true,
          use: { tool: "browser_use", argument: "tabId", value: tabId },
        },
      ],
    });
    expect((await read({ id: tabId })).item).toMatchObject({ id: tabId, kind: "tab" });
  });

  it("follows Mac apps and windows without a receipt, and passes live phone inventory through", async () => {
    const { read, computerApps } = fixture();
    const { items } = await read();
    const app = items.find(({ kind }) => kind === "app")!;
    const mac = await read({ id: app.id });
    expect(mac).toMatchObject({
      item: { id: app.id, untrusted: true },
      items: [{ id: "tab_window" }],
    });
    expect(mac).not.toHaveProperty("operationId");
    expect((await read({ id: macId })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: app.id })]),
    );
    const phone = await read({ id: phoneId, taskId: directTask });
    expect(phone).toMatchObject({ item: { kind: "phone" }, taskId: directTask, operationId });
    expect(computerApps).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: "discover-call",
        input: expect.objectContaining({ computerId: phoneId, taskId: directTask }),
      }),
    );
    const installed = await read({ id: phone.items[0]!.id });
    expect(installed.item).toMatchObject({
      name: "Phone Notes",
      appId: "installed-app",
      untrusted: true,
      use: { tool: "computer_use", argument: "computerId", value: phoneId },
    });
  });

  it("routes tool signatures, documents and references by their returned IDs", async () => {
    const { read } = fixture();
    const result = await read({ id: "tools.calendar" });
    const [tool, doc] = result.items;
    expect(tool).toMatchObject({
      id: "tools.calendar.read",
      input: "{limit:number}",
      untrusted: true,
    });
    expect((await read({ id: tool!.id })).item).toMatchObject({
      signature: "(args: {limit:number}) => Event[]",
    });
    const document = await read({ id: doc!.id });
    expect(document.item).toMatchObject({ text: "Instruction text", untrusted: true });
    expect((await read({ id: document.items[0]!.id })).item).toMatchObject({
      text: "Reference text",
    });
    expect(document).not.toHaveProperty("operationId");
  });

  it("keeps delegated work reachable as a task and sends query to the task lookup", async () => {
    const { read, taskList } = fixture();
    const result = await read({ id: taskId, query: "Delegated" });
    expect(result.item).toMatchObject({ id: taskId, name: "Latest task" });
    expect(result.items).toMatchObject([
      { id: childId, use: { tool: "opensteer_task_read", argument: "taskId", value: childId } },
    ]);
    expect(taskList).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        input: expect.objectContaining({ parentTaskId: taskId, query: "Delegated" }),
      }),
    );
  });

  it("pages filtered inventory and refuses a cursor with different filters", async () => {
    const profiles = Array.from({ length: 55 }, (_, i) => ({
      id: createId("browserProfile"),
      name: `Matching ${i}`,
      home: null,
    }));
    const handler = discoverHandler(
      {
        browser_profile_list: async () => ({
          profiles: [...profiles, { id: browserId, name: "Other", home: null }],
          sites: [],
        }),
      },
      {
        ...chromeLookup(false),
        tabs: { project: async () => ({ tabs: [], layout: { revision: 0, items: [] } }) },
      },
    );
    const caller: ConnectionCaller = {
      ...connection,
      grant: {
        scope: "selected",
        tasks: false,
        resources: profiles.map(({ id }) => ({ kind: "browser-profile", profileId: id })),
      },
    };
    const read = (query: string, cursor?: string) =>
      handler({
        operationKey: "test-paging",
        caller,
        input: discover.input.parse({ query, cursor }),
      });
    const first = await read("matching");
    const second = await read("matching", first.nextCursor!);
    expect(first.items.map(({ id }) => id)).toEqual(profiles.slice(0, 50).map(({ id }) => id));
    expect(second.items.map(({ id }) => id)).toEqual(profiles.slice(50).map(({ id }) => id));
    expect(second.nextCursor).toBeNull();
    await expect(read("different", first.nextCursor!)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("redacts a recorded receipt if the target disappears at admission", async () => {
    const { read, tabList } = fixture();
    tabList.mockRejectedValueOnce(
      new AgentOperationFailure(
        new OpensteerError({ code: "not_found", message: "Internal target name" }),
        { taskId: directTask, operationId, status: "refused" },
      ),
    );
    await expect(read({ id: browserId })).rejects.toStrictEqual(
      new OpensteerError({ code: "not_found", message: "That item is unavailable." }),
    );
  });

  it("serializes hidden, missing and malformed IDs identically for every route", async () => {
    const { read } = fixture();
    const { read: hidden } = fixture(false);
    const offered = await read();
    const macApp = offered.items.find(({ kind }) => kind === "app")!;
    const phone = await read({ id: phoneId });
    const plugin = await read({ id: "tools.calendar" });
    const document = await read({ id: plugin.items[1]!.id });
    const refused = async (id: string) => {
      try {
        await hidden({ id });
        throw new Error("Expected discover to refuse");
      } catch (error) {
        return agentToolFailureResult(agentToolFailure(error, "read", undefined, true), {
          tools: new Set(["discover"]),
        });
      }
    };
    const missing = await refused(createId("browserProfile"));
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "not_found", message: "That item is unavailable.", next: null },
      },
    });
    for (const id of [
      browserId,
      chromeId,
      "tab_profile",
      macId,
      macApp.id,
      phoneId,
      phone.items[0]!.id,
      taskId,
      "tools.calendar",
      plugin.items[0]!.id,
      plugin.items[1]!.id,
      document.items[0]!.id,
      "no such browser",
      "",
      "app:!",
      "doc:!",
      "phone-app:!",
    ])
      expect(JSON.stringify(await refused(id)), id).toBe(JSON.stringify(missing));
  });
});
