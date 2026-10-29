import { machineAccessSharePathMaxBytes, type MachineSummary } from "@opensteer/protocol";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { formatBytes } from "../../app-model.js";
import type { HostClient } from "@opensteer/client/host";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon, type IconName } from "../icon.js";
import {
  initialMachineAccessEditorState,
  machineAccessConflictMessage,
  machineAccessDraftIssues,
  machineAccessEditorDirty,
  machineAccessElapsedLabel,
  machineAccessPolicyToSave,
  machineAccessReloadHint,
  machineAccessSaveLabel,
  machineAccessSessionBytes,
  machineAccessSessionLabel,
  machineAccessSummary,
  machineReachOptions,
  reduceMachineAccessEditor,
} from "./machine-access-editor.js";
import { MachineAccessHistory } from "./machine-access-history.js";

const foldersCopy =
  "Agents can read, and if you allow it write, only the folders listed here. Nothing else on disk unless commands are allowed.";
/** The R9 wording: the switch grants the whole account, and says so. */
const commandsCopy =
  "Lets agents run anything your account can run here — the same access you have in a terminal, including signed-in tools and every file, not just shared folders.";
/**
 * The two honesty lines that travel with commands. Opensteer records requests
 * and cannot police them; and seccomp cannot select a socket by path, so a
 * cloud Runner's agent sandbox is opened to all local Unix sockets rather than
 * to the relay alone. Both are stated wherever commands can be turned on
 * rather than left in the design notes.
 */
const commandsFootnote =
  "Opensteer records each request but can't limit what a command does once it runs. On Linux cloud Runners, an agent's sandbox may connect to any local Unix socket while machine access is set up.";
const forwardingCopy =
  "Lets agents connect to ports this computer can reach — a local database, a dev server, something on your network.";
const forwardingRedundantCopy = "Already possible while commands are allowed.";

const shareLimit = 32;
const liveSessionTickMs = 30_000;

export interface MachineAccessSectionProps {
  readonly access: NonNullable<MachineSummary["access"]>;
  readonly client: HostClient;
  readonly deploymentKind: "personal" | "server" | null;
  readonly deploymentName: string;
  /** The desktop this page runs in, when it runs in one. */
  readonly desktopBridge: OpensteerDesktopBridge | null;
  readonly machineId: string;
  readonly machineName: string;
  /** Bumped by the Host when this computer's sessions change. */
  readonly machineRevision: number;
  readonly ownership: MachineSummary["ownership"];
}

/**
 * Whether agents on other computers may reach this one, what they may do here,
 * and what they are doing now.
 *
 * Deliberately separate from "Runs agents": that switch says work may be placed
 * on this computer, and this one says what a Run somewhere else may reach
 * across. Reading one as the other is how a person ends up sharing a folder
 * they meant to keep.
 *
 * Reach is one switch rather than a list of audiences, because "off" is the
 * answer most computers keep and burying it among two others made it look like
 * one setting among equals. Who may reach it is the second question, and it is
 * asked only where there is more than one answer to give.
 */
