import { ModelSelectionSchema } from "@opensteer/core";
import { SettingsInputSchema } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { projectSettingsInput } from "./team-settings.js";

const claude = {
  id: "hin_00000000-0000-4000-8000-0000000000c1",
  driverKind: "claude",
  name: "Claude Code",
  models: [
    { modelId: "claude-opus-5", providerId: "anthropic", options: {} },
    { modelId: "claude-sonnet-5", providerId: "anthropic", options: {} },
  ],
} as never as Parameters<typeof projectSettingsInput>[0]["instance"];

const saved = {
  workspaceId: "wsp_00000000-0000-4000-8000-000000000002",
  harnessInstanceId: "hin_00000000-0000-4000-8000-0000000000c1",
  modelSelection: ModelSelectionSchema.parse({
    modelId: "claude-opus-5",
    providerId: "anthropic",
    options: { effort: "high", thinking: true },
  }),
  accessMode: "auto-accept-edits",
  instructions: "Draft launch copy.",
  timeZone: "Europe/London",
  revision: 3,
  updatedBy: "usr_00000000-0000-4000-8000-0000000000a1",
  updatedAt: "2026-11-08T09:30:00.000Z",
} as never as Parameters<typeof projectSettingsInput>[0]["saved"];

describe("saving a Project's runtime settings", () => {
  it("keeps the saved model options when only the instructions change", () => {
    const sent = projectSettingsInput({
      saved,
      instance: claude,
      model: claude.models[0]!,
      accessMode: "auto-accept-edits",
      instructions: "Draft launch copy. Ask before publishing.",
      timeZone: "Europe/London",
    });
    expect(SettingsInputSchema.parse(sent)).toMatchObject({
      modelSelection: { modelId: "claude-opus-5", options: { effort: "high", thinking: true } },
      instructions: "Draft launch copy. Ask before publishing.",
    });
  });

  it("starts a newly chosen model from the Host's choice, carrying none of the old options", () => {
    const sent = projectSettingsInput({
      saved,
      instance: claude,
      model: claude.models[1]!,
      accessMode: "auto-accept-edits",
      instructions: "Draft launch copy.",
      timeZone: "Europe/London",
    });
    expect(sent.modelSelection).toEqual({
      modelId: "claude-sonnet-5",
      providerId: "anthropic",
      options: {},
    });
  });
});
