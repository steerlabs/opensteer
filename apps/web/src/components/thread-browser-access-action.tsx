import { useState } from "react";
import type { Request } from "@opensteer/core";
import {
  browserAccessAvailableLabel,
  browserAccessGrantable,
  browserAccessGrantLabel,
  browserAccessInitialName,
  browserAccessInitialSelection,
  browserAccessResponse,
  browserAccessWarning,
  browserProfileSavePrompt,
  mutationIdempotencyKey,
  type BrowserAccessSelection,
  type BrowserProfileSummary,
  type HostClient,
} from "@opensteer/client/host";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";

/**
 * Approval card for a durable browser access request. The agent's suggestion is
 * advisory: the profile inventory comes from the Host snapshot, never from
 * agent-authored content, and the owner can always choose another profile.
 * A `browser.profile.save` Request asks instead for a fresh session's signed-in
 * state to become a new profile; the owner confirms the name.
 */

export type BrowserAccessView =
  | {
      readonly kind: "pending";
      readonly profiles: readonly BrowserProfileSummary[];
      readonly grantedProfileIds: readonly string[];
      readonly workspaceName: string;
    }
  | {
      readonly kind: "save";
      readonly reason: string;
      readonly workspaceName: string;
    };

/** No selection resolves the request as declined; a selection grants full control. */
export async function resolveBrowserAccess(
  hostClient: Pick<HostClient, "dispatch">,
  input: {
    readonly name: string;
    readonly requestId: string;
    readonly selection: BrowserAccessSelection | null;
  },
): Promise<void> {
  await hostClient.dispatch({
    idempotencyKey: mutationIdempotencyKey(`request:${input.requestId}`),
    requestId: input.requestId,
    response: browserAccessResponse(input.selection, input.name),
    type: "request.respond",
  });
}

export function ThreadBrowserRequestAction({
  request,
  disabled = false,
}: {
  readonly request: Request;
  readonly disabled?: boolean;
}) {
  const { hostClient, snapshot } = useShell();
  const [chosen, setChosen] = useState<BrowserAccessSelection | null>(null);
  const [renamed, setRenamed] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestion = request.payload.kind === "browser.access" ? request.payload.suggestion : null;
  const selection =
    chosen ??
    (request.payload.kind === "browser.profile.save"
      ? { kind: "save" as const }
      : suggestion
        ? browserAccessInitialSelection(suggestion, snapshot.browserProfiles)
        : null);
  const name =
    renamed ??
    (request.payload.kind === "browser.profile.save"
      ? (request.payload.suggestedName ?? "")
      : suggestion
        ? browserAccessInitialName(suggestion)
        : "");

  const resolve = async (choice: BrowserAccessSelection | null) => {
    if (pending || disabled) return;
    setPending(true);
    setError(null);
    try {
      await resolveBrowserAccess(hostClient, { name, requestId: request.id, selection: choice });
    } catch (reason) {
      setError(errorMessage(reason));
      setPending(false);
    }
  };

  if (
    request.payload.kind !== "browser.access" &&
    request.payload.kind !== "browser.profile.save"
  ) {
    return <ActionNote alert>This Browser Request is invalid.</ActionNote>;
  }
  const view: BrowserAccessView =
    request.payload.kind === "browser.profile.save"
      ? {
          kind: "save",
          reason: request.payload.reason,
          workspaceName: workspaceName(snapshot.workspaces, request.targetWorkspaceId),
        }
      : {
          kind: "pending",
          profiles: snapshot.browserProfiles,
          grantedProfileIds: snapshot.browserProfileGrants
            .filter((grant) => grant.workspaceId === request.targetWorkspaceId)
            .map((grant) => grant.profileId),
          workspaceName: workspaceName(snapshot.workspaces, request.targetWorkspaceId),
        };

  return (
    <>
      {error ? <ActionNote alert>{error}</ActionNote> : null}
      <BrowserAccessBody
        name={name}
        onChangeName={setRenamed}
        onDecline={() => void resolve(null)}
        onGrant={() => void resolve(selection)}
        onSelect={setChosen}
        pending={pending || disabled}
        selection={selection}
        view={view}
      />
    </>
  );
}

