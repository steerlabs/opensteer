import {
  browserAccessChoices,
  browserAccessGrantable,
  browserAccessGrantLabel,
  browserAccessHomeChoice,
  browserAccessInitialName,
  browserAccessInitialSelection,
  browserAccessProfileNote,
  browserAccessResponse,
  browserAccessWarning,
  mutationIdempotencyKey,
  type BrowserAccessChoices,
  type BrowserAccessSelection,
  type HostClient,
  type ProfileHomeChoice,
} from "@opensteer/client/host";
import type { Request } from "@opensteer/core";
import { useId, useRef, useState } from "react";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import { useHereId } from "./computers/here.js";
import { ProfileHomeControl } from "./profile-home-control.js";

/**
 * Approval card for a durable browser access request. The agent's suggestion is
 * advisory: the profile inventory comes from the Host snapshot, never from
 * agent-authored content, and the owner can always choose another profile.
 */

/** No selection resolves the request as declined; a selection grants full control. */
export async function resolveBrowserAccess(
  hostClient: Pick<HostClient, "dispatch">,
  input: {
    readonly home: string | null;
    readonly name: string;
    readonly requestId: string;
    readonly selection: BrowserAccessSelection | null;
  },
): Promise<void> {
  await hostClient.dispatch({
    idempotencyKey: mutationIdempotencyKey(`request:${input.requestId}`),
    requestId: input.requestId,
    response: browserAccessResponse(input.selection, input.name, input.home),
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
  const hereId = useHereId();
  const [chosen, setChosen] = useState<BrowserAccessSelection | null>(null);
  const [renamed, setRenamed] = useState<string | null>(null);
  const [chosenHome, setHome] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestion = request.payload.kind === "browser.access" ? request.payload.suggestion : null;
  const selection =
    chosen ??
    (suggestion ? browserAccessInitialSelection(suggestion, snapshot.browserProfiles) : null);
  const name = renamed ?? (suggestion ? browserAccessInitialName(suggestion) : "");
  const homes = browserAccessHomeChoice(snapshot, hereId, request);
  // The person's pick stands while it is still on offer; the default follows the list.
  const home = homes
    ? (homes.options.find(({ id }) => id === chosenHome)?.id ?? homes.initial)
    : null;

  const resolve = async (choice: BrowserAccessSelection | null) => {
    if (pending || disabled) return;
    setPending(true);
    setError(null);
    try {
      await resolveBrowserAccess(hostClient, {
        home,
        name,
        requestId: request.id,
        selection: choice,
      });
    } catch (reason) {
      setError(errorMessage(reason));
      setPending(false);
    }
  };

  if (request.payload.kind !== "browser.access") {
    return <ActionNote alert>This Browser Request is invalid.</ActionNote>;
  }
  const choices = browserAccessChoices(snapshot, request.targetWorkspaceId);

  return (
    <>
      {error ? <ActionNote alert>{error}</ActionNote> : null}
      <BrowserAccessBody
        home={home}
        homes={homes}
        name={name}
        onChangeName={setRenamed}
        onDecline={() => void resolve(null)}
        onGrant={() => void resolve(selection)}
        onChooseHome={setHome}
        onSelect={setChosen}
        pending={pending || disabled}
        selection={selection}
        choices={choices}
      />
    </>
  );
}

export function BrowserAccessBody({
  choices,
  home = null,
  homes = null,
  name,
  onChangeName,
  onChooseHome,
  onDecline,
  onGrant,
  onSelect,
  pending,
  selection,
}: {
  readonly choices: BrowserAccessChoices;
  /** Where a new profile will keep its sign-ins; null when there is nothing to choose. */
  readonly home?: string | null;
  readonly homes?: ProfileHomeChoice | null;
  readonly name: string;
  readonly onChangeName: (name: string) => void;
  readonly onChooseHome?: (id: string) => void;
  readonly onDecline: () => void;
  readonly onGrant: () => void;
  readonly onSelect: (selection: BrowserAccessSelection) => void;
  readonly pending: boolean;
  readonly selection: BrowserAccessSelection | null;
}) {
  const groupId = useId();
  const nameId = `${groupId}-name`;
  const nameRef = useRef<HTMLInputElement>(null);
  const grantable = browserAccessGrantable(selection, name, choices.profiles);

  return (
    <>
      <div className="action-rows">
        {choices.profiles.map((profile) => {
          const selected = selection?.kind === "existing" && selection.profileId === profile.id;
          const note = browserAccessProfileNote(choices, profile);
          return (
            <label
              className={selected ? "action-row action-row--selected" : "action-row"}
              key={profile.id}
            >
              <input
                disabled={pending}
                checked={selected}
                name={groupId}
                onChange={() => onSelect({ kind: "existing", profileId: profile.id })}
                type="radio"
              />
              <span className="action-row__text">
                <span className="action-row__label browser-profile-name" title={profile.name}>
                  {profile.name}
                </span>
                {note ? <span className="action-row__desc">{note}</span> : null}
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
            name={groupId}
            onChange={() => onSelect({ kind: "new" })}
            type="radio"
          />
          <span className="action-row__label">New profile</span>
        </label>
      </div>
      {selection?.kind === "new" ? (
        <div className="action-field">
          <label htmlFor={nameId}>Name</label>
          {homes && home && onChooseHome ? (
            <span className="text-input profile-name-field">
              <input
                autoComplete="off"
                className="browser-profile-name"
                disabled={pending}
                id={nameId}
                maxLength={120}
                onChange={(event) => onChangeName(event.target.value)}
                placeholder="Personal, Work, Finance…"
                ref={nameRef}
                title={name}
                value={name}
              />
              <ProfileHomeControl
                disabled={pending}
                home={home}
                homes={homes}
                onChoose={(id) => {
                  onChooseHome(id);
                  nameRef.current?.focus();
                }}
              />
            </span>
          ) : (
            <input
              autoComplete="off"
              className="text-input browser-profile-name"
              disabled={pending}
              id={nameId}
              maxLength={120}
              onChange={(event) => onChangeName(event.target.value)}
              placeholder="Personal, Work, Finance…"
              title={name}
              value={name}
            />
          )}
          {choices.nameSuggestions.length > 0 ? (
            <div aria-label="Suggested names" className="action-field__suggestions" role="group">
              {choices.nameSuggestions.map((suggestion) => (
                <button
                  aria-pressed={name.trim() === suggestion}
                  className={name.trim() === suggestion ? "chip chip--accent" : "chip"}
                  disabled={pending}
                  key={suggestion}
                  onClick={() => onChangeName(suggestion)}
                  type="button"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <ActionNote>{browserAccessWarning(choices)}</ActionNote>
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
          {pending ? "Continuing…" : browserAccessGrantLabel(selection, choices)}
        </button>
      </div>
    </>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The Browser Request could not be resolved.";
}
