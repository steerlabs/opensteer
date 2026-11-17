import { frozenPersonalReader } from "./personal-wire.test-support.js";
import * as fixture from "./device-wire-compatibility.test-support.js";
import { describe, expect, it } from "vitest";
import {
  assertDeviceWireInput,
  deviceWireRpcNames,
  projectDeviceWire,
  projectDeviceTabs,
} from "./device-wire-compatibility.js";

const self = "rnr_00000000-0000-4000-8000-000000000001";
const phone = "dev_00000000-0000-4000-8000-000000000002";
const mac = { id: self, selfRunnerId: self, allowedModules: ["integrations"], name: "Mac" };
const iphone = { id: phone, selfRunnerId: null, allowedModules: [], name: "iPhone" };
const content = [{ type: "phone", machineId: phone, display: "main", name: "My iPhone" }];

describe("Device wire window", () => {
  it("withholds screen-only rows and restores self connection and setup target fields", () => {
    const value = {
      machines: [mac, iphone],
      connections: [
        { definitionId: "apple-calendar", computer: { deviceId: self, name: "Mac" } },
        { definitionId: "iphone-screen", computer: { deviceId: phone, name: "iPhone" } },
      ],
      requests: [
        { id: "mac", deviceId: self, definitionId: "apple-calendar", expiresAt: "later" },
        { id: "phone", deviceId: phone, definitionId: "iphone-screen", expiresAt: "later" },
      ],
    };
    expect(projectDeviceWire(value, 60)).toEqual({
      machines: [mac],
      connections: [{ definitionId: "apple-calendar", computer: { runnerId: self, name: "Mac" } }],
      requests: [{ id: "mac", runnerId: self, definitionId: "apple-calendar", expiresAt: "later" }],
    });
    expect(projectDeviceWire(value, 61)).toBe(value);
  });

  it("keeps retained transcript text and results while removing unreadable target metadata", () => {
    const value = {
      content,
      integration: {
        account: "My iPhone",
        computerApp: null,
        phone: { computer: "My iPhone", runnerId: phone },
      },
      output: { type: "phone", machineId: phone, name: "Opaque tool result" },
    };
    expect(projectDeviceWire(value, 60)).toEqual({
      ...value,
      content: [{ type: "text", text: "My iPhone" }],
      integration: { account: "My iPhone", computerApp: null },
    });
  });

  it("withholds incompatible Requests at every wrapper, including event pages", () => {
    const hidden = {
      kind: "computer.app.access",
      payload: { kind: "computer.app.access", definitionId: "iphone-screen", deviceId: phone },
    };
    const visible = {
      kind: "computer.app.access",
      payload: { kind: "computer.app.access", definitionId: "android-phone", deviceId: self },
    };
    expect(
      projectDeviceWire(
        {
          entries: [
            { kind: "request", request: hidden },
            { kind: "request", request: visible },
          ],
          events: [{ type: "request.opened", data: { request: hidden } }],
        },
        60,
      ),
    ).toEqual({
      entries: [
        {
          kind: "request",
          request: {
            ...visible,
            payload: { kind: "computer.app.access", definitionId: "android-phone", runnerId: self },
          },
        },
      ],
      events: [],
    });
  });

  it("filters hidden tab membership without rewriting the authoritative layout", () => {
    const tabs = [
      { tabId: "mac", computer: { computerId: self } },
      { tabId: "phone", computer: { computerId: phone } },
    ];
    const layout = {
      revision: 3,
      items: [
        { kind: "group", group: { groupId: "mixed", tabIds: ["mac", "phone"] } },
        { kind: "tab", tabId: "phone" },
      ],
    };
    const before = structuredClone(layout);
    expect(projectDeviceTabs({ tabs, layout }, 60)).toEqual({
      tabs: [tabs[0]],
      layout: {
        revision: 3,
        items: [{ kind: "group", group: { groupId: "mixed", tabIds: ["mac"] } }],
      },
    });
    expect(layout).toEqual(before);
  });

  it("refuses only the new operation and leaves old self mutations available", () => {
    for (const input of [
      { type: "iphone.screen.attach" },
      { type: "machine.rename", machineId: phone },
      { input: { definitionId: "iphone-screen", deviceId: phone } },
    ])
      expect(() => assertDeviceWireInput(input, 60)).toThrow(/Update Opensteer/);
    expect(() =>
      assertDeviceWireInput({ type: "machine.rename", machineId: self }, 60),
    ).not.toThrow();
    expect(() =>
      assertDeviceWireInput({ type: "machine.rename", machineId: phone }, 61),
    ).not.toThrow();
  });
});

it("makes the frozen v60 readers reject raw Device payloads and accept the projection", () => {
  for (const [name, path, value, key] of [
    [
      "rpc machines.list",
      ["properties", "machines"],
      { machines: [fixture.machine, fixture.screen] },
      "machines",
    ],
    [
      "rpc integrations.get",
      ["properties", "connections"],
      { connections: [fixture.connection, fixture.screenConnection] },
      "connections",
    ],
    [
      "rpc thread.messages.list",
      ["properties", "messages", "items", "properties", "content"],
      { content: fixture.content },
      "content",
    ],
  ] as const) {
    const reader = frozenPersonalReader(name, path);
    expect(reader.safeParse(value[key]).success).toBe(false);
    const projected = projectDeviceWire(value, 60) as Record<string, unknown>;
    expect(reader.safeParse(projected[key]).success).toBe(true);
  }
});