export function MachineAccessSection({
  access,
  client,
  deploymentKind,
  deploymentName,
  desktopBridge,
  machineId,
  machineName,
  machineRevision,
  ownership,
}: MachineAccessSectionProps) {
  const [editor, edit] = useReducer(
    reduceMachineAccessEditor,
    access,
    initialMachineAccessEditorState,
  );
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<readonly string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // The freshest props a reload can adopt. A refresh resolves before React has
  // necessarily re-rendered with what it fetched, so the reload reads the
  // latest access here rather than from the render it was clicked in.
  const latestAccess = useRef(access);
  latestAccess.current = access;
  const reloading = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const type = reloading.current ? "reloaded" : "server-observed";
    reloading.current = false;
    edit({ policy: access.policy, revision: access.revision, type });
  }, [access.policy, access.revision]);

  useEffect(() => {
    setStopping([]);
  }, [machineRevision]);

  useEffect(() => {
    if (access.activeSessions.length === 0) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), liveSessionTickMs);
    return () => globalThis.clearInterval(timer);
  }, [access.activeSessions.length]);

  const issues = machineAccessDraftIssues(editor.draft);
  const dirty = machineAccessEditorDirty(editor);
  // "No one" is the switch itself, so only the audiences remain a choice.
  const audiences = machineReachOptions({
    deploymentKind,
    deploymentName,
    ownerReachAvailable: access.ownerReachAvailable,
    ownership,
  }).filter((option) => option.reach !== "nobody");
  // Turning the switch on admits the narrowest audience the Host will accept.
  const admitted = audiences[0]?.reach ?? null;
  const canSave = dirty && issues.length === 0 && !saving;
  const reachable = editor.draft.reach !== "nobody";
  // A folder row that fails validation must stay reachable even after reach is
  // set back to "No one": a disabled Save with its cause hidden is a dead end.
  const grantsShown = reachable || issues.length > 0;
  const liveCount = access.activeSessions.length;

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSave) return;
      const policy = machineAccessPolicyToSave(editor.draft);
      setSaving(true);
      setConflict(false);
      setError(null);
      try {
        const outcome = await client.updateMachineAccess({
          expectedRevision: editor.revision,
          policy,
          runnerId: machineId,
        });
        if (outcome.outcome === "conflict") setConflict(true);
        else edit({ policy, revision: outcome.revision, type: "saved" });
      } catch (reason) {
        setError(actionErrorMessage(reason));
      } finally {
        setSaving(false);
      }
    },
    [canSave, client, editor.draft, editor.revision, machineId],
  );

  /**
   * Reads the settings again and puts the form on them.
   *
   * Refreshing alone is not enough: while the form is dirty — which is exactly
   * what a conflict leaves behind — a live update is ignored on purpose, so
   * without this the next save would name the revision that already lost.
   */
  async function reload() {
    setError(null);
    reloading.current = true;
    try {
      await client.refresh();
    } catch (reason) {
      reloading.current = false;
      setError(actionErrorMessage(reason));
      return;
    }
    reloading.current = false;
    const fresh = latestAccess.current;
    edit({ policy: fresh.policy, revision: fresh.revision, type: "reloaded" });
    setConflict(false);
  }

  /**
   * Puts the form back on the settings as the Host now holds them — not on the
   * copy this editor read first, which a live update may have overtaken while
   * the form was dirty. The button unmounts itself, so focus is parked on the
   * heading rather than dropped on the document.
   */
  function discard() {
    const fresh = latestAccess.current;
    edit({ policy: fresh.policy, revision: fresh.revision, type: "reloaded" });
    heading.current?.focus();
  }

  async function stop(sessionId: string) {
    setStopping((current) => [...current, sessionId]);
    setError(null);
    try {
      await client.stopMachineAccessSession(sessionId);
    } catch (reason) {
      setError(actionErrorMessage(reason));
    } finally {
      // A Stop that failed is a Stop that can be tried again: leaving the id
      // here would keep the button disabled until some unrelated notification
      // cleared it.
      setStopping((current) => current.filter((id) => id !== sessionId));
    }
  }

  /**
   * Fills a row from the desktop's own folder dialog. The input stays
   * editable: the dialog can only name a folder that exists on the computer
   * running the app, and a share may name one on the computer being edited.
   */
  async function chooseFolder(index: number) {
    if (!desktopBridge) return;
    setError(null);
    try {
      const picked = await desktopBridge.pickFolder();
      if (picked) edit({ index, path: picked.path, type: "share-path-edited" });
    } catch (reason) {
      setError(actionErrorMessage(reason));
    }
  }

  const headingId = `machine-access-${machineId}`;
  const whoId = `machine-access-who-${machineId}`;
  const issueNotices = issues.map((issue) => (
    <p className="notice notice--warn" key={issue}>
      {issue}
    </p>
  ));

  return (
    <section aria-labelledby={headingId} className="machine-access">
      {/* The section's title is the switch's label: one "Reachable by agents",
          not a heading and a row underneath repeating it. */}
      <header className="machine-access__header">
        <h3 id={headingId} ref={heading} tabIndex={-1}>
          Reachable by agents
        </h3>
        <span className="machine-access__status">
          <SavedReachChip deploymentName={deploymentName} reach={access.policy.reach} />
          {liveCount > 0 ? (
            <span className="chip chip--accent">{liveCount} connected now</span>
          ) : null}
          <input
            aria-label={`Reachable by agents on ${machineName}`}
            checked={reachable}
            className="switch"
            // Nothing is accepted while a save is in flight: the answer would
            // overwrite it. Nothing is offered where no audience exists.
            disabled={saving || admitted === null}
            onChange={(event) =>
              edit({
                reach: event.target.checked ? (admitted ?? "nobody") : "nobody",
                type: "reach-edited",
              })
            }
            role="switch"
            type="checkbox"
          />
        </span>
      </header>
      <p className="machine-access__lead">
        Lets agents running on your other computers, or in the cloud, use {machineName} over SSH:
        open the folders you share, and optionally run commands or reach local services.
      </p>
      {!reachable && draftGrantsAnything(editor.draft) ? (
        <p className="machine-access__lead machine-access__lead--note">
          Everything below is kept but has no effect.
        </p>
      ) : null}

      <form className="machine-access__form" onSubmit={(event) => void save(event)}>
        {/* Disabled as one while a save is in flight: an edit made then would be
            overwritten by the answer, so it is not accepted in the first place. */}
        <fieldset className="machine-access__fields" disabled={saving}>
          {reachable && audiences.length > 1 ? (
            <div className="machine-access__group">
              <div className="machine-access__who">
                <label className="machine-access__who-label" htmlFor={whoId}>
                  Who
                </label>
                <select
                  className="select-input machine-access__who-select"
                  id={whoId}
                  onChange={(event) =>
                    edit({
                      reach: event.target.value === "owner" ? "owner" : "deployment",
                      type: "reach-edited",
                    })
                  }
                  value={editor.draft.reach}
                >
                  {audiences.map((option) => (
                    <option key={option.reach} value={option.reach}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {grantsShown ? (
            <div className="machine-access__grants">
              <p className="eyebrow machine-access__grants-label">What they can do</p>

              <GrantRow detail={foldersCopy} glyph="folder" title="Open these folders">
                {editor.draft.shares.length === 0 ? (
                  <div className="machine-access__shares-empty">
                    <span>No folders yet.</span>
                    <button
                      className="btn btn--small"
                      onClick={() => edit({ type: "share-added" })}
                      type="button"
                    >
                      Add folder
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="machine-access__shares">
                      {editor.draft.shares.map((share, index) => (
                        <div className="machine-access__share" key={index}>
                          <input
                            aria-label={`Folder ${index + 1} path for ${machineName}`}
                            className="text-input machine-access__share-path"
                            maxLength={machineAccessSharePathMaxBytes}
                            onChange={(event) =>
                              edit({ index, path: event.target.value, type: "share-path-edited" })
                            }
                            placeholder="/Users/person/Projects"
                            value={share.path}
                          />
                          <select
                            aria-label={`Folder ${index + 1} access for ${machineName}`}
                            className="select-input machine-access__share-mode"
                            onChange={(event) =>
                              edit({
                                index,
                                mode: event.target.value === "read-write" ? "read-write" : "read",
                                type: "share-mode-edited",
                              })
                            }
                            value={share.mode}
                          >
                            <option value="read">Read only</option>
                            <option value="read-write">Read &amp; write</option>
                          </select>
                          {desktopBridge ? (
                            <button
                              className="btn btn--small"
                              onClick={() => void chooseFolder(index)}
                              type="button"
                            >
                              Choose folder…
                            </button>
                          ) : null}
                          <button
                            className="btn btn--ghost btn--small"
                            onClick={() => edit({ index, type: "share-removed" })}
                            type="button"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="machine-access__shares-actions">
                      <button
                        className="btn btn--small"
                        disabled={editor.draft.shares.length >= shareLimit}
                        onClick={() => edit({ type: "share-added" })}
                        type="button"
                      >
                        Add folder
                      </button>
                    </div>
                  </>
                )}
                {issueNotices}
              </GrantRow>

              <GrantRow
                chip={
                  editor.draft.commands ? (
                    <span className="chip chip--warn">Full account access</span>
                  ) : null
                }
                control={
                  <input
                    aria-label={`Commands on ${machineName}`}
                    checked={editor.draft.commands}
                    className="switch"
                    onChange={(event) =>
                      edit({ commands: event.target.checked, type: "commands-edited" })
                    }
                    role="switch"
                    type="checkbox"
                  />
                }
                detail={commandsCopy}
                glyph="terminal"
                title="Run commands"
              >
                <p className="machine-access__footnote">{commandsFootnote}</p>
              </GrantRow>

              <GrantRow
                control={
                  <input
                    aria-label={`Port forwarding on ${machineName}`}
                    checked={editor.draft.forwarding}
                    className="switch"
                    onChange={(event) =>
                      edit({ forwarding: event.target.checked, type: "forwarding-edited" })
                    }
                    role="switch"
                    type="checkbox"
                  />
                }
                detail={forwardingCopy}
                glyph="server"
                note={editor.draft.commands ? forwardingRedundantCopy : null}
                title="Reach local services"
              />
            </div>
          ) : null}

          <p className="machine-access__summary">
            <Icon name={reachable ? "check-circle" : "shield"} />
            <span>{machineAccessSummary(editor.draft, { deploymentName, machineName })}</span>
          </p>

          <div className="machine-access__actions">
            <span className="machine-access__actions-note">
              {dirty && liveCount > 0 ? sessionEndWarning(liveCount) : null}
            </span>
            {dirty ? (
              <button className="btn btn--ghost" onClick={discard} type="button">
                Discard changes
              </button>
            ) : null}
            <button className="btn btn--primary" disabled={!canSave} type="submit">
              {saving ? "Saving…" : machineAccessSaveLabel(liveCount)}
            </button>
          </div>
          {conflict ? (
            <div className="notice notice--warn" role="alert">
              <div>
                <span>{machineAccessConflictMessage}</span>
                <span className="field__hint"> {machineAccessReloadHint}</span>
              </div>
              <button className="btn btn--small" onClick={() => void reload()} type="button">
                Reload
              </button>
            </div>
          ) : null}
          {error ? (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      </form>

      <div className="machine-access__activity">
        <p className="eyebrow">Connected now</p>
        {liveCount === 0 ? (
          <p className="machine-access__empty">No agent is connected to {machineName} right now.</p>
        ) : (
          access.activeSessions.map((session) => (
            <div className="machine-access__session" key={session.id}>
              <span aria-hidden className="status-dot status-dot--ok status-dot--pulse" />
              <span className="machine-access__session-body">
                <span className="machine-access__session-title">
                  {machineAccessSessionLabel(session)}
                </span>
                <span className="machine-access__session-detail">
                  {machineAccessElapsedLabel(session.startedAt, now)} ·{" "}
                  {formatBytes(machineAccessSessionBytes(session))}
                </span>
              </span>
              <button
                className="btn btn--small"
                disabled={stopping.includes(session.id)}
                onClick={() => void stop(session.id)}
                type="button"
              >
                {stopping.includes(session.id) ? "Stopping…" : "Stop"}
              </button>
            </div>
          ))
        )}
        <MachineAccessHistory
          client={client}
          machineId={machineId}
          machineRevision={machineRevision}
        />
      </div>
    </section>
  );
}

function GrantRow({
  children,
  chip = null,
  control = null,
  detail,
  glyph,
  note = null,
  title,
}: {
  readonly children?: ReactNode;
  readonly chip?: ReactNode;
  readonly control?: ReactNode;
  readonly detail: string;
  readonly glyph: IconName;
  readonly note?: ReactNode;
  readonly title: string;
}) {
  const heading = (
    <>
      <span className="card__row-glyph">
        <Icon name={glyph} />
      </span>
      <span className="card__row-body">
        <span className="card__row-title">
          {title}
          {chip}
        </span>
        <span className="card__row-detail machine-access__grant-detail">{detail}</span>
        {note ? <span className="machine-access__grant-note">{note}</span> : null}
      </span>
      {control ? <span className="machine-access__grant-control">{control}</span> : null}
    </>
  );
  return (
    <div className="machine-access__grant">
      {control ? (
        <label className="machine-access__grant-head">{heading}</label>
      ) : (
        <div className="machine-access__grant-head">{heading}</div>
      )}
      {children ? <div className="machine-access__grant-body">{children}</div> : null}
    </div>
  );
}

/** The saved answer, not the draft: a chip that changes before Save would lie. */
function SavedReachChip({
  deploymentName,
  reach,
}: {
  readonly deploymentName: string;
  readonly reach: NonNullable<MachineSummary["access"]>["policy"]["reach"];
}) {
  if (reach === "nobody") return <span className="chip">Off</span>;
  return (
    <span className="chip chip--ok">
      {reach === "owner" ? "Only your agents" : `Everyone in ${deploymentName}`}
    </span>
  );
}

function draftGrantsAnything(policy: NonNullable<MachineSummary["access"]>["policy"]): boolean {
  return policy.commands || policy.forwarding || policy.shares.length > 0;
}

function sessionEndWarning(sessions: number): string {
  return sessions === 1
    ? "Saving ends 1 connected session."
    : `Saving ends ${sessions} connected sessions.`;
}
