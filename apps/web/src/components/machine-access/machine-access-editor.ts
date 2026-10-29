import {
  machineAccessShareIssues,
  type MachineAccessPolicy,
  type MachineAccessReach,
  type MachineAccessShare,
  type MachineSummary,
  type ShellAuditEvent,
  type ShellCloseReason,
  type ShellSessionSummary,
} from "@opensteer/protocol";

/* ------------------------------------------------------------------------- *
 * Who may reach a computer
 * ------------------------------------------------------------------------- */

export interface MachineReachOption {
  readonly detail: string;
  readonly label: string;
  readonly reach: MachineAccessReach;
}

/**
 * The reach choices this computer can actually be set to.
 *
 * "My agents" needs an owner to admit anybody, and ownership does not settle
 * whether there is one: a Personal Deployment's main computer belongs to the
 * Deployment and still has an owner, while a server Deployment's computer may
 * have none. So the Host's `ownerReachAvailable` decides that choice, and
 * ownership only decides whether the whole Deployment is a sensible audience.
 * An unofferable choice is left out rather than shown disabled: a choice the
 * write would refuse is not a choice.
 */
export function machineReachOptions(input: {
  readonly deploymentKind: "personal" | "server" | null;
  readonly deploymentName: string;
  readonly ownerReachAvailable: boolean;
  readonly ownership: MachineSummary["ownership"];
}): readonly MachineReachOption[] {
  const options: MachineReachOption[] = [
    { detail: "Agents on other computers can't reach this one.", label: "No one", reach: "nobody" },
  ];
  if (input.ownerReachAvailable) {
    options.push({
      detail: "Agents working for you — on your other computers or in the cloud.",
      label: "Only your agents",
      reach: "owner",
    });
  }
  if (input.ownership === "deployment" || input.deploymentKind === "server") {
    options.push({
      detail: "Agents working for anyone in this deployment.",
      label: `Everyone in ${input.deploymentName}`,
      reach: "deployment",
    });
  }
  return options;
}

/* ------------------------------------------------------------------------- *
 * The form
 *
 * The policy the Host holds and the form a person is editing are two separate
 * values. A live update never replaces a half-typed folder path, and the
 * revision the save names is the one this editor last read clean — so a policy
 * written somewhere else conflicts instead of being silently overwritten.
 * ------------------------------------------------------------------------- */

export interface MachineAccessEditorState {
  /** The policy the form was last known to agree with. */
  readonly acknowledged: MachineAccessPolicy;
  readonly draft: MachineAccessPolicy;
  /** The revision `acknowledged` came from, and the one a save names. */
  readonly revision: number;
}

export type MachineAccessEditorAction =
  | { readonly commands: boolean; readonly type: "commands-edited" }
  | { readonly forwarding: boolean; readonly type: "forwarding-edited" }
  | {
      readonly index: number;
      readonly mode: MachineAccessShare["mode"];
      readonly type: "share-mode-edited";
    }
  | { readonly index: number; readonly path: string; readonly type: "share-path-edited" }
  | { readonly index: number; readonly type: "share-removed" }
  | {
      readonly policy: MachineAccessPolicy;
      readonly revision: number;
      readonly type: "reloaded" | "saved" | "server-observed";
    }
  | { readonly reach: MachineAccessReach; readonly type: "reach-edited" }
  | { readonly type: "share-added" };

export function initialMachineAccessEditorState(access: {
  readonly policy: MachineAccessPolicy;
  readonly revision: number;
}): MachineAccessEditorState {
  return { acknowledged: access.policy, draft: access.policy, revision: access.revision };
}

