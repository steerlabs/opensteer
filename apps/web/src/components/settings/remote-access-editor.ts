import type {
  DesktopPersonalPairingCode,
  DesktopPersonalRemoteAccessStatus,
  PersonalRemoteAccessMode,
} from "@opensteer/protocol/desktop";

/* ------------------------------------------------------------------------- *
 * Remote-access editor state
 *
 * The Desktop's observed route and the form the person is editing are two
 * different things, and conflating them is how a half-typed address used to
 * vanish under a status event. Live events never replace form values; an
 * acknowledged apply only marks the submitted draft clean.
 * ------------------------------------------------------------------------- */

export interface PersonalRemoteAccessDraft {
  readonly dirty: boolean;
  readonly privateOrigin: string;
  readonly selectedMode: PersonalRemoteAccessMode;
}

export interface PersonalRemoteAccessEditorState {
  readonly acknowledged: Omit<PersonalRemoteAccessDraft, "dirty">;
  readonly draft: PersonalRemoteAccessDraft;
  readonly status: DesktopPersonalRemoteAccessStatus | null;
}

export type PersonalRemoteAccessEditorAction =
  | {
      readonly status: DesktopPersonalRemoteAccessStatus;
      readonly type: "apply-acknowledged" | "status-observed";
    }
  | { readonly mode: PersonalRemoteAccessMode; readonly type: "mode-edited" }
  | { readonly origin: string; readonly type: "private-origin-edited" };

export const initialPersonalRemoteAccessEditorState: PersonalRemoteAccessEditorState = {
  acknowledged: { privateOrigin: "", selectedMode: "off" },
  draft: { dirty: false, privateOrigin: "", selectedMode: "off" },
  status: null,
};

export function reducePersonalRemoteAccessEditor(
  state: PersonalRemoteAccessEditorState,
  action: PersonalRemoteAccessEditorAction,
): PersonalRemoteAccessEditorState {
  if (action.type === "mode-edited") {
    const draft = { ...state.draft, selectedMode: action.mode };
    return { ...state, draft: withDraftDirtyState(draft, state.acknowledged) };
  }
  if (action.type === "private-origin-edited") {
    const draft = { ...state.draft, privateOrigin: action.origin };
    return { ...state, draft: withDraftDirtyState(draft, state.acknowledged) };
  }
  if (state.status && action.status.generation < state.status.generation) {
    return action.type === "apply-acknowledged"
      ? remoteAccessStatusMatchesDraft(state.status, state.draft)
        ? acknowledgePersonalRemoteAccessDraft(state)
        : state
      : state;
  }

  if (state.status === null) {
    const draft = draftFromRemoteAccessStatus(action.status);
    return {
      acknowledged: { privateOrigin: draft.privateOrigin, selectedMode: draft.selectedMode },
      draft,
      status: action.status,
    };
  }
  if (action.type === "apply-acknowledged") {
    return { ...acknowledgePersonalRemoteAccessDraft(state), status: action.status };
  }
  return { ...state, status: action.status };
}

function acknowledgePersonalRemoteAccessDraft(
  state: PersonalRemoteAccessEditorState,
): PersonalRemoteAccessEditorState {
  const acknowledged = {
    privateOrigin: state.draft.privateOrigin,
    selectedMode: state.draft.selectedMode,
  };
  return { ...state, acknowledged, draft: { ...state.draft, dirty: false } };
}

function draftFromRemoteAccessStatus(
  status: DesktopPersonalRemoteAccessStatus,
): PersonalRemoteAccessDraft {
  return {
    dirty: false,
    privateOrigin: status.mode === "private" ? (status.routeOrigin ?? "") : "",
    selectedMode: status.mode,
  };
}

function withDraftDirtyState(
  draft: PersonalRemoteAccessDraft,
  acknowledged: Omit<PersonalRemoteAccessDraft, "dirty">,
): PersonalRemoteAccessDraft {
  return {
    ...draft,
    dirty:
      draft.selectedMode !== acknowledged.selectedMode ||
      (draft.selectedMode === "private" &&
        draft.privateOrigin.trim() !== acknowledged.privateOrigin),
  };
}

function remoteAccessStatusMatchesDraft(
  status: DesktopPersonalRemoteAccessStatus,
  draft: PersonalRemoteAccessDraft,
): boolean {
  return (
    status.phase !== "error" &&
    status.mode === draft.selectedMode &&
    (draft.selectedMode !== "private" || status.routeOrigin === draft.privateOrigin.trim())
  );
}

/* ------------------------------------------------------------------------- *
 * Pairing
 * ------------------------------------------------------------------------- */

/**
 * A pairing code is only meaningful for a Private-network address: Connect
 * pairs a device through your Account, which needs no code at all.
 */
export function canIssuePersonalPairingCode(
  status: DesktopPersonalRemoteAccessStatus | null,
): boolean {
  return status?.phase === "ready" && status.mode === "private";
}

/** Whether this code still describes the route it was issued against. */
export function isPairingCurrent(
  pairing: DesktopPersonalPairingCode | null,
  status: DesktopPersonalRemoteAccessStatus | null,
): pairing is DesktopPersonalPairingCode {
  return (
    pairing !== null &&
    status?.phase === "ready" &&
    status.mode === "private" &&
    pairing.generation === status.generation &&
    pairing.routeOrigin === status.routeOrigin
  );
}

export function pairingHasExpired(expiresAt: string, now = Date.now()): boolean {
  return Date.parse(expiresAt) <= now;
}

export function schedulePairingExpiry(expiresAt: string, onExpire: () => void): () => void {
  const delay = Math.max(0, Date.parse(expiresAt) - Date.now());
  const timeout = setTimeout(onExpire, delay);
  return () => clearTimeout(timeout);
}

/* ------------------------------------------------------------------------- *
 * Status wording
 * ------------------------------------------------------------------------- */

export function remoteAccessLabel(status: DesktopPersonalRemoteAccessStatus | null): string {
  if (!status) return "Checking…";
  if (status.phase === "unavailable") return "Unavailable";
  if (status.phase === "linking-account") return "Signing in";
  if (status.phase === "provisioning") return "Enabling";
  if (status.phase === "revoking") return "Turning off";
  if (status.phase === "offline") return "Offline";
  if (status.phase === "error") return "Needs attention";
  if (status.mode === "connect") return "Connect ready";
  if (status.mode === "private") return "Private network ready";
  return "Off";
}

export function remoteAccessChip(status: DesktopPersonalRemoteAccessStatus | null): string {
  if (status?.phase === "ready") return "chip--ok";
  if (
    status?.phase === "linking-account" ||
    status?.phase === "provisioning" ||
    status?.phase === "revoking" ||
    status?.phase === "offline"
  ) {
    return "chip--warn";
  }
  return status?.phase === "error" ? "chip--bad" : "";
}

export function remoteAccessBusyLabel(status: DesktopPersonalRemoteAccessStatus | null): string {
  if (status?.phase === "linking-account") return "Finish signing in…";
  if (status?.phase === "revoking") return "Turning off…";
  return "Applying…";
}

export function isRemoteAccessTransitioning(
  status: DesktopPersonalRemoteAccessStatus | null,
): boolean {
  return (
    status?.phase === "linking-account" ||
    status?.phase === "provisioning" ||
    status?.phase === "revoking"
  );
}

interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export async function copyPairingValue(
  value: string,
  clipboard: ClipboardWriter | null | undefined = globalThis.navigator?.clipboard,
): Promise<void> {
  if (!clipboard) throw new Error("Clipboard access is unavailable on this device.");
  await clipboard.writeText(value);
}
