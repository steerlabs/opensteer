import { DeviceIdSchema, RunnerIdSchema } from "@opensteer/core";
import { projectDeviceWire, hiddenDeviceTabIds } from "./device-wire-compatibility.js";
import { frozenPersonalReader } from "./personal-wire.test-support.js";
import * as fixture from "./device-wire-compatibility.test-support.js";
import { readFileSync, writeFileSync } from "node:fs";
import {
  HostDescriptorSchema,
  hostApiVersion,
  minimumHostApiVersion,
} from "@opensteer/deployment-authority";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClientToHostMessageSchema, HostToClientMessageSchema } from "./client.js";
import { hostApi } from "./host-api.js";
import { TeamCommandSchema } from "./team-api.js";
import {
  json,
  wireUnionMembers,
  same,
  surfaceBreaks,
  type JsonSchema,
  type Wire,
} from "./wire-compatibility.test-support.js";

interface PersonalWire extends Wire {
  readonly minimumHostApiVersion: number;
}

const baselinePath = new URL("./personal-wire.baseline.json", import.meta.url);
const updateVariable = "OPENSTEER_UPDATE_PERSONAL_WIRE";

/**
 * Realtime frame types a Host sends only to subscribers that asked for them,
 * so a reader from before them never receives one. Every other new frame type
 * would reach an app that cannot read it.
 */
const optInFrames = new Set<string>([]);

/**
 * Surfaces whose shape changed incompatibly, mapped to the version that
 * changed them. The Host serves a caller below that version the shape the
 * baseline records, and a test proves it. Raising the minimum past the version
 * drops the entry.
 */
const projectedSince: Readonly<Record<string, number>> = {};

const archivedDeviceProjections: Readonly<Record<string, number>> = {
  "output rpc bootstrap.get": 61,
  "output rpc machines.list": 61,
  "output rpc devices.overview.get": 61,
  "output rpc integrations.get": 61,
  "output rpc integration.computer.setup.list": 61,
  "output rpc integration.computer.apps.approved": 61,
  "output rpc needsYou.get": 61,
  "output rpc tabs.get": 61,
  "output rpc tabs.state": 61,
  "output rpc thread.inputQueue.get": 61,
  "output rpc thread.message.revisions.list": 61,
  "output rpc thread.messages.list": 61,
  "output command computer.view.close": 61,
  "output command computer.view.renew": 61,
  "output command integration.computer.setup.set": 61,
  "output command tab.activate": 61,
  "output command tab.open": 61,
  "output command tab.organize": 61,
  "output command tab.reopen": 61,
  "output command thread.input.edit": 61,
  "output command thread.sendMessage": 61,
  "output host frame host.computer-view.changed": 61,
  "output host frame host.computer-view.removed": 61,
  "output host frame host.events": 61,
  "output host frame host.snapshot": 61,
  "output host frame host.tabs": 61,
};

function personalWire(): PersonalWire {
  const teamCommands = new Set<string>(
    TeamCommandSchema.options
      .map((option) => option.shape.type.value)
      .filter((type) => type.startsWith("team.")),
  );
  const commandOptions = (union: z.ZodType, surface: "input" | "output") => {
    const byType = new Map<string, z.ZodType[]>();
    const collect = (schema: z.ZodType): void => {
      const [type] = schema._zod.propValues?.type ?? [];
      if (typeof type !== "string" || teamCommands.has(type)) return;
      const options = byType.get(type) ?? [];
      options.push(schema);
      byType.set(type, options);
    };
    for (const schema of wireUnionMembers(union)) collect(schema);
    return Object.fromEntries(
      [...byType].map(([type, options]) => [
        `command ${type}`,
        options.length === 1
          ? json(options[0]!)
          : surface === "input"
            ? { anyOf: options.map(json) }
            : { oneOf: options.map(json) },
      ]),
    );
  };
  // `team.*` reads are a team Host's; everything else is a personal Host's.
  const rpcs = Object.entries(hostApi).filter(
    ([name]) => !name.startsWith("team.") && name !== "commands.dispatch",
  );
  const frames = (union: z.ZodDiscriminatedUnion, prefix: string) =>
    Object.fromEntries(
      union.options.map((option) => [
        `${prefix} ${String(option._zod.propValues?.type?.values().next().value)}`,
        json(option),
      ]),
    );
  return {
    minimumHostApiVersion,
    input: {
      ...Object.fromEntries(
        rpcs.map(([name, declaration]) => [`rpc ${name}`, json(declaration.payload)]),
      ),
      ...commandOptions(hostApi["commands.dispatch"].payload, "input"),
      ...frames(ClientToHostMessageSchema as unknown as z.ZodDiscriminatedUnion, "client frame"),
    },
    output: {
      ...Object.fromEntries(
        rpcs.map(([name, declaration]) => [`rpc ${name}`, json(declaration.success)]),
      ),
      ...commandOptions(hostApi["commands.dispatch"].success, "output"),
      ...frames(HostToClientMessageSchema as unknown as z.ZodDiscriminatedUnion, "host frame"),
      descriptor: json(HostDescriptorSchema),
    },
    frames: {},
  };
}

