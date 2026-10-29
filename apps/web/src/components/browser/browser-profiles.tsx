import { useState, type FormEvent } from "react";
import type { BrowserProfileGrantSummary, BrowserProfileSummary } from "@opensteer/client/host";
import { Dialog } from "../dialog.js";

export type BrowserActionRunner = (action: () => Promise<void>) => Promise<boolean>;

export async function runBrowserAction(
  action: () => Promise<void>,
  showError: (message: string) => void,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    showError(error instanceof Error ? error.message : "Opensteer couldn’t complete that action.");
    return false;
  }
}

export function BrowserActionAlert({ message }: { message: string | null }) {
  return message ? (
    <div className="browser-action-error" role="alert">
      {message}
    </div>
  ) : null;
}

/**
 * Profiles and what agents may do with them, as one list: a profile and its
 * agent access are the same decision, so they share a row.
 */
export function BrowserProfilesDialog({
  actionError,
  canCreate,
  onClose,
  onCreate,
  onGrant,
  onRevoke,
  performAction,
  profileGrants,
  profiles,
  workspaceKind,
  workspaceName,
}: {
  actionError: string | null;
  canCreate: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onGrant: (input: { profileId: string }) => Promise<void>;
  onRevoke: (grantId: string) => Promise<void>;
  performAction: BrowserActionRunner;
  profileGrants: readonly BrowserProfileGrantSummary[];
  profiles: readonly BrowserProfileSummary[];
  workspaceKind: "main" | "specialized";
  workspaceName?: string | undefined;
}) {
  return (
    <Dialog labelledBy="browser-profiles-title" onClose={onClose} title="Browser profiles">
      <p className="browser-profiles__intro">
        A profile keeps its own sign-ins and cookies, like a separate person using the browser.
      </p>
      <BrowserProfileAccessList
        onGrant={onGrant}
        onRevoke={onRevoke}
        performAction={performAction}
        profileGrants={profileGrants}
        profiles={profiles}
        workspaceKind={workspaceKind}
        workspaceName={workspaceName}
      />
      {canCreate ? (
        <BrowserProfileCreator onCreate={onCreate} performAction={performAction} />
      ) : null}
      <BrowserActionAlert message={actionError} />
    </Dialog>
  );
}

export function BrowserProfileAccessList({
  onGrant,
  onRevoke,
  performAction,
  profileGrants,
  profiles,
  workspaceKind,
  workspaceName,
}: {
  onGrant: (input: { profileId: string }) => Promise<void>;
  onRevoke: (grantId: string) => Promise<void>;
  performAction: BrowserActionRunner;
  profileGrants: readonly BrowserProfileGrantSummary[];
  profiles: readonly BrowserProfileSummary[];
  workspaceKind: "main" | "specialized";
  workspaceName?: string | undefined;
}) {
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  if (profiles.length === 0) {
    return (
      <p className="browser-profiles__empty">
        No profiles yet. Create one below, or open a signed-out browser, sign in to the sites you
        need, and save its sign-ins.
      </p>
    );
  }
  const place = workspaceName ?? "this Workspace";
  const update = (profileId: string, action: () => Promise<void>) => {
    setPendingProfileId(profileId);
    void performAction(action).then(() => setPendingProfileId(null));
  };

  return (
    <section aria-label="Profiles and agent access" className="browser-profiles">
      <ul className="browser-profiles__list">
        {profiles.map((profile) => {
          const grant = profileGrants.find((candidate) => candidate.profileId === profile.id);
          const allowed = workspaceKind === "main" || grant !== undefined;
          return (
            <li className="browser-profiles__row" key={profile.id}>
              <span className="browser-profiles__name">{profile.name}</span>
              <span
                className={
                  allowed ? "browser-profiles__access is-allowed" : "browser-profiles__access"
                }
              >
                {allowed ? "Agents have full control" : "Agents can’t use it"}
              </span>
              {workspaceKind === "specialized" ? (
                <button
                  className="btn btn--small"
                  disabled={pendingProfileId !== null}
                  onClick={() =>
                    update(profile.id, () =>
                      grant ? onRevoke(grant.id) : onGrant({ profileId: profile.id }),
                    )
                  }
                  type="button"
                >
                  {pendingProfileId === profile.id
                    ? "Updating…"
                    : grant
                      ? "Revoke"
                      : "Allow agents"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="browser-profiles__note">
        {workspaceKind === "main"
          ? "Opensteer and your tasks can use every profile. Specialists only get the profiles you allow them."
          : `Allowing a profile gives agents in ${place} full control of it, including every signed-in account, cookie, tab, and site it can reach. Revoke it to stop new agent control.`}
      </p>
    </section>
  );
}

function BrowserProfileCreator({
  onCreate,
  performAction,
}: {
  onCreate: (name: string) => Promise<void>;
  performAction: BrowserActionRunner;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || pending) return;
    setPending(true);
    void performAction(() => onCreate(nextName)).then((succeeded) => {
      if (succeeded) setName("");
      setPending(false);
    });
  }

  return (
    <form className="browser-name-form" onSubmit={submit}>
      <label htmlFor="new-browser-profile">New profile</label>
      <div>
        <input
          id="new-browser-profile"
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Work"
          value={name}
        />
        <button className="btn btn--small" disabled={!name.trim() || pending} type="submit">
          {pending ? "Creating…" : "Create profile"}
        </button>
      </div>
    </form>
  );
}

/**
 * Promotes a signed-out session's current state into a new profile. Offered
 * only for signed-out sessions — a profile-backed session already persists
 * into its own profile and cannot be forked.
 */
export function SaveBrowserProfileDialog({
  actionError,
  onClose,
  onSave,
  onSaved,
  performAction,
}: {
  actionError: string | null;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
  onSaved: (name: string) => void;
  performAction: BrowserActionRunner;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || pending) return;
    setPending(true);
    void performAction(() => onSave(nextName)).then((succeeded) => {
      setPending(false);
      if (succeeded) onSaved(nextName);
    });
  }

  return (
    <Dialog
      labelledBy="browser-save-profile-title"
      onClose={onClose}
      title="Save sign-ins as a profile"
    >
      <form className="browser-name-form" onSubmit={submit}>
        <p>
          Keeps this browser’s sign-ins and cookies as a profile you can open again. This browser
          stays Guest, so what you do here after saving isn’t added to the profile.
        </p>
        <label htmlFor="save-browser-profile">Profile name</label>
        <div>
          <input
            data-autofocus
            id="save-browser-profile"
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Work"
            value={name}
          />
          <button
            className="btn btn--primary btn--small"
            disabled={!name.trim() || pending}
            type="submit"
          >
            {pending ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>
      <BrowserActionAlert message={actionError} />
    </Dialog>
  );
}
