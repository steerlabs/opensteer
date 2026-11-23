import { describe, expect, it } from "vitest";
import {
  ToolFailureSchema,
  agentToolFailureResult,
  normalizeToolError,
  withoutUnofferedGuidance,
  withoutUnofferedTools,
} from "./results.js";

const connection = { tools: new Set(["computer_list"]) };

describe("connection tool refusals", () => {
  it.each([
    ["person-declined", "declined_by_person"],
    ["agent-session-stopped", "stopped_by_person"],
    ["authority-changed", "access_changed"],
    ["target-unavailable", "not_found"],
    ["device-access-off", "access_denied"],
    ["device-stopped", "computer_stopped"],
    ["device-asleep", "computer_asleep"],
    ["device-offline", "computer_offline"],
    [undefined, "access_denied"],
  ])("maps %s to %s in both result channels", (reason, code) => {
    const result = agentToolFailureResult(
      { code: "forbidden", message: "Refused.", reason },
      connection,
    );
    expect(result.structuredContent.error.code).toBe(code);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("uses one not_found reply and drops advice for tools the connection cannot use", () => {
    const hidden = normalizeToolError(
      {
        code: "forbidden",
        reason: "target-unavailable",
        message: "That private target exists.",
        next: "Use computer_access_request.",
      },
      connection,
    );
    expect(hidden).toEqual(
      normalizeToolError({ code: "not_found", message: "No such target." }, connection),
    );
    const blocked = {
      code: "forbidden",
      message: "Switch off.",
      reason: "device-access-off",
      computerId: "device",
      capability: "apps" as const,
    };
    expect(normalizeToolError(blocked).next).toContain("computer_access_request");
    expect(normalizeToolError(blocked, connection).next).not.toContain("computer_access_request");
    expect(
      normalizeToolError({ ...blocked, next: "Use computer_list." }, connection).next,
    ).toContain("computer_list");
    expect(normalizeToolError({ ...blocked, reason: "person-declined" }).code).toBe(
      "access_denied",
    );
  });
});

it("normalizes both MCP channels to one ToolError and discards internal control fields", () => {
  const result = agentToolFailureResult({
    code: "forbidden",
    message: "Access denied",
    next: "Use computer_access_request with computerId=rnr_example.",
    computerId: "rnr_example",
    capability: "apps",
    reason: "internal-reason",
    retryable: true,
  });
  const expected = {
    error: {
      code: "access_denied",
      message: "Access denied",
      next: "Use computer_access_request with computerId=rnr_example.",
    },
  };
  expect(result).toEqual({
    content: [{ type: "text", text: JSON.stringify(expected) }],
    structuredContent: expected,
    isError: true,
  });
  expect(ToolFailureSchema.parse(result.structuredContent)).toEqual(expected);
  expect(
    agentToolFailureResult({
      code: "outcome_unknown",
      message: "Observe before repeating.",
      retryable: true,
    }).structuredContent.error.next,
  ).toBeNull();
});

describe("text Opensteer wrote for its own agents, as a connection reads it", () => {
  const offered = new Set(["discover", "plugin_call", "computer_use"]);

  it("leaves out each sentence naming a tool the connection is not offered", () => {
    expect(
      withoutUnofferedTools(
        "This app or phone is no longer approved for this task. Call computer_apps for current access.",
        offered,
      ),
    ).toBe("This app or phone is no longer approved for this task.");
    expect(withoutUnofferedTools("Use discover, then plugin_call.", offered)).toBe(
      "Use discover, then plugin_call.",
    );
    expect(
      withoutUnofferedTools("Supply the one plugin namespace from plugin_search.", offered),
    ).toBe("");
  });

  it("applies the rule to a refusal's message as well as its next step", () => {
    expect(
      normalizeToolError(
        {
          code: "bad_request",
          message: "Supply the one plugin namespace from plugin_search.",
          next: "Call app_access_request first.",
        },
        { tools: offered },
      ),
    ).toEqual({ code: "invalid_input", message: "Tool call failed.", next: null });
    // The person's own agents read every word.
    expect(
      normalizeToolError({ code: "bad_request", message: "Use plugin_search first." }),
    ).toMatchObject({ message: "Use plugin_search first." });
  });

  it("rewrites blocked notes and refusal-shaped plugin errors, never a plugin's own value", () => {
    const blocked = {
      code: "access_required",
      message: "Phone needs access for this task.",
      next: 'Request access with app_access_request {computerId:"dev_1", access:"read-write"}; the owner can approve from any Opensteer app.',
    };
    const value = { code: "x", message: "Use tab_list.", next: "Then computer_apps." };
    const shown = withoutUnofferedGuidance(
      {
        items: [{ id: "dev_1", kind: "phone", blocked }],
        result: {
          execution: {
            value: [
              { path: "tools.calendar.read", ok: false, error: blocked },
              { path: "tools.calendar.list", ok: true, value: { error: value } },
            ],
          },
        },
        next: "Use plugin_search for its tools.",
      },
      offered,
    );
    expect(JSON.stringify(shown)).not.toMatch(/app_access_request|plugin_search/u);
    expect(shown.items[0]!.blocked).toEqual({
      code: "access_required",
      message: "Phone needs access for this task.",
      next: "Continue with what is shared with you, or tell the person what you need.",
    });
    expect(shown.result.execution.value[1]).toEqual({
      path: "tools.calendar.list",
      ok: true,
      value: { error: value },
    });
    expect(shown.next).toBe(
      "Continue with what is shared with you, or tell the person what you need.",
    );
  });
});
