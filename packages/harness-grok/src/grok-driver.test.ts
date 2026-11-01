import { ModelSelectionSchema, harnessUsageLimitFailureCode } from "@opensteer/core";
import { readFile } from "node:fs/promises";
import type { HarnessSessionContext } from "@opensteer/harness";
import { describe, expect, it } from "vitest";
import {
  grokAcpError,
  grokLaunchArguments,
  grokPermissionChoices,
  normalizeGrokUpdate,
  parseGrokDeviceChallenge,
  rewriteGrokSkillInvocation,
  withResolvedGrokEffort,
} from "./grok-driver.js";
import { grokModelsFromInitializeMetadata, parseGrokModelsOutput } from "./model-catalog.js";

const fixture = (name: string) =>
  readFile(new URL(`./test-fixtures/${name}`, import.meta.url), "utf8");

describe("Grok's qualified CLI contract", () => {
  it("uses the exact access-mode launch arguments", () => {
    expect(grokLaunchArguments("approval-required")).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "stdio",
    ]);
    expect(grokLaunchArguments("auto")).toEqual(["--permission-mode", "auto", "agent", "stdio"]);
    expect(grokLaunchArguments("full-access")).toEqual(["agent", "--always-approve", "stdio"]);
    expect(() => grokLaunchArguments("auto-accept-edits")).toThrow(/does not support/u);
  });

  it("parses the real signed-out model listing without publishing aliases", async () => {
    const output = `${await fixture("grok-1.0.70-models-signed-out.txt")}  - grok-build\n`;
    expect(
      parseGrokModelsOutput(output).map(({ isDefault, modelId }) => ({ isDefault, modelId })),
    ).toEqual([
      { isDefault: true, modelId: "grok-4.6" },
      { isDefault: false, modelId: "grok-4.5" },
    ]);
  });

  it("publishes complete initialize metadata with effort", async () => {
    const response = JSON.parse(await fixture("grok-1.0.70-initialize.json")) as {
      readonly _meta: Readonly<Record<string, unknown>>;
    };
    const models = grokModelsFromInitializeMetadata(response._meta);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      contextWindow: 500_000,
      isDefault: true,
      modelId: "grok-4.6",
      options: [{ defaultValue: "high", id: "effort" }],
      providerId: "xai",
    });
    const effort = models[0]?.options[0];
    expect(effort?.type).toBe("select");
    if (effort?.type !== "select") throw new Error("Grok effort option was not a select");
    expect(effort.values.map((value) => value.value)).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("parses the real device-code challenge", async () => {
    expect(parseGrokDeviceChallenge(await fixture("grok-1.0.70-device-auth.txt"))).toEqual({
      userCode: "2G4V-A592",
      verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=2G4V-A592",
    });
    expect(
      parseGrokDeviceChallenge("https://attacker.example/oauth2/device?user_code=2G4V-A592"),
    ).toBeUndefined();
  });
});

describe("Grok normalization", () => {
  it("never presents persistent grants as run-only grants", () => {
    expect(
      grokPermissionChoices({
        options: [
          { id: "allow_once", kind: "allow_once", label: "Allow" },
          { id: "allow_always", kind: "allow_always", label: "Always allow" },
          {
            id: "allow-edits-session",
            kind: "allow-edits-session",
            label: "Allow edits for this Run",
          },
        ],
        toolCall: { id: "call" },
      }),
    ).toEqual([
      { hint: "allow-once", label: "Allow", optionId: "allow_once" },
      {
        hint: "allow-for-run",
        label: "Allow edits for this Run",
        optionId: "allow-edits-session",
      },
    ]);
  });

  it("maps native subagent lifecycle updates", () => {
    expect(
      normalizeGrokUpdate({
        child_session_id: "child-session",
        description: "Check tests",
        sessionUpdate: "subagent_spawned",
        subagent_id: "child",
      }),
    ).toEqual([
      {
        key: "child",
        kind: "subagent",
        prompt: "Check tests",
        sessionReference: "child-session",
        state: "started",
        title: "Check tests",
      },
    ]);
    expect(
      normalizeGrokUpdate({
        sessionUpdate: "subagent_finished",
        status: "cancelled",
        subagent_id: "child",
      }),
    ).toEqual([{ key: "child", kind: "subagent", state: "failed" }]);
  });

  it("rewrites only enabled leading skill invocations", () => {
    const context = { skills: { skills: [{ name: "review", path: "/skills/review" }] } };
    expect(rewriteGrokSkillInvocation("$review this\n\n$missing that", context)).toBe(
      "/review this\n\n$missing that",
    );
    expect(rewriteGrokSkillInvocation("mention $review here", context)).toBe(
      "mention $review here",
    );
  });

  it("classifies quota errors with the stable run failure code", () => {
    expect(grokAcpError(new Error("rate limit reached"), { stderrTail: "" })).toMatchObject({
      details: { acpFailureCode: harnessUsageLimitFailureCode },
    });
  });

  it("sends a listed effort and leaves an unlisted one to Grok's default", () => {
    const catalog = new Map([
      ["grok-4.6", { defaultValue: "high", values: ["low", "high", "xhigh"] }],
    ]);
    const resolved = (effort: string) =>
      withResolvedGrokEffort(
        {
          modelSelection: ModelSelectionSchema.parse({
            modelId: "grok-4.6",
            options: { effort },
            providerId: "xai",
          }),
        } as HarnessSessionContext,
        catalog,
      ).modelSelection.options.effort;
    expect(resolved("xhigh")).toBe("xhigh");
    expect(resolved("ultra")).toBeUndefined();
  });
});
