import type { AcpSessionConfigOption } from "@opensteer/harness-acp";
import { describe, expect, it } from "vitest";
import { antigravityModelDescriptors, antigravitySessionPolicy } from "./driver.js";

const initial: readonly AcpSessionConfigOption[] = [
  {
    category: "model",
    currentValue: "gemini-3.1-pro",
    id: "model",
    name: "Model",
    options: [
      { label: "Gemini 3.1 Pro", value: "gemini-3.1-pro" },
      { label: "Claude Sonnet", value: "claude-sonnet-5-5" },
    ],
    type: "select",
  },
  {
    category: "thought_level",
    currentValue: "high",
    id: "thinking",
    name: "Thinking",
    options: [
      { label: "Low", value: "low" },
      { label: "High", value: "high" },
    ],
    type: "select",
  },
];

describe("Antigravity ACP policy", () => {
  it("uses Zed identity, read-only files, resume, and explicit access-mode mappings", () => {
    expect(antigravitySessionPolicy(1)).toMatchObject({
      accessModeIds: {
        "approval-required": "default",
        "auto-accept-edits": "auto_edit",
        auto: "default",
        "full-access": "yolo",
      },
      cancel: { behavior: "wait-for-prompt" },
      clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
      clientInfo: { name: "zed", version: "0.0.0" },
      eagerAuthentication: true,
      model: {
        effortCategory: "thought_level",
        effortOptionId: "effort",
        type: "config-options",
      },
      resume: { method: "resume", suppressReplay: false },
    });
  });

  it("publishes model-specific thought levels as effort", () => {
    const claude = initial.map((option) =>
      option.category === "thought_level"
        ? {
            ...option,
            currentValue: "medium",
            options: [
              { label: "Medium", value: "medium" },
              { label: "Ultra", value: "ultra" },
            ],
          }
        : option,
    );
    const models = antigravityModelDescriptors(
      initial,
      new Map([
        ["gemini-3.1-pro", initial],
        ["claude-sonnet-5-5", claude],
      ]),
    );

    expect(models).toMatchObject([
      {
        isDefault: true,
        modelId: "gemini-3.1-pro",
        options: [
          { defaultValue: "high", id: "effort", values: [{ value: "low" }, { value: "high" }] },
        ],
        providerId: "google",
      },
      {
        isDefault: false,
        modelId: "claude-sonnet-5-5",
        options: [
          {
            defaultValue: "medium",
            id: "effort",
            values: [{ value: "medium" }, { value: "ultra" }],
          },
        ],
        providerId: "anthropic",
      },
    ]);
  });
});
