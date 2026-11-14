import { normalizePersonName } from "@opensteer/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTeams } from "../../../team/team-attachments.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { SettingsError, SettingsRow } from "../primitives.js";

/**
 * The person's own name, first on the Account page: what their agent calls them and, once they
 * are signed in, what teammates see. Hosts before names were editable show no row.
 */
export function OwnerNameRow() {
  const { hostClient, snapshot } = useShell();
  const { profiles } = useTeams();
  const profile = snapshot.ownerProfile;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  if (!profile) return null;

  const name = normalizePersonName(draft);
  // A signed-in name is required; a local one may be cleared back to "You".
  const valid = name !== null || (draft.trim() === "" && !profile.accountBacked);
  const open = () => {
    setDraft(profile.name ?? "");
    setMessage(null);
    setEditing(true);
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || pending) return;
    if (name === profile.name) {
      setEditing(false);
      return;
    }
    setPending(true);
    setMessage(null);
    void hostClient
      .setOwnerName(name)
      .then(({ applied }) => {
        // Teams hold a copy only of an Account's name; this device's sessions relay the new one.
        profiles?.changed();
        if (applied) setEditing(false);
        else
          setMessage(
            "Your name was changed on another device just now. Check it, then save yours again.",
          );
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
              {profile.name ? "Change" : "Add your name"}
            </button>
          }
          detail={
            profile.accountBacked
              ? "Teammates see this name, and your agent calls you by it."
              : "Your agent calls you by this name. It stays on this computer until you sign in."
          }
          title={profile.name ?? "You"}
        />
      )}
      <SettingsError message={message} />
    </>
  );
}