export function BrowserAccessBody({
  name,
  onChangeName,
  onDecline,
  onGrant,
  onSelect,
  pending,
  selection,
  view,
}: {
  readonly name: string;
  readonly onChangeName: (name: string) => void;
  readonly onDecline: () => void;
  readonly onGrant: () => void;
  readonly onSelect: (selection: BrowserAccessSelection) => void;
  readonly pending: boolean;
  readonly selection: BrowserAccessSelection | null;
  readonly view: BrowserAccessView;
}) {
  if (view.kind === "save") {
    return (
      <>
        <ActionNote>{browserProfileSavePrompt(view.workspaceName)}</ActionNote>
        <ActionNote>{view.reason}</ActionNote>
        <label className="action-field">
          <span>Profile name</span>
          <input
            className="text-input browser-profile-name"
            title={name}
            disabled={pending}
            maxLength={120}
            onChange={(event) => onChangeName(event.target.value)}
            placeholder="New browser profile"
            value={name}
          />
        </label>
        <div className="action-buttons">
          <button className="btn" disabled={pending} onClick={onDecline} type="button">
            Not now
          </button>
          <button
            className="btn btn--primary"
            disabled={pending || name.trim().length === 0}
            onClick={onGrant}
            type="button"
          >
            {pending ? "Saving…" : "Save profile"}
          </button>
        </div>
      </>
    );
  }

  const grantable = browserAccessGrantable(selection, name, view.profiles);
  const alreadyGranted =
    selection?.kind === "existing" && view.grantedProfileIds.includes(selection.profileId);

  return (
    <>
      <div className="action-rows">
        {view.profiles.map((profile) => {
          const selected = selection?.kind === "existing" && selection.profileId === profile.id;
          return (
            <label
              className={selected ? "action-row action-row--selected" : "action-row"}
              key={profile.id}
            >
              <input
                disabled={pending}
                checked={selected}
                name="browser-access-profile"
                onChange={() => onSelect({ kind: "existing", profileId: profile.id })}
                type="radio"
              />
              <span className="action-row__text">
                <span className="action-row__label browser-profile-name" title={profile.name}>
                  {profile.name}
                </span>
                {view.grantedProfileIds.includes(profile.id) ? (
                  <span className="action-row__desc">
                    {browserAccessAvailableLabel(view.workspaceName)}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
        <label
          className={selection?.kind === "new" ? "action-row action-row--selected" : "action-row"}
        >
          <input
            disabled={pending}
            checked={selection?.kind === "new"}
            name="browser-access-profile"
            onChange={() => onSelect({ kind: "new" })}
            type="radio"
          />
          <span className="action-row__label">Create a new profile</span>
        </label>
      </div>
      {selection?.kind === "new" ? (
        <label className="action-field">
          <span>Profile name</span>
          <input
            className="text-input browser-profile-name"
            title={name}
            disabled={pending}
            maxLength={120}
            onChange={(event) => onChangeName(event.target.value)}
            placeholder="New browser profile"
            value={name}
          />
        </label>
      ) : null}
      <ActionNote>{browserAccessWarning(view.workspaceName)}</ActionNote>
      <div className="action-buttons">
        <button className="btn" disabled={pending} onClick={onDecline} type="button">
          Not now
        </button>
        <button
          className="btn btn--primary"
          disabled={pending || !grantable}
          onClick={onGrant}
          type="button"
        >
          {pending ? "Continuing…" : browserAccessGrantLabel(alreadyGranted)}
        </button>
      </div>
    </>
  );
}

function workspaceName(
  workspaces: readonly { readonly id: string; readonly name: string }[],
  workspaceId: string,
): string {
  return workspaces.find(({ id }) => id === workspaceId)?.name ?? "this Workspace";
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The Browser Request could not be resolved.";
}
