import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import {
  browserProfileAccessSummary,
  browserProfileDeleteConsequence,
  browserProfileSettingsRows,
  browserProfileSpecialists,
  mutationIdempotencyKey,
  type BrowserProfileSettingsRow,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { Icon } from "../../icon.js";
import { Popover } from "../../popover.js";
import { ProfileAvatar } from "../../workspace/identity.js";
import { lastBrowsingChoice, rememberBrowsingChoice } from "../../workspace/start-page.js";
import { SectionHeader } from "../primitives.js";

/**
 * Settings → Browser profiles. Each profile is its own browser with its own
 * sign-ins; Opensteer may browse as any of them, a specialist only as the ones
 * chosen for it here.
 */
export function BrowserProfilesSection() {
  const { snapshot } = useShell();
  const rows = browserProfileSettingsRows(snapshot);
  // "Add profile…" elsewhere lands here with the name field open.
  const [params] = useSearchParams();
  const [creating, setCreating] = useState(() => params.has("new"));
  return (
    <>
      <SectionHeader
        lead="Each profile is a separate browser with its own sign-ins and site data. Agents browse as one of them."
        title="Browser profiles"
      />
      <section aria-labelledby="browser-profiles-title" className="settings-group">
        <h2 className="settings-group__title" id="browser-profiles-title">
          Your profiles
        </h2>
        <div className="card">
          {rows.length === 0 ? (
            <div className="card__form">
              <p className="browser-profile-settings__empty">
                No profiles yet. Create one, or sign in to sites in a Guest browser and save its
                sign-ins as a profile.
              </p>
            </div>
          ) : (
            rows.map((row) => <BrowserProfileRow key={row.profile.id} row={row} />)
          )}
          <div className="card__form">
            {creating ? (
              <NewProfileForm onDone={() => setCreating(false)} />
            ) : (
              <button
                className="btn btn--small browser-profile-settings__new"
                onClick={() => setCreating(true)}
                type="button"
              >
                <Icon name="plus" />
                New profile
              </button>
            )}
          </div>
        </div>
        <p className="settings-footnote">
          Opensteer can use every profile. A specialist can only use the profiles you choose for it.
        </p>
      </section>
    </>
  );
}

function NewProfileForm({ onDone }: { readonly onDone: () => void }) {
  const { hostClient } = useShell();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    void hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey("browser-profile"),
        input: { name: trimmed },
        type: "browser.profile.create",
      })
      .then(onDone)
      .catch((reason: unknown) => {
        setError(actionErrorMessage(reason));
        setPending(false);
      });
  };
  return (
    <>
      <form className="settings-item__rename" onSubmit={create}>
        <input
          aria-label="New profile name"
          className="text-input"
          disabled={pending}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onDone();
            }
          }}
          placeholder="Work, Personal, Shopping…"
          ref={inputRef}
          value={name}
        />
        <button className="btn btn--small" onClick={onDone} type="button">
          Cancel
        </button>
        <button
          className="btn btn--small btn--primary"
          disabled={pending || !name.trim()}
          type="submit"
        >
          {pending ? "Creating…" : "Create profile"}
        </button>
      </form>
      {error ? (
        <p className="settings-item__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/* ---- One profile ---- */

function BrowserProfileRow({ row }: { readonly row: BrowserProfileSettingsRow }) {
  const { hostClient, snapshot } = useShell();
  const { profile } = row;
  // An older Host can list, create and share profiles but not rename or delete them.
  const manageable = snapshot.browserProfileManageAvailable === true;
  const [mode, setMode] = useState<"view" | "rename" | "specialists" | "delete">("view");
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(profile.name);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode === "rename") inputRef.current?.select();
    if (mode === "delete") confirmRef.current?.focus();
  }, [mode]);

  const close = () => {
    setMode("view");
    setError(null);
    window.requestAnimationFrame(() => menuRef.current?.focus());
  };
  const run = (key: string, action: () => Promise<unknown>, then?: () => void) => {
    setPending(key);
    setError(null);
    void action()
      .then(then)
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(null));
  };
  const choose = (next: typeof mode) => {
    setMenuOpen(false);
    setError(null);
    setDraft(profile.name);
    setMode(next);
  };

  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name || pending) return;
    if (name === profile.name) {
      close();
      return;
    }
    run(
      "rename",
      () =>
        hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`browser-profile-rename:${profile.id}`),
          name,
          profileId: profile.id,
          type: "browser.profile.rename",
        }),
      close,
    );
  };

  const remove = () =>
    run("delete", async () => {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`browser-profile-delete:${profile.id}`),
        profileId: profile.id,
        type: "browser.profile.delete",
      });
      // New tabs and links here stop defaulting to a profile that is gone.
      const scope = { deploymentId: snapshot.deploymentId, userId: snapshot.user?.id ?? null };
      const last = lastBrowsingChoice(scope);
      if (last?.kind === "profile" && last.profileId === profile.id)
        rememberBrowsingChoice(scope, { kind: "guest" });
    });

  return (
    <div className="settings-item">
      <div className="card__row">
        <span className="card__row-glyph browser-profile-settings__avatar">
          <ProfileAvatar identity={row.identity} size={26} />
        </span>
        {mode === "rename" ? (
          <form className="settings-item__rename" onSubmit={rename}>
            <input
              aria-label={`New name for ${profile.name}`}
              className="text-input"
              disabled={pending !== null}
              maxLength={120}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                }
              }}
              ref={inputRef}
              value={draft}
            />
            <button className="btn btn--small" onClick={close} type="button">
              Cancel
            </button>
            <button
              className="btn btn--small btn--primary"
              disabled={pending !== null || !draft.trim()}
              type="submit"
            >
              {pending === "rename" ? "Saving…" : "Save"}
            </button>
          </form>
        ) : (
          <>
            <span className="card__row-body">
              <span className="card__row-title">{profile.name}</span>
              <span className="card__row-detail">{browserProfileAccessSummary(row)}</span>
            </span>
            <span className="card__row-actions">
              <button
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label={`Manage ${profile.name}`}
                className="icon-btn icon-btn--small"
                onClick={() => setMenuOpen((open) => !open)}
                ref={menuRef}
                title="Manage"
                type="button"
              >
                <Icon name="more" />
              </button>
            </span>
          </>
        )}
      </div>
      {menuOpen && menuRef.current ? (
        <Popover
          anchor={menuRef.current}
          label={`Manage ${profile.name}`}
          onClose={() => setMenuOpen(false)}
          returnFocusTo={menuRef.current}
        >
          <div className="picker__section">
            {manageable ? (
              <button
                className="picker__row"
                onClick={() => choose("rename")}
                role="menuitem"
                type="button"
              >
                <span className="picker__check picker__check--icon">
                  <Icon name="pencil" />
                </span>
                <span className="picker__label">Rename</span>
              </button>
            ) : null}
            <button
              className="picker__row"
              onClick={() => choose("specialists")}
              role="menuitem"
              type="button"
            >
              <span className="picker__check picker__check--icon">
                <Icon name="users" />
              </span>
              <span className="picker__label">Choose specialists…</span>
            </button>
          </div>
          {manageable ? (
            <div className="picker__section">
              <button
                className="picker__row picker__row--danger"
                onClick={() => choose("delete")}
                role="menuitem"
                type="button"
              >
                <span className="picker__check picker__check--icon">
                  <Icon name="trash" />
                </span>
                <span className="picker__label">Delete profile</span>
              </button>
            </div>
          ) : null}
        </Popover>
      ) : null}
      {mode === "specialists" ? (
        <SpecialistAccess onDone={close} pending={pending} row={row} run={run} />
      ) : null}
      {mode === "delete" ? (
        <div aria-label={`Delete ${profile.name}`} className="settings-item__confirm" role="group">
          <p>{browserProfileDeleteConsequence(row)}</p>
          <div className="settings-item__confirm-actions">
            <button className="btn btn--small" onClick={close} type="button">
              Cancel
            </button>
            <button
              className="btn btn--small btn--danger"
              disabled={pending !== null}
              onClick={remove}
              ref={confirmRef}
              type="button"
            >
              {pending === "delete" ? "Deleting…" : "Delete profile"}
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="settings-item__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Each specialist, on or off for this profile. Opensteer itself needs no choice. */
function SpecialistAccess({
  onDone,
  pending,
  row,
  run,
}: {
  readonly onDone: () => void;
  readonly pending: string | null;
  readonly row: BrowserProfileSettingsRow;
  readonly run: (key: string, action: () => Promise<unknown>) => void;
}) {
  const { hostClient, snapshot } = useShell();
  const specialists = browserProfileSpecialists(snapshot);
  return (
    <div
      aria-label={`Specialists that can use ${row.profile.name}`}
      className="browser-profile-settings__specialists"
      role="group"
    >
      {specialists.length === 0 ? (
        <p className="browser-profile-settings__none">
          You have no specialists yet. Opensteer can already use this profile.
        </p>
      ) : (
        <ul>
          {specialists.map((workspace) => {
            const grant = row.specialists.find((entry) => entry.workspace.id === workspace.id);
            const key = `access:${workspace.id}`;
            return (
              <li key={workspace.id}>
                <span className="browser-profile-settings__specialist">{workspace.name}</span>
                <button
                  aria-checked={grant !== undefined}
                  aria-label={`${workspace.name} can use ${row.profile.name}`}
                  className="btn btn--small"
                  disabled={pending !== null}
                  onClick={() =>
                    run(key, () =>
                      grant
                        ? hostClient.dispatch({
                            grantId: grant.grantId,
                            idempotencyKey: mutationIdempotencyKey(
                              `browser-grant:${grant.grantId}`,
                            ),
                            type: "browser.profileGrant.revoke",
                          })
                        : hostClient.dispatch({
                            idempotencyKey: mutationIdempotencyKey(`browser-grant:${workspace.id}`),
                            profileId: row.profile.id,
                            type: "browser.profile.grant",
                            workspaceId: workspace.id,
                          }),
                    )
                  }
                  role="switch"
                  type="button"
                >
                  {pending === key ? "Updating…" : grant ? "Allowed" : "Off"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="browser-profile-settings__note">
        A specialist you allow gets full control of this profile, including every account signed in
        to it.
      </p>
      <button className="btn btn--small" onClick={onDone} type="button">
        Done
      </button>
    </div>
  );
}
