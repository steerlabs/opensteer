import { HarnessInstanceIdSchema, type ThreadAccessMode } from "@opensteer/core";
import type { SettingsInput } from "@opensteer/protocol";
import type { ProjectRuntimeChoices, ProjectSettingsRead } from "./team-access.js";

type Choice = ProjectRuntimeChoices["instances"][number];
type ChoiceModel = Choice["models"][number];

/**
 * The runtime settings a save sends, from what the form edits. Everything
 * the form doesn't edit comes from the saved settings, never from a catalog
 * entry: the runtime choices list models, not the options each one offers.
 */
export function projectSettingsInput(input: {
  readonly saved: ProjectSettingsRead["settings"];
  readonly instance: Choice;
  readonly model: ChoiceModel;
  readonly accessMode: ThreadAccessMode;
  readonly instructions: string;
  readonly timeZone: string;
}): SettingsInput {
  const { model, saved } = input;
  const unchanged =
    saved !== null &&
    saved.harnessInstanceId === input.instance.id &&
    saved.modelSelection.providerId === model.providerId &&
    saved.modelSelection.modelId === model.modelId;
  return {
    harnessInstanceId: HarnessInstanceIdSchema.parse(input.instance.id),
    modelSelection: {
      modelId: model.modelId,
      providerId: model.providerId,
      // Same engine and model: the saved options, untouched. A new model starts
      // from the Host's choice for it, so no option the old model had carries over.
      options: unchanged ? saved.modelSelection.options : model.options,
    },
    accessMode: input.accessMode,
    instructions: input.instructions,
    timeZone: input.timeZone.trim(),
  };
}
