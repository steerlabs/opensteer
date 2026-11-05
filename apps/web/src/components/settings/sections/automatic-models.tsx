import { parseAutomaticModelConfig } from "@opensteer/client/host";
import { useState, useSyncExternalStore } from "react";
import { type AutomaticModelConfig } from "@opensteer/core";
import {
  automaticModelChoices,
  automaticModelsDismissalKey,
  automaticModelsExplanation,
  automaticModelsTitle,
  automaticPreviewLines,
  automaticRoleEntries,
  automaticRoleTitles,
  editAutomaticRole,
  getAutomaticModels,
  setAutomaticModels,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { browserNoticeDismissals } from "../../usage-notice.js";
import { SettingsError, SettingsGroup } from "../primitives.js";
import { useSettingsRead } from "../use-settings-read.js";
export function AutomaticModelsSection() {
  const { hostClient, snapshot } = useShell();
  const read = useSettingsRead(() => getAutomaticModels(hostClient), "automatic-models");
  const store = browserNoticeDismissals("opensteer.usage-notices.dismissed");
  const keys = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [choices, setChoices] = useState({ light: "", deep: "" });
  if (!hostClient.automaticModelsAvailable?.()) return null;
  const view = read.data;
  const save = (make: () => AutomaticModelConfig) => {
    try {
      const config = make();
      setPending(true);
      setFailure(null);
      void setAutomaticModels(hostClient, config)
        .then(
          () => {
            setJson(null);
            read.reload();
          },
          (e) => setFailure(actionErrorMessage(e)),
        )
        .finally(() => setPending(false));
    } catch (e) {
      setFailure(actionErrorMessage(e));
    }
  };
  const key = automaticModelsDismissalKey(snapshot.deploymentId ?? "", snapshot.user?.id ?? "");
  const available = view ? automaticModelChoices(view) : [];
  return (
    <SettingsGroup heading={automaticModelsTitle} headingId="automatic-models">
      {keys && !keys.has(key) ? (
        <div>
          <p>{automaticModelsExplanation}</p>
          <button type="button" onClick={() => store.dismiss(key)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {!view ? (
        <p>{read.error ? "Automatic models could not be loaded." : "Loading…"}</p>
      ) : (
        <fieldset disabled={pending}>
          {(["light", "deep"] as const).map((role) => (
            <div key={role}>
              <h3>{automaticRoleTitles[role]}</h3>
              {role === "light" ? <p>General preference</p> : null}
              <ol>
                {automaticRoleEntries(view, role).map((entry, index, entries) => (
                  <li key={index}>
                    {entry.label}
                    <button
                      type="button"
                      aria-label={`Move ${role} ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() =>
                        save(() =>
                          editAutomaticRole(view, role, { type: "move", index, offset: -1 }),
                        )
                      }
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${role} ${index + 1} down`}
                      disabled={index === entries.length - 1}
                      onClick={() =>
                        save(() =>
                          editAutomaticRole(view, role, { type: "move", index, offset: 1 }),
                        )
                      }
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${role} ${index + 1}`}
                      onClick={() =>
                        save(() => editAutomaticRole(view, role, { type: "remove", index }))
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
              <select
                aria-label={`Add ${automaticRoleTitles[role]}`}
                value={choices[role]}
                onChange={(e) => setChoices({ ...choices, [role]: e.currentTarget.value })}
              >
                <option value="">Choose model and account</option>
                {available.map((choice, index) => (
                  <option key={index} value={index}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Add ${role} model`}
                disabled={choices[role] === ""}
                onClick={() =>
                  save(() =>
                    editAutomaticRole(view, role, {
                      type: "add",
                      want: available[Number(choices[role])]!.want,
                    }),
                  )
                }
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => save(() => editAutomaticRole(view, role, { type: "reset" }))}
              >
                Reset to default
              </button>
              <p>Current candidates and skipped models</p>
              {automaticPreviewLines(view, role).map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              {view[role].candidates.length === 0 ? <p>No usable model right now.</p> : null}
            </div>
          ))}
          <h3>Accounts</h3>
          {view.accounts.map((account) => (
            <label key={account.harnessInstanceId}>
              <input
                type="checkbox"
                checked={!view.config.excludedAccounts.includes(account.harnessInstanceId)}
                onChange={(e) => {
                  const enabled = e.currentTarget.checked;
                  save(() => {
                    const config = parseAutomaticModelConfig(view.config);
                    config.excludedAccounts = enabled
                      ? config.excludedAccounts.filter((id) => id !== account.harnessInstanceId)
                      : [...config.excludedAccounts, account.harnessInstanceId];
                    return config;
                  });
                }}
              />
              {account.accountDisplayName} · {account.computerDisplayName}
            </label>
          ))}
          <details>
            <summary>Advanced</summary>
            <textarea
              aria-label="Automatic models JSON"
              value={json ?? JSON.stringify(view.config, null, 2)}
              onChange={(e) => setJson(e.currentTarget.value)}
            />
            <button
              type="button"
              onClick={() =>
                save(() =>
                  parseAutomaticModelConfig(JSON.parse(json ?? JSON.stringify(view.config))),
                )
              }
            >
              Save JSON
            </button>
          </details>
        </fieldset>
      )}
      <SettingsError message={failure} />
    </SettingsGroup>
  );
}
