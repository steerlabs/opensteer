import type { AccountProfile } from "@opensteer/control-plane-protocol";
import { normalizePersonName, type PersonName } from "@opensteer/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTeams } from "../../../team/team-attachments.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { SettingsError, SettingsRow } from "../primitives.js";

const conflict =
  "Your name was changed on another device just now. Check it, then save yours again.";

/**
 * The person's own name, first on the Account page: what their agent calls them and, once they
 * are signed in, what teammates see. Hosts before names were editable show no row.
 */
export function OwnerNameRow() {
  const { hostClient, snapshot } = useShell();
  const { profiles } = useTeams();
  const profile = snapshot.ownerProfile;
  if (!profile) return null;
  return (
    <NameEditor
      clearable={!profile.accountBacked}
      detail={
        profile.accountBacked
          ? "Teammates see this name, and your agent calls you by it."
          : "Your agent calls you by this name. It stays on this computer until you sign in."
      }
      name={profile.name}
      revision={profile.revision}
      save={async (name, revision) => {
        const { applied } = await hostClient.setOwnerName(name, revision);
        // Teams hold a copy only of an Account's name; this device's sessions relay the new one.
        profiles?.changed();
        return { applied, revision: hostClient.getSnapshot().ownerProfile?.revision ?? null };
      }}
    />
  );
}

/**
 * The signed-in Account's name, from a team's profile. Saved through this computer's Opensteer
 * when it is linked to the same Account, so its copy (and its agent) follows at once; otherwise
 * straight to the Account, which this device's team sessions relay.
 */
export function AccountNameRow() {
  const { deploymentAccess, hostClient, snapshot } = useShell();
  const { profiles } = useTeams();
  const [account, setAccount] = useState<AccountProfile | null>(null);
  useEffect(() => {
    if (!profiles) return;
    let current = true;
    const read = () => void profiles.current().then((profile) => current && setAccount(profile));
    read();
    const release = profiles.subscribe(read);
    return () => {
      current = false;
      release();
    };
  }, [profiles]);
  if (!profiles || !account) return null;
  const owner = snapshot.ownerProfile;
  const throughHost =
    owner?.accountBacked === true && deploymentAccess?.personalAccountLink?.status === "linked";
  return (
    <NameEditor
      clearable={false}
      detail="Teammates see this name, and your agent calls you by it. Handles stay the same."
      name={account.name}
      revision={account.revision}
      save={async (name, revision) => {
        if (throughHost && name !== null) {
          const { applied } = await hostClient.setOwnerName(name, revision);
          profiles.changed();
          return { applied, revision: hostClient.getSnapshot().ownerProfile?.revision ?? null };
        }
        if (name === null || revision === null) return { applied: false, revision };
        const result = await profiles.update({ name, expectedRevision: revision });
        return { applied: result.applied, revision: result.profile.revision };
      }}
    />
  );
}

/** One name, shown as a row that turns into a field; saved against the version opened. */
function NameEditor(props: {
  readonly name: PersonName | null;
  readonly revision: number | null;
  /** Whether an empty name is allowed (shown as "You"). */
  readonly clearable: boolean;
  readonly detail: string;
  readonly save: (
    name: PersonName | null,
    revision: number | null,
  ) => Promise<{ readonly applied: boolean; readonly revision: number | null }>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // The version the person is editing, so a rename made elsewhere meanwhile is never overwritten.
  const [editedRevision, setEditedRevision] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const name = normalizePersonName(draft);
  const valid = name !== null || (draft.trim() === "" && props.clearable);
  const open = () => {
    setDraft(props.name ?? "");
    setEditedRevision(props.revision);
    setMessage(null);
    setEditing(true);
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || pending) return;
    if (name === props.name) {
      setEditing(false);
      return;
    }
    setPending(true);
    setMessage(null);
    void props
      .save(name, editedRevision)
      .then(({ applied, revision }) => {
        if (applied) setEditing(false);
        else {
          setEditedRevision(revision);
          setMessage(conflict);
        }
      })
      .catch((reason: unknown) => setMessage(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  };

  return (
    <>
      {editing ? (
        <div className="card__row">
          <form className="settings-item__rename" onSubmit={save}>
            <input
              aria-label="Your name"
              autoComplete="name"
              className="text-input"
              disabled={pending}
              maxLength={120}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                }
              }}
              placeholder="Your name"
              ref={inputRef}
              value={draft}
            />
            <button className="btn btn--small" onClick={() => setEditing(false)} type="button">
              Cancel
            </button>
            <button
              className="btn btn--small btn--primary"
              disabled={pending || !valid}
              type="submit"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </form>
        </div>
      ) : (
        <SettingsRow
          action={
            <button className="btn btn--small" onClick={open} type="button">
              {props.name ? "Change" : "Add your name"}
            </button>
          }
          detail={props.detail}
          title={props.name ?? "You"}
        />
      )}
      <SettingsError message={message} />
    </>
  );
}