it("withholds screen presence and tab notices without disturbing self presence", () => {
  const notice = {
    type: "host.computer-presence",
    sessions: [
      { sessionId: "cus_00000000-0000-4000-8000-000000000001", actingAppKeys: [] },
      {
        sessionId: "cus_00000000-0000-4000-8000-000000000002",
        actingAppKeys: [],
        actingDisplay: true,
      },
    ],
  };
  const hidden = new Set([notice.sessions[1]!.sessionId]);
  const projected = projectDeviceWire(notice, 60, new Set(), hidden);
  expect(projected).toEqual({ ...notice, sessions: [notice.sessions[0]] });
  expect(
    frozenPersonalReader("host frame host.computer-presence").safeParse(projected).success,
  ).toBe(true);
  expect(
    projectDeviceWire({ ...notice, sessions: [notice.sessions[1]] }, 60, new Set(), hidden),
  ).toBeUndefined();
  expect(
    projectDeviceWire(
      { type: "host.show", target: { tabId: "hidden-phone" } },
      60,
      new Set(["hidden-phone"]),
    ),
  ).toBeUndefined();
});

it("retains an integration call's frozen headline and result while dropping the screen subject", () => {
  const event = {
    environmentId: "env_00000000-0000-4000-8000-000000000001",
    eventId: "evt_00000000-0000-4000-8000-000000000001",
    runId: fixture.runId,
    threadId: fixture.threadId,
    sequence: "1",
    createdAt: fixture.now,
    type: "tool.started",
    data: {
      arguments: {},
      callId: "call",
      tool: { namespace: "opensteer", name: "computer_use" },
      integration: {
        account: "My iPhone",
        computerApp: null,
        effect: "read",
        integration: "Computer use",
        operation: { name: "observe", title: "Read iPhone" },
        phone: { computer: "My iPhone", runnerId: fixture.screenId },
      },
    },
  };
  const reader = frozenPersonalReader("host frame host.events");
  const frame = { type: "host.events", throughSequence: "1", events: [event] };
  expect(reader.safeParse(frame).success).toBe(false);
  const projected = projectDeviceWire(frame, 60);
  expect(reader.safeParse(projected).success).toBe(true);
  expect(projected).toMatchObject({
    events: [
      { data: { integration: { account: "My iPhone", operation: { title: "Read iPhone" } } } },
    ],
  });
});

it("degrades a hidden singleton field without discarding its RPC envelope", () => {
  expect(projectDeviceWire({ request: fixture.screenSetup, revision: 2 }, 60)).toEqual({
    request: null,
    revision: 2,
  });
  expect(projectDeviceWire({ items: [{ id: "keep", metadata: { deviceId: phone } }] }, 60)).toEqual(
    { items: [{ id: "keep", metadata: null }] },
  );
});

it("preserves envelopes across every Device-projected v60 RPC", () => {
  const message = {
    content: fixture.content,
    integration: { account: "Phone", phone: { runnerId: fixture.screenId } },
  };
  const requests = [fixture.request, fixture.screenRequest];
  const events = [
    { type: "request.opened", data: { request: fixture.screenRequest } },
    { type: "message.created", data: { message } },
  ];
  const integration = { connections: [fixture.connection, fixture.screenConnection] };
  const outputs: Record<string, object> = {
    "bootstrap.get": {
      machines: [fixture.machine, fixture.screen],
      tabs: fixture.tabs,
      ...integration,
    },
    "machines.list": { machines: [fixture.machine, fixture.screen] },
    "devices.overview.get": { devices: [fixture.machine, fixture.screen] },
    "integrations.get": integration,
    "integration.platform.get": integration,
    "plugins.directory.get": { plugins: [{ id: "phone", connections: integration.connections }] },
    "plugins.overview.get": { plugins: [{ id: "phone", connections: integration.connections }] },
    "plugins.detail.get": { plugin: { id: "phone" }, ...integration },
    "plugin.list": { plugins: [{ id: "phone", connections: integration.connections }] },
    "integration.computer.setup.list": { requests: [fixture.setup, fixture.screenSetup] },
    "integration.computer.setup.review": { request: fixture.screenSetup, app: null },
    "integration.computer.apps.approved": {
      apps: [{ machineId: fixture.screenId }, { machineId: fixture.selfId }],
    },
    "needsYou.get": { entries: requests.map((request) => ({ kind: "request", request })) },
    "requests.list": { requests },
    "thread.requests.list": { requests },
    "thread.events.list": { events },
    "node.events.list": { events },
    "thread.messages.list": { messages: [message] },
    "thread.message.revisions.list": { revisions: [message] },
    "thread.inputQueue.get": { items: [{ message }] },
    "thread.live.get": { events, requests },
    "tabs.get": { ...fixture.tabs, computer: { computerId: fixture.screenId } },
    "tabs.state": fixture.tabs,
    "commands.dispatch": { type: "thread.input.enqueue", message },
  };
  expect(Object.keys(outputs).sort()).toEqual([...deviceWireRpcNames].sort());
  for (const [name, output] of Object.entries(outputs)) {
    const projected = projectDeviceWire(output, 60);
    expect(projected, name).toBeDefined();
    expect(JSON.stringify(projected), name).not.toContain(fixture.screenId);
  }
  const request = projectDeviceWire({ request: fixture.setup, app: null }, 60);
  expect(
    frozenPersonalReader("rpc integration.computer.setup.review").safeParse(request).success,
  ).toBe(true);
});
