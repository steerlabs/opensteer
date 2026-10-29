import type { EditingTargetAbilities } from "@opensteer/client/editing";
import type { EditingContext } from "@opensteer/protocol/editing";

/** Native replacements require a non-sensitive mirror that the target can verify. */
export function editingProxyAttributes(
  abilities: EditingTargetAbilities,
  context: EditingContext | null,
) {
  const field = context?.field;
  const suggestions = abilities.rangeEdits && field != null && !field.sensitive;
  return {
    ...(suggestions ? {} : { autoComplete: "off" }),
    autoCorrect: suggestions ? "on" : "off",
    spellCheck: suggestions,
    autoCapitalize: suggestions ? (field.autocapitalize ?? "off") : "off",
    // Supplying text for an absent hint changes Chromium's native password action key.
    inputMode: field ? field.inputMode : ("none" as const),
    enterKeyHint: field?.enterKeyHint,
  };
}
