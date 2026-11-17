import { validateJsonSchema } from "@opensteer/shared/jsonSchemaValidation";
import { parseComputerAppConfig } from "@opensteer/integration-core/computer-app";
import { describe, expect, it } from "vitest";
import { deviceDefinitions, getDeviceDefinition } from "./index.js";

describe("device catalog", () => {
  it("defines each device app once", () => {
    const ids = deviceDefinitions.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("publishes only observe and act for the GUI computer app", () => {
    const definition = getDeviceDefinition("macos-app");
    if (!definition) throw new Error("The catalog must define macos-app");
    const config = parseComputerAppConfig(definition);
    expect(config.kind).toBe("gui");
    expect(config.operations.map(({ effect, name }) => [name, effect])).toEqual([
      ["observe", "read"],
      ["act", "write"],
    ]);
    const act = config.operations.find(({ name }) => name === "act");
    expect(act?.inputSchema).toMatchObject({
      properties: { window: { type: "string" }, snapshot: { type: ["string", "null"] } },
      required: ["window", "snapshot", "actions"],
      additionalProperties: false,
    });
    const observe = config.operations.find(({ name }) => name === "observe");
    for (const operation of ["windows", "bind", "observe"])
      expect(validateJsonSchema(observe?.inputSchema, { operation })).toEqual([]);
    expect(validateJsonSchema(observe?.inputSchema, {})).not.toEqual([]);
    expect(
      validateJsonSchema(observe?.inputSchema, { operation: "observe", extra: true }),
    ).not.toEqual([]);
    for (const row of config.operations) expect(row.description).toContain("computer_use");
    expect(config.platforms).toEqual(["darwin"]);
    expect(config.accessLabels).toEqual({ read: "Can see", readWrite: "Can see and control" });
    expect(
      validateJsonSchema(act?.inputSchema, {
        window: "window-1",
        snapshot: null,
        actions: [{ type: "key", keys: "cmd+s" }],
      }),
    ).toEqual([]);
    expect(
      validateJsonSchema(act?.inputSchema, {
        window: "window-1",
        snapshot: null,
        actions: [{ type: "wait", ms: 1 }],
      }),
    ).not.toEqual([]);
    expect(
      validateJsonSchema(act?.inputSchema, {
        observationId: "obs-1",
        actions: [{ type: "key", keys: "cmd+s" }],
      }),
    ).not.toEqual([]);
    const messages = getDeviceDefinition("apple-messages");
    if (!messages) throw new Error("The catalog must define apple-messages");
    expect(parseComputerAppConfig(messages).kind).toBeUndefined();
  });
});
