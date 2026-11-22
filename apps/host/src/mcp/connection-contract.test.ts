import { agentTools, connectionDirectTools, normalizeToolError } from "@opensteer/agent-tools";
import { AgentGrantSchema, createId, requestOperationCallsMaxLength } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { measureMcpContext } from "../agents/agent-context-budget.test-support.js";
import { agentToolFailure } from "./agent-tool-failure.js";

const full = { scope: "everything" } as const;
const profile = { kind: "browser-profile", profileId: createId("browserProfile") };
const chrome = { kind: "chrome-tabs", sourceId: createId("browserSource") };
const phone = {
  kind: "computer-app",
  deviceId: createId("device"),
  approvalId: "con_9ff5456a-1a0a-4f3a-8624-ad2e56604518",
  app: { kind: "phone-screen", definitionId: "iphone-screen" },
};
const mac = { ...phone, app: { kind: "mac-app", bundleId: "com.apple.Notes", teamId: null } };
const plugin = {
  kind: "plugin",
  target: { kind: "installed", pluginId: "plg_9ff5456a-1a0a-4f3a-8624-ad2e56604518" },
  access: "read-write",
};
const selected = (tasks: boolean, ...resources: unknown[]) =>
  AgentGrantSchema.parse({ scope: "selected", tasks, resources });

const common = ["ask_person", "discover"];
const browser = ["browser_connect", "browser_use"];
const passwords = ["saved_login_request", "card_request"];
const plugins = ["plugin_call", "plugin_resume"];
const tasks = [
  "opensteer_task_create",
  "opensteer_task_read",
  "opensteer_task_send",
  "opensteer_task_wait",
  "opensteer_task_interrupt",
];
const everything = [
  ...common,
  ...browser,
  ...passwords,
  ...plugins,
  ...tasks,
  "computer_use",
  "plugin_execute",
];

const removedNames = [
  "opensteer_ai_account_list",
  "opensteer_ai_account_update",
  "opensteer_defaults_read",
  "opensteer_defaults_update",
  "tab_list",
  "app_list",
  "computer_list",
  "computer_update",
  "computer_remove",
  "computer_apps",
  "browser_profile_list",
  "browser_profile_update",
  "browser_profile_remove",
  "plugin_search",
  "opensteer_plugin_catalog",
  "plugin_skills",
  "plugin_resources",
  "opensteer_plugin_resource_update",
  "plugin_describe",
  "opensteer_plugin_list",
  "opensteer_plugin_install",
  "opensteer_plugin_export",
  "opensteer_plugin_activate",
  "opensteer_plugin_remove",
  "local_server_add",
  "local_server_list",
  "local_server_remove",
  "opensteer_request_list",
  "opensteer_request_read",
  "opensteer_delegation_wait",
  "opensteer_subagent_read",
  "opensteer_task_resume",
  "opensteer_task_list",
  "opensteer_delegation_status",
  "opensteer_task_update",
  "opensteer_task_configure",
  "opensteer_task_queue",
  "opensteer_automation_read",
  "opensteer_automation_update",
  "opensteer_automation_control",
  "opensteer_automation_list",
  "opensteer_automation_create",
  "tab_open",
  "tab_close",
  // Messaging is a connection now: these tools are gone for good.
  "opensteer_messaging_bridge_list",
  "opensteer_messaging_bridge_update",
  "opensteer_messaging_bridge_remove",
];
function unavailableMentions(
  visible: string,
  offered: ReadonlySet<string>,
  catalog: readonly string[] = [...agentTools.map(({ name }) => name), "discover"],
) {
  const knownNames = new Set([...catalog, ...removedNames]);
  const words = new Set(visible.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)*/gu) ?? []);
  return [...knownNames].filter((name) => words.has(name) && !offered.has(name));
}

it("flags a retired name even when it is absent from the offered tools", () => {
  expect(
    unavailableMentions("Use tab_list, then discover.", new Set(["discover"]), ["discover"]),
  ).toEqual(["tab_list"]);
});

