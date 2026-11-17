import {
  idleCompactionTitle,
  idleCompactionChoices,
  idleCompactionHelp,
} from "@opensteer/client/host";
import { useIdleCompactionSettings } from "@opensteer/client/react";
import { useShell } from "../../app-shell.js";
import { SettingsGroup, SettingsError } from "../primitives.js";
export function IdleCompactionSection() {
  const { hostClient } = useShell();
  const form = useIdleCompactionSettings(hostClient);
  return (
    <SettingsGroup
      heading={idleCompactionTitle}
      headingId="idle-compaction"
      note={idleCompactionHelp}
    >
      <fieldset className="settings-choice-group" disabled={form.pending}>
        <legend className="visually-hidden">{idleCompactionTitle}</legend>
        {idleCompactionChoices.map((choice) => (
          <label
            key={choice.value}
            className={`settings-choice${form.policy.mode === choice.value ? " is-selected" : ""}`}
          >
            <input
              type="radio"
              name="idle-compaction"
              value={choice.value}
              checked={form.policy.mode === choice.value}
              onChange={() => form.save({ mode: choice.value })}
            />
            <span className="settings-choice__copy">
              <span className="settings-choice__title">{choice.label}</span>
              <span className="settings-choice__detail">{choice.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <SettingsError message={form.error} />
    </SettingsGroup>
  );
}
