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
const plugin = {
  kind: "plugin",
  target: { kind: "installed", pluginId: "plg_9ff5456a-1a0a-4f3a-8624-ad2e56604518" },
  access: "read-write",
};
const selected = (tasks: boolean, ...resources: unknown[]) =>
  AgentGrantSchema.parse({ scope: "selected", tasks, resources });

describe("the connection's actual MCP listing", () => {
  it.each([
    ["everything", full],
    ["one profile, no tasks", selected(false, profile)],
    ["Chrome tabs only", selected(false, chrome)],
    ["phone only", selected(false, phone)],
    ["plugins only", selected(false, plugin)],
    ["read-only plugin", selected(false, { ...plugin, access: "read" })],
    ["tasks only", selected(true)],
    ["empty", selected(false)],
  ] as const)("names only callable tools and supported shapes for %s", async (_name, grant) => {
    const { tools, instructions } = await measureMcpContext("connection", { grant });
    const names = new Set(tools.map(({ name }) => name));
    const visible = JSON.stringify(tools) + instructions;
    const mentioned: readonly string[] = visible.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gu) ?? [];
    for (const { name } of agentTools)
      if (mentioned.includes(name)) expect(names.has(name), name).toBe(true);
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
      [...connectionDirectTools].filter((name) => names.has(name)).toSorted(),
    );
    if (grant.scope === "everything")
      expect(toolsWithReceiptId.toSorted()).toEqual([...connectionDirectTools].toSorted());
    for (const name of toolsWithReceiptId) {
      expect(input(name)?.properties?.operationId, name).toEqual({ type: "string" });
      expect(input(name)?.required ?? [], name).not.toContain("operationId");
    }
    const inventory = input("computer_apps");
    if (inventory) {
      expect(inventory.properties?.taskId).toEqual({ type: "string" });
      expect(inventory.required ?? []).not.toContain("taskId");
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
    for (const name of ["browser_use", "computer_use", "plugin_execute"])
      if (names.has(name))
        expect(input(name)?.properties?.code).toMatchObject({
          maxLength: requestOperationCallsMaxLength,
        });
    if (grant.scope === "selected" && grant.resources[0]?.kind === "chrome-tabs") {
      expect([...names].sort()).toEqual([
        "ask_person",
        "browser_connect",
        "browser_use",
        "tab_list",
      ]);
      expect(input("browser_connect")?.required).toContain("tabId");
      expect(input("browser_connect")?.properties).not.toHaveProperty("profileId");
      expect(instructions).not.toContain("browser profiles");
    }
    if (grant.scope === "selected" && grant.resources[0]?.kind === "browser-profile")
      expect([...names].sort()).toEqual([
        "ask_person",
        "browser_connect",
        "browser_profile_list",
        "browser_use",
        "card_request",
        "saved_login_request",
        "tab_list",
      ]);
    if (grant.scope === "selected" && grant.resources[0]?.kind === "computer-app")
      expect(input("computer_use")?.properties).not.toHaveProperty("app");
    if (
      grant.scope === "selected" &&
      grant.resources[0]?.kind === "plugin" &&
      grant.resources[0].access === "read"
    ) {
      expect(names.has("plugin_call")).toBe(true);
      expect(names.has("plugin_execute")).toBe(false);
    }
    if (grant.scope === "selected" && !grant.tasks)
      expect(names.has("opensteer_ai_account_list")).toBe(false);
    if (grant.scope === "selected" && grant.tasks) {
      expect(names.has("opensteer_ai_account_list")).toBe(true);
      expect(input("opensteer_task_create")?.required).not.toContain("aiAccountId");
      expect(input("opensteer_task_create")?.required).not.toContain("model");
      expect(instructions).not.toMatch(/Chrome|computer_apps|plugin_search/u);
    }
    if (names.has("browser_use")) expect(instructions).toContain("returned operationId");
  });

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