/** Where the current tree breaks a reader or sender still inside the window. */
function windowBreaks(baseline: PersonalWire, current: PersonalWire): string[] {
  const breaks: string[] = [];
  for (const surface of ["input", "output"] as const) {
    for (const [name, schema] of Object.entries(baseline[surface])) {
      if (projectedSince[`${surface} ${name}`] !== undefined) continue;
      const next: JsonSchema | undefined = current[surface][name];
      if (!next) breaks.push(`${surface} ${name} was removed`);
      else breaks.push(...surfaceBreaks(schema, next, surface, `${surface} ${name}`));
    }
  }
  for (const name of Object.keys(current.output))
    if (name.startsWith("host frame ") && !(name in baseline.output))
      if (!optInFrames.has(name.slice("host frame ".length)))
        breaks.push(`output ${name} was added, and apps inside the window cannot read it`);
  return [...new Set(breaks)];
}

describe("personal wire compatibility", () => {
  it("keeps serving every app inside the window", () => {
    expect(minimumHostApiVersion).toBeLessThanOrEqual(hostApiVersion);
    for (const version of Object.values(projectedSince)) {
      expect(version).toBeGreaterThan(minimumHostApiVersion);
      expect(version).toBeLessThanOrEqual(hostApiVersion);
    }
    const current = personalWire();
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as PersonalWire;
    if (process.env[updateVariable] === "1") {
      expect(
        baseline.minimumHostApiVersion,
        "The baseline records the oldest version a Host serves; it moves only with minimumHostApiVersion.",
      ).toBeLessThan(minimumHostApiVersion);
      writeFileSync(baselinePath, `${JSON.stringify(current)}\n`);
      return;
    }
    expect(
      baseline.minimumHostApiVersion,
      `minimumHostApiVersion moved. Record the new baseline with ${updateVariable}=1 pnpm exec vitest run packages/protocol/src/personal-wire.test.ts`,
    ).toBe(minimumHostApiVersion);
    expect(
      windowBreaks(baseline, current),
      "This breaks apps the Host still serves. Make it additive, send it only to callers that ask for it, or project it for older callers and list it in projectedSince.",
    ).toEqual([]);
  });

  it("catches a new frame type, a removed field and a new required input", () => {
    const baseline = personalWire();
    const strip = (wire: PersonalWire, surface: "input" | "output", name: string) => ({
      ...wire,
      [surface]: Object.fromEntries(Object.entries(wire[surface]).filter(([key]) => key !== name)),
    });
    const anyFrame = Object.keys(baseline.output).find((name) => name.startsWith("host frame "))!;
    expect(windowBreaks(strip(baseline, "output", anyFrame), baseline)).toEqual([
      `output ${anyFrame} was added, and apps inside the window cannot read it`,
    ]);
    const anyRpc = Object.keys(baseline.output).find((name) => name.startsWith("rpc "))!;
    expect(windowBreaks(baseline, strip(baseline, "output", anyRpc))).toEqual([
      `output ${anyRpc} was removed`,
    ]);
    expect(same(windowBreaks(baseline, baseline), [])).toBe(true);
  });
});