export function reduceMachineAccessEditor(
  state: MachineAccessEditorState,
  action: MachineAccessEditorAction,
): MachineAccessEditorState {
  switch (action.type) {
    case "commands-edited":
      return { ...state, draft: { ...state.draft, commands: action.commands } };
    case "forwarding-edited":
      return { ...state, draft: { ...state.draft, forwarding: action.forwarding } };
    case "reach-edited":
      return { ...state, draft: { ...state.draft, reach: action.reach } };
    case "share-added":
      return {
        ...state,
        draft: { ...state.draft, shares: [...state.draft.shares, { mode: "read", path: "" }] },
      };
    case "share-removed":
      return {
        ...state,
        draft: {
          ...state.draft,
          shares: state.draft.shares.filter((_, index) => index !== action.index),
        },
      };
    case "share-mode-edited":
      return {
        ...state,
        draft: {
          ...state.draft,
          shares: editShare(state.draft.shares, action.index, { mode: action.mode }),
        },
      };
    case "share-path-edited":
      return {
        ...state,
        draft: {
          ...state.draft,
          shares: editShare(state.draft.shares, action.index, { path: action.path }),
        },
      };
    case "reloaded":
    // A reload is a person asking for the settings as they now stand, so it
    // takes the freshly read policy AND its revision even over unsaved edits —
    // which is the only way out of a conflict: a save that kept the revision
    // the form first read would conflict again forever.
    case "saved":
      return { acknowledged: action.policy, draft: action.policy, revision: action.revision };
    case "server-observed":
      // An unsaved edit outranks a live update: the person is mid-sentence, and
      // holding the revision they read is what turns a competing write into a
      // conflict they are told about rather than one they silently lose.
      if (machineAccessEditorDirty(state) || action.revision === state.revision) return state;
      return { acknowledged: action.policy, draft: action.policy, revision: action.revision };
  }
}

function editShare(
  shares: readonly MachineAccessShare[],
  index: number,
  patch: Partial<MachineAccessShare>,
): MachineAccessShare[] {
  return shares.map((share, position) => (position === index ? { ...share, ...patch } : share));
}

export function machineAccessEditorDirty(state: MachineAccessEditorState): boolean {
  return !samePolicy(state.acknowledged, state.draft);
}

function samePolicy(left: MachineAccessPolicy, right: MachineAccessPolicy): boolean {
  return (
    left.commands === right.commands &&
    left.forwarding === right.forwarding &&
    left.reach === right.reach &&
    left.shares.length === right.shares.length &&
    left.shares.every(
      (share, index) =>
        share.mode === right.shares[index]?.mode && share.path === right.shares[index]?.path,
    )
  );
}

/**
 * Everything wrong with the folders as they stand, each a whole sentence.
 *
 * A row that is still empty is not an error — it is a row the person has not
 * finished — so it is reported as an unfinished row rather than fed to the
 * shared validator, which would name a folder called nothing.
 */
export function machineAccessDraftIssues(policy: MachineAccessPolicy): readonly string[] {
  const filled = policy.shares.filter((share) => share.path.trim() !== "");
  const issues = [...machineAccessShareIssues(filled)];
  if (filled.length !== policy.shares.length) {
    issues.push("Enter a folder path, or remove the empty row.");
  }
  return issues;
}

/** The policy a save sends: the folders as typed, with unfinished rows gone. */
export function machineAccessPolicyToSave(policy: MachineAccessPolicy): MachineAccessPolicy {
  return { ...policy, shares: policy.shares.filter((share) => share.path.trim() !== "") };
}

/**
 * The draft in one sentence: who may connect, and what they could do if they
 * did. Read from the draft rather than the saved policy, so the sentence is
 * what Save would make true — which is the question a person editing has.
 *
 * Folders are counted, never listed: a list of paths repeats the rows directly
 * above it, and the count plus how they may be opened is the part a reader
 * cannot get at a glance. Unfinished rows are left out for the same reason a
 * save drops them — they grant nothing.
 */
export function machineAccessSummary(
  policy: MachineAccessPolicy,
  place: { readonly deploymentName: string; readonly machineName: string },
): string {
  if (policy.reach === "nobody") return `No other computer can reach ${place.machineName}.`;
  const subject = policy.reach === "owner" ? "Your agents" : `Agents in ${place.deploymentName}`;
  const grants = [
    folderGrant(policy.shares),
    policy.commands ? "run commands" : null,
    policy.forwarding ? "reach local services" : null,
  ].filter((grant): grant is string => grant !== null);
  if (grants.length === 0) {
    return `${subject} can connect to ${place.machineName} but can't open any folder or run anything yet.`;
  }
  return `${subject} can ${joinClauses(grants)} on ${place.machineName}.`;
}

function folderGrant(shares: readonly MachineAccessShare[]): string | null {
  const filled = shares.filter((share) => share.path.trim() !== "");
  if (filled.length === 0) return null;
  const writable = filled.filter((share) => share.mode === "read-write").length;
  const noun = filled.length === 1 ? "folder" : "folders";
  if (writable === 0) return `open ${filled.length} ${noun} (read-only)`;
  if (writable === filled.length) return `open ${filled.length} ${noun} (read and write)`;
  return `open ${filled.length} ${noun} (${writable} writable)`;
}

