import { useMemo, useState } from "react";
import {
  accessModeOptions,
  projectSettingsInput,
  runtimeStateText,
  teamErrorIsStale,
  type ProjectAccessView,
  type ProjectSettingsRead,
} from "@opensteer/client/host";
import { useHostRead } from "@opensteer/client/react";
import type { ThreadAccessMode } from "@opensteer/core";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { TeamError, TeamSection, useShellTeam } from "./team-ui.js";

const zones = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
})();

/**
 * The engine, model, access mode, instructions and time zone a shared Project
 * runs with on the team's computer. Shown only to people the Host lets manage it.
 */
export function ProjectRuntimeSection({
  access,
  teamName,
}: {
  readonly access: ProjectAccessView;
  readonly teamName: string;
}) {
  const { team, generation } = useShellTeam();
  const manage = access.can.manage.allowed;
  const workspaceId = access.project.id;
  const read = useHostRead(
    team && manage ? () => team.projectSettings(workspaceId) : null,
    `team-settings:${workspaceId}:${generation}`,
  );
  if (!team || !manage) return null;
  return (
    <TeamSection
      hint={`Every task in ${access.project.name} runs on ${teamName}’s computer with these. Changing them doesn’t change anyone’s own Opensteer.`}
      id="team-project-runtime"
      title="How it runs"
    >
      {read.data ? (
        <RuntimeForm
          access={access}
          initial={read.data}
          key={`${read.data.settings?.revision ?? 0}`}
          onSaved={read.reload}
          teamName={teamName}
        />
      ) : (
        <div className="card">
          {read.error ? (
            <div className="card__empty">
              <TeamError error={read.error} onRetry={read.reload} team={teamName} />
            </div>
          ) : (
            <LoadingRows label="Loading settings" rows={3} />
          )}
        </div>
      )}
    </TeamSection>
  );
}

function RuntimeForm({
  access,
  initial,
  onSaved,
  teamName,
}: {
  readonly access: ProjectAccessView;
  readonly initial: ProjectSettingsRead;
  readonly onSaved: () => void;
  readonly teamName: string;
}) {
  const { team } = useShellTeam();
  const workspaceId = access.project.id;
  const choices = useHostRead(
    team ? () => team.runtimeChoices(workspaceId) : null,
    `team-runtime-choices:${workspaceId}`,
  );
  const settings = initial.settings;
  const [instanceId, setInstanceId] = useState<string>(settings?.harnessInstanceId ?? "");
  const [modelKey, setModelKey] = useState<string>(
    settings ? `${settings.modelSelection.providerId}/${settings.modelSelection.modelId}` : "",
  );
  const [accessMode, setAccessMode] = useState<ThreadAccessMode>(
    settings?.accessMode ?? "approval-required",
  );
  const [instructions, setInstructions] = useState(settings?.instructions ?? "");
  const [timeZone, setTimeZone] = useState(
    settings?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const instances = choices.data?.instances ?? [];
  const instance = instances.find(({ id }) => id === instanceId) ?? null;
  const models = instance?.models ?? [];
  const model = models.find((m) => `${m.providerId}/${m.modelId}` === modelKey) ?? null;
  const unchanged = useMemo(
    () =>
      settings !== null &&
      settings.harnessInstanceId === instanceId &&
      `${settings.modelSelection.providerId}/${settings.modelSelection.modelId}` === modelKey &&
      settings.accessMode === accessMode &&
      settings.instructions === instructions &&
      settings.timeZone === timeZone,
    [accessMode, instanceId, instructions, modelKey, settings, timeZone],
  );
  const runtime = runtimeStateText(initial.runtime);
  const canEdit = initial.can.edit.allowed;
  const save = () => {
    if (!team || !instance || !model) return;
    setPending(true);
    setError(null);
    setSaved(false);
    void team
      .setProjectSettings(
        access.accessRevision,
        workspaceId,
        settings?.revision ?? null,
        projectSettingsInput({
          saved: settings,
          instance,
          model,
          accessMode,
          instructions,
          timeZone,
        }),
      )
      .then(() => {
        setSaved(true);
        onSaved();
      })
      .catch(setError)
      .finally(() => setPending(false));
  };
  return (
    <>
      {settings === null ? (
        <div className="notice notice--warn team-banner" role="status">
          <Icon name="alert-circle" />
          <div>
            <strong>Not set up yet.</strong>
            <p>Choose an engine and model before {access.project.name} can run tasks.</p>
          </div>
        </div>
      ) : runtime ? (
        <div className="notice notice--warn team-banner" role="status">
          <Icon name="alert-circle" />
          <div>
            <strong>{access.project.name} can’t run tasks right now.</strong>
            <p>{runtime}</p>
          </div>
        </div>
      ) : null}
      <form
        className="card card__form team-runtime"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="team-runtime__pair">
          <label className="field">
            <span className="field__label">Engine</span>
            <select
              className="select-input"
              disabled={!canEdit || choices.data === null}
              onChange={(event) => {
                const next = instances.find(({ id }) => id === event.currentTarget.value);
                setInstanceId(event.currentTarget.value);
                setModelKey(
                  next?.models[0] ? `${next.models[0].providerId}/${next.models[0].modelId}` : "",
                );
              }}
              value={instanceId}
            >
              {instance ? null : (
                <option value="">{choices.data ? "Choose an engine" : "Loading…"}</option>
              )}
              {instances.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Model</span>
            <select
              className="select-input"
              disabled={!canEdit || !instance}
              onChange={(event) => setModelKey(event.currentTarget.value)}
              value={model ? modelKey : ""}
            >
              {model ? null : (
                <option value="">
                  {settings &&
                  modelKey ===
                    `${settings.modelSelection.providerId}/${settings.modelSelection.modelId}`
                    ? `${settings.modelSelection.modelId} (not available)`
                    : "Choose a model"}
                </option>
              )}
              {models.map((option) => (
                <option
                  key={`${option.providerId}/${option.modelId}`}
                  value={`${option.providerId}/${option.modelId}`}
                >
                  {option.modelId}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="field__label">What agents may do without asking</span>
          <select
            className="select-input"
            disabled={!canEdit}
            onChange={(event) => setAccessMode(event.currentTarget.value as ThreadAccessMode)}
            value={accessMode}
          >
            {accessModeOptions.map((option) => (
              <option key={option.mode} value={option.mode}>
                {option.label}: {option.description}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Instructions</span>
          <textarea
            className="text-input team-runtime__instructions"
            disabled={!canEdit}
            onChange={(event) => setInstructions(event.currentTarget.value)}
            placeholder={`What should ${access.project.name}’s agent always know?`}
            rows={5}
            value={instructions}
          />
          <span className="field__hint">
            Everyone who can use {access.project.name} works with these.
          </span>
        </label>
        <label className="field">
          <span className="field__label">Time zone</span>
          <select
            className="select-input"
            disabled={!canEdit}
            onChange={(event) => setTimeZone(event.currentTarget.value)}
            value={timeZone}
          >
            {(zones.includes(timeZone) ? zones : [timeZone, ...zones]).map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <TeamError
          error={error}
          onRetry={teamErrorIsStale(error) ? onSaved : undefined}
          team={teamName}
        />
        {canEdit ? (
          <div className="form-actions">
            {saved && unchanged ? (
              <span className="team-runtime__saved" role="status">
                <Icon name="check" /> Saved
              </span>
            ) : null}
            <button
              className="btn btn--primary"
              disabled={pending || !model || unchanged}
              type="submit"
            >
              {pending ? "Saving…" : settings ? "Save changes" : "Set up"}
            </button>
          </div>
        ) : null}
      </form>
    </>
  );
}