describe("frozen v60 Device readers", () => {
  const field = (...path: (string | number)[]) => path;
  const properties = (...names: string[]) => names.flatMap((name) => ["properties", name]);
  const machineList = {
    path: properties("machines"),
    value: { machines: [fixture.machine, fixture.screen] },
    key: "machines",
  };
  const tabList = { path: properties("tabs"), value: fixture.tabs, key: "tabs" };
  const connection = {
    path: properties("connection"),
    value: { connection: fixture.connection },
    key: "connection",
  };
  const view = { path: properties("view"), value: { view: fixture.selfView }, key: "view" };
  const messageContent = (path: (string | number)[]) => ({
    path,
    value: { content: fixture.content },
    key: "content",
  });
  const cases: Record<string, { path: (string | number)[]; value: unknown; key: string }[]> = {
    "rpc bootstrap.get": [machineList, { ...tabList, key: "" }],
    "rpc machines.list": [machineList],
    "rpc devices.overview.get": [
      {
        path: properties("devices"),
        value: { devices: [fixture.machine, fixture.screen] },
        key: "devices",
      },
    ],
    "rpc integrations.get": [
      {
        path: properties("connections"),
        value: { connections: [fixture.connection, fixture.screenConnection] },
        key: "connections",
      },
    ],
    "rpc integration.computer.setup.list": [
      {
        path: properties("requests"),
        value: { requests: [fixture.setup, fixture.screenSetup] },
        key: "requests",
      },
    ],
    "rpc integration.computer.apps.approved": [
      {
        path: properties("apps"),
        value: {
          apps: [
            {
              connectionId: fixture.connection.id,
              machineId: fixture.screenId,
              target: { kind: "phone", display: "main" },
              name: "iPhone",
              iconPng: null,
            },
          ],
        },
        key: "apps",
      },
    ],
    "rpc needsYou.get": [
      {
        path: properties("entries"),
        value: {
          entries: [fixture.request, fixture.screenRequest].map((request) => ({
            kind: "request",
            request,
            originThreadId: fixture.threadId,
            navigationThreadId: fixture.threadId,
            purpose: "task",
            title: "Task",
          })),
        },
        key: "entries",
      },
    ],
    "rpc tabs.get": [{ path: [], value: fixture.tabs.tabs[0], key: "" }],
    "rpc tabs.state": [{ path: [], value: fixture.tabs, key: "" }],
    "rpc thread.inputQueue.get": [
      messageContent(field("properties", "items", "items", ...properties("message", "content"))),
    ],
    "rpc thread.message.revisions.list": [
      messageContent(field("properties", "revisions", "items", ...properties("content"))),
    ],
    "rpc thread.messages.list": [
      messageContent(field("properties", "messages", "items", ...properties("content"))),
    ],
    "command computer.view.close": [view],
    "command computer.view.renew": [view],
    "command integration.computer.setup.set": [connection],
    "command tab.activate": [viewForTab()],
    "command tab.open": [tabListItem()],
    "command tab.organize": [tabList],
    "command tab.reopen": [tabListItem()],
    "command thread.input.edit": [messageContent(properties("message", "content"))],
    "command thread.sendMessage": [messageContent(properties("message", "content"))],
    "host frame host.computer-view.changed": [view],
    "host frame host.computer-view.removed": [
      {
        path: [],
        value: {
          type: "host.computer-view.removed",
          viewId: fixture.selfView.viewId,
          generation: 1,
          machineId: fixture.selfId,
          reason: "closed",
        },
        key: "",
      },
    ],
    "host frame host.events": [
      {
        path: properties("events"),
        value: {
          events: [fixture.request, fixture.screenRequest].map((request) => ({
            environmentId: "env_00000000-0000-4000-8000-000000000001",
            eventId: "evt_00000000-0000-4000-8000-000000000001",
            deploymentId: fixture.setup.deploymentId,
            threadId: fixture.threadId,
            runId: fixture.runId,
            sequence: "1",
            createdAt: fixture.now,
            type: "request.opened",
            data: { request },
          })),
        },
        key: "events",
      },
    ],
    "host frame host.snapshot": [
      { ...tabList, path: properties("snapshot", "resources", "tabs"), key: "" },
      {
        path: properties("snapshot", "needsYou", "entries"),
        value: {
          entries: [fixture.screenRequest].map((request) => ({ kind: "request", request })),
        },
        key: "entries",
      },
    ],
    "host frame host.tabs": [
      {
        path: field("properties", "stream", "oneOf", 1, "properties", "rows"),
        value: fixture.tabs,
        key: "tabs",
      },
    ],
  };
  function tabListItem() {
    return { path: properties("tab"), value: { tab: fixture.tabs.tabs[0] }, key: "tab" };
  }
  function viewForTab() {
    return {
      path: properties("viewer"),
      value: { viewer: { kind: "phone", view: fixture.selfView } },
      key: "viewer",
    };
  }

  it("has a frozen-reader proof for every registered projection", () => {
    expect(Object.keys(archivedDeviceProjections).sort()).toEqual(
      Object.keys(cases)
        .map((name) => `output ${name}`)
        .sort(),
    );
  });
  for (const [name, proofs] of Object.entries(cases))
    it(name, () => {
      for (const { path, value, key } of proofs) {
        const projected = projectDeviceWire(value, 60, hiddenDeviceTabIds(fixture.tabs.tabs));
        const reader = frozenPersonalReader(name, path);
        const result = reader.safeParse(key ? Reflect.get(projected as object, key) : projected);
        expect(result.error?.issues, name).toBeUndefined();
      }
    });
});

it("compares nested commands, expanded references, and input unions without blessing output widening", () => {
  expect(personalWire().input).toHaveProperty("command machine.rename");
  expect(personalWire().input).toHaveProperty("command tab.close");
  expect(surfaceBreaks(json(RunnerIdSchema), json(DeviceIdSchema), "input")).toEqual([]);
  expect(surfaceBreaks(json(RunnerIdSchema), json(DeviceIdSchema), "output")).not.toEqual([]);
  expect(
    surfaceBreaks(
      json(z.strictObject({ id: z.string() })),
      json(z.strictObject({ id: z.string(), required: z.string() })),
      "input",
    ),
  ).not.toEqual([]);
  const repeated = z.object({ value: z.string() });
  const schema = z.object({ first: repeated, second: repeated });
  const { $schema: _, ...withRefs } = z.toJSONSchema(schema, { io: "input", reused: "ref" });
  expect(surfaceBreaks(json(schema), withRefs, "output")).toEqual([]);
});