describe("the connection's actual MCP listing", () => {
  const shapes: [
    string,
    ReturnType<typeof selected>,
    readonly string[],
    "approval-required" | undefined,
  ][] = [
    ["everything", full, everything, undefined],
    ["everything supervised", full, everything, "approval-required"],
    [
      "one profile, no tasks",
      selected(false, profile),
      [...common, ...browser, ...passwords],
      undefined,
    ],
    ["Chrome tabs only", selected(false, chrome), [...common, ...browser], undefined],
    ["phone only", selected(false, phone), [...common, "computer_use"], undefined],
    ["Mac app only", selected(false, mac), [...common, "computer_use"], undefined],
    [
      "read-write plugin",
      selected(false, plugin),
      [...common, ...plugins, "plugin_execute"],
      undefined,
    ],
    [
      "read-only plugin",
      selected(false, { ...plugin, access: "read" }),
      [...common, ...plugins],
      undefined,
    ],
    ["tasks only", selected(true), [...common, ...tasks], undefined],
    ["empty", selected(false), [], undefined],
  ];
  it.each(shapes)(
    "names only callable tools and supported shapes for %s",
    async (_name, grant, expected, accessMode) => {
      const { tools, instructions } = await measureMcpContext("connection", {
        grant,
        ...(accessMode ? { accessMode } : {}),
      });
      const names = new Set(tools.map(({ name }) => name));
      expect([...names].sort()).toEqual([...expected].sort());
      expect(instructions.match(/\bdiscover\b/gu) ?? []).toHaveLength(
        names.has("discover") ? 1 : 0,
      );
      const visible = JSON.stringify(tools) + instructions;
      expect(unavailableMentions(visible, names)).toEqual([]);
      expect(visible).not.toMatch(
        /opensteer:[a-z]|Browser Harness|\bfill(?:Login|Card)\s*\(|\btab\(tabId\)/u,
      );
      expect(names.has("tab_open")).toBe(false);
      expect(names.has("tab_close")).toBe(false);
      expect(tools.every((tool) => tool.outputSchema === undefined)).toBe(true);
      const input = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
      const toolsWithReceiptId = tools
        .filter(({ inputSchema }) => inputSchema.properties?.operationId)
        .map(({ name }) => name);
      expect(toolsWithReceiptId.toSorted()).toEqual(
        [...connectionDirectTools]
          .filter((name) => grant.scope === "everything" || names.has(name))
          .toSorted(),
      );
      for (const name of toolsWithReceiptId) {
        expect(input(name)?.properties?.operationId, name).toEqual({ type: "string" });
        expect(input(name)?.required ?? [], name).not.toContain("operationId");
      }
      const description = (name: string) => tools.find((tool) => tool.name === name)?.description;
      if (names.has("opensteer_task_interrupt")) {
        expect(description("opensteer_task_interrupt")).toContain("Only the person can resume it.");
        expect(description("opensteer_task_send")).toContain("waits if paused");
        const create = input("opensteer_task_create")?.properties;
        expect(create).not.toHaveProperty("aiAccountId");
        expect(create).not.toHaveProperty("model");
      }
      if (names.has("discover"))
        expect(Object.keys(input("discover")?.properties ?? {}).sort()).toEqual([
          "cursor",
          "id",
          "query",
          "taskId",
        ]);
      if (names.has("discover")) {
        expect(input("discover")?.required ?? []).not.toContain("taskId");
        expect(description("discover")).toContain("taskId applies only to live reads");
      }
      const question = input("ask_person");
      if (question) {
        expect(question.properties?.questions).toMatchObject({
          minItems: 1,
          maxItems: 1,
          items: {
            additionalProperties: false,
            properties: { question: { type: "string" } },
          },
        });
        expect(JSON.stringify(question)).not.toMatch(/multiSelect|free.text/u);
      }
      for (const name of ["saved_login_request", "card_request"])
        if (names.has(name)) expect(input(name)?.required).toContain("tabId");
      if (names.has("card_request"))
        expect(description("card_request")).toContain(
          "Opensteer fills the card into the page without returning it. A script in that page can read it.",
        );
      const pluginInput = "use plugin_resume with the returned executionId and taskId instead.";
      if (names.has("plugin_resume")) {
        expect(instructions).toContain(pluginInput);
        expect(description("plugin_resume")).toContain("direct-work taskId");
      } else {
        expect(instructions).not.toContain("plugin_resume");
        expect(instructions).not.toContain("executionId");
      }
      for (const name of ["browser_use", "computer_use", "plugin_execute"])
        if (names.has(name))
          expect(input(name)?.properties?.code).toMatchObject({
            maxLength: requestOperationCallsMaxLength,
          });
      if (grant.scope === "selected" && grant.resources[0]?.kind === "chrome-tabs") {
        expect(input("browser_connect")?.required).toContain("tabId");
        expect(input("browser_connect")?.properties).not.toHaveProperty("profileId");
        expect(instructions).not.toContain("browser profiles");
      }
      if (grant.scope === "selected" && grant.resources[0]?.kind === "computer-app") {
        if (grant.resources[0].app.kind === "mac-app") {
          expect(input("computer_use")?.required).toContain("app");
          expect(input("computer_use")?.required).toContain("computerId");
          expect(description("computer_use")).not.toMatch(/phone|\.observe\(\)/u);
        } else {
          expect(input("computer_use")?.properties).not.toHaveProperty("app");
        }
      }
      if (
        grant.scope === "selected" &&
        grant.resources[0]?.kind === "plugin" &&
        grant.resources[0].access === "read"
      ) {
        expect(names.has("plugin_call")).toBe(true);
        expect(names.has("plugin_execute")).toBe(false);
        expect(description("plugin_call")).toContain("Only read tools run.");
      }
      if (grant.scope === "selected" && !grant.tasks) {
        expect(names.has("opensteer_ai_account_list")).toBe(false);
        expect(instructions).not.toMatch(
          /opensteer_(?:task|request|delegation|subagent|automation)_/u,
        );
      }
      if (grant.scope === "selected" && grant.tasks) {
        expect(input("opensteer_task_create")?.properties).not.toHaveProperty("aiAccountId");
        expect(input("opensteer_task_create")?.properties).not.toHaveProperty("model");
        expect(instructions).not.toMatch(/Chrome|computer_apps|plugin_search/u);
      }
      if (names.has("browser_use")) expect(instructions).toContain("returned operationId");
    },
  );

  it.each([
    ["a managed Cloud Home", false],
    ["a self-hosted Linux Home with no Passwords broker", () => false],
  ] as const)(
    "omits both Passwords tools and their instructions on %s",
    async (_home, available) => {
      const { tools, instructions } = await measureMcpContext("connection", {
        grant: full,
        connectionPasswords: available,
      });
      expect(tools.map(({ name }) => name)).not.toContain("saved_login_request");
      expect(tools.map(({ name }) => name)).not.toContain("card_request");
      expect(instructions).not.toMatch(/saved_login_request|card_request|Opensteer fills/u);
      expect(
        unavailableMentions(
          JSON.stringify(tools) + instructions,
          new Set(tools.map(({ name }) => name)),
        ),
      ).toEqual([]);
      expect(tools.find(({ name }) => name === "browser_connect")?.description).toContain(
        "context.newCDPSession(page) works",
      );
    },
  );

  it.each(["Your organization doesn't allow this", "Sign-in and new work on this Home have ended"])(
    "classifies a work Home SQLSTATE 42501 gate: %s",
    (message) => {
      const failure = Object.assign(new Error(message), { code: "42501" });
      const policy = normalizeToolError(agentToolFailure(failure, "write", undefined, true), {
        tools: new Set(),
      });
      expect(policy).toMatchObject({ code: "organization_not_allowed", message });
      const other = Object.assign(new Error("a private database failure"), { code: "42501" });
      expect(agentToolFailure(other, "write", undefined, true)).toMatchObject({
        code: "internal",
        message: "Opensteer hit an internal error.",
      });
    },
  );
});
