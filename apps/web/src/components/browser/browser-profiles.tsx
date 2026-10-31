import { useState, type FormEvent } from "react";
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