function joinClauses(clauses: readonly string[]): string {
  if (clauses.length === 1) return clauses[0] ?? "";
  return `${clauses.slice(0, -1).join(", ")} and ${clauses.at(-1)}`;
}

export function machineAccessSaveLabel(activeSessions: number): string {
  if (activeSessions === 0) return "Save";
  return activeSessions === 1
    ? "Save and end 1 active session"
    : `Save and end ${activeSessions} active sessions`;
}

export const machineAccessConflictMessage = "Access settings changed elsewhere. Reload.";

/** What Reload costs, said before it is clicked rather than after. */
export const machineAccessReloadHint =
  "Reloading shows the saved settings and discards your edits.";

/* ------------------------------------------------------------------------- *
 * Live sessions and history, in words
 * ------------------------------------------------------------------------- */

/** How long a session has been open, in the units §11 reads them in. */
export function machineAccessElapsedLabel(startedAt: string, now = Date.now()): string {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "just now";
  const seconds = Math.max(0, Math.floor((now - started) / 1_000));
  if (seconds < 60) return "less than a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export function machineAccessSessionBytes(session: {
  readonly bytesIn: number;
  readonly bytesOut: number;
}): number {
  return session.bytesIn + session.bytesOut;
}

export function machineAccessSessionLabel(session: ShellSessionSummary): string {
  const title = session.threadTitle.trim() === "" ? "Untitled thread" : session.threadTitle;
  return `Thread ${title} from ${session.callerMachineName}`;
}

/** Why a session ended, said the way the person who ended it would say it. */
export function machineAccessEndReasonLabel(reason: ShellCloseReason): string {
  switch (reason) {
    case "client-closed":
      return "the agent finished";
    case "target-closed":
      return "this computer closed it";
    case "run-ended":
      return "the run ended";
    case "stopped-by-owner":
      return "stopped by the owner";
    case "policy-changed":
      return "these settings changed";
    case "machine-revoked":
      return "the computer was removed";
    case "machine-disconnected":
      return "the computer went away";
    case "host-shutdown":
      return "the deployment restarted";
    case "protocol-error":
      return "the connection broke";
    case "idle-timeout":
      return "it went idle";
    case "open-timeout":
      return "it never finished opening";
    case "open-failed":
      return "it could not be opened";
  }
}

/**
 * Records can go missing for several reasons — the helper, the Runner, the
 * Host, or a failed write — so the history says only what it knows: that it is
 * incomplete, and that what it kept is the beginning.
 */
export const machineAccessTruncatedMessage = "History is incomplete; earlier requests were kept";

/**
 * One audited request, as a sentence rather than a wire record.
 *
 * The helper writes each record when the request arrives, before the operation
 * it asks for runs — so "Ran" and "Wrote" would claim an effect nobody
 * observed. Every label is therefore a request, and only a record that carries
 * an outcome of its own (a refusal, a channel's exit) states one.
 */
export function machineAccessAuditLabel(event: ShellAuditEvent): string {
  switch (event.kind) {
    case "exec":
      return `Requested command ${event.command}`;
    case "sftp.open":
      return event.mode === "read"
        ? `Requested read of ${event.path}`
        : `Requested write to ${event.path}`;
    case "sftp.mutate":
      if (event.op === "mkdir") return `Requested new folder ${event.path}`;
      if (event.op === "remove") return `Requested removal of ${event.path}`;
      if (event.op === "rename") {
        return `Requested rename ${event.path} to ${event.target ?? "elsewhere"}`;
      }
      return `Requested change to ${event.path}`;
    case "forward":
      return `Requested a connection to ${event.host}:${event.port}`;
    case "denied":
      return event.detail.trim() === ""
        ? `Refused ${event.what}`
        : `Refused ${event.what}: ${event.detail}`;
    case "channel.closed":
      if (event.exitSignal !== undefined) return `Ended on signal ${event.exitSignal}`;
      return event.exitStatus === undefined ? "Ended" : `Exited ${event.exitStatus}`;
    case "truncated":
      return machineAccessTruncatedMessage;
  }
}
