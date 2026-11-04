import type {
  DesktopUpdateChannel,
  DesktopUpdateIntent,
  DesktopUpdateOperation,
  DesktopUpdateState,
  DesktopUpdateStatus,
} from "@opensteer/protocol/maintenance";
import type { DesktopUpdatesFailure } from "../connections/desktop-updates-contract.js";

const resultLifetimeMs = 24 * 60 * 60 * 1_000;

export interface DesktopUpdateConfirm {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
}
export type DesktopUpdateAction =
  | {
      readonly kind: "request";
      readonly label: string;
      readonly intent: DesktopUpdateIntent;
      readonly confirm: DesktopUpdateConfirm;
    }
  | { readonly kind: "retry"; readonly label: string };
export interface DesktopUpdateResult {
  readonly tone: "success" | "attention" | "neutral";
  readonly text: string;
}
export interface DesktopUpdateView {
  /** The Host refused this person, so there is nothing to show them. */
  readonly hidden: boolean;
  readonly title: string;
  readonly headline: string;
  readonly detail: string | null;
  /** The progress and detail as one line, for a row with room for one. */
  readonly statusLine: string | null;
  readonly versionLine: string | null;
  readonly channel: "Stable" | "Beta" | null;
  readonly progress: { readonly text: string; readonly percent: number | null } | null;
  readonly result: DesktopUpdateResult | null;
  /** Update, or Try again. */
  readonly action: DesktopUpdateAction | null;
  readonly channelAction: DesktopUpdateAction | null;
}
export interface DesktopUpdateViewInput {
  readonly computerName: string;
  readonly status: DesktopUpdateStatus | null;
  readonly failure: DesktopUpdatesFailure | null;
  readonly requesting: boolean;
  /** A restart has been silent for much longer than one should be. */
  readonly stalled: boolean;
  readonly now: number;
}

export function desktopUpdateActive(operation: DesktopUpdateOperation | null | undefined): boolean {
  return operation !== null && operation !== undefined && !desktopUpdateFinished(operation);
}

function desktopUpdateFinished(operation: DesktopUpdateOperation): boolean {
  return operation.state === "succeeded" || operation.state === "failed";
}

function channelName(channel: DesktopUpdateChannel): "Stable" | "Beta" {
  return channel === "stable" ? "Stable" : "Beta";
}

function restartCopy(name: string): string {
  return `Opensteer on ${name} restarts, along with its Host and Runner. Agents running there are interrupted and can resume afterwards.`;
}

function updateAction(state: DesktopUpdateState, name: string): DesktopUpdateAction | null {
  const intent = { action: "update" } as const;
  if (state.status === "available" || state.status === "downloaded") {
    const target = state.availableVersion;
    return {
      kind: "request",
      label: target === null ? "Update" : `Update to ${target}`,
      intent,
      confirm: {
        title: `Update Opensteer on ${name}?`,
        body: restartCopy(name),
        confirmLabel: "Update and restart",
      },
    };
  }
  if (state.status !== "idle" && state.status !== "up-to-date" && state.status !== "error")
    return null;
  return {
    kind: "request",
    label: state.status === "error" ? "Try again" : "Check for updates",
    intent,
    confirm: {
      title: `Check for updates on ${name}?`,
      body: `If a newer version is ready, it installs right away. ${restartCopy(name)}`,
      confirmLabel: "Check and update",
    },
  };
}

function switchAction(state: DesktopUpdateState, name: string): DesktopUpdateAction | null {
  if (!["idle", "up-to-date", "ahead", "available", "error"].includes(state.status)) return null;
  const channel = state.channel === "stable" ? "beta" : "stable";
  const label = `Switch to ${channelName(channel)}`;
  const behind =
    channel === "stable"
      ? " If Stable is behind this version, nothing restarts: your choice is saved and updates resume when Stable catches up."
      : "";
  return {
    kind: "request",
    label,
    intent: { action: "channel", channel },
    confirm: {
      title: `Switch ${name} to ${channelName(channel)}?`,
      body: `If a newer version is ready, it installs right away. ${restartCopy(name)}${behind}`,
      confirmLabel: label,
    },
  };
}

function settledCopy(
  state: DesktopUpdateState,
  name: string,
): Pick<DesktopUpdateView, "headline" | "detail" | "progress"> {
  const channel = channelName(state.channel);
  const progress = null;
  switch (state.status) {
    case "unavailable":
      return {
        headline: "Updates unavailable",
        detail: `This copy of Opensteer can't update itself. Update it on ${name}.`,
        progress,
      };
    case "checking":
      return { headline: "Checking for updates…", detail: null, progress };
    case "up-to-date":
      return { headline: "Up to date", detail: null, progress };
    case "ahead":
      return {
        headline: `Ahead of ${channel}`,
        detail: `${name} is newer than the latest ${channel} version${state.latestVersion === null ? "" : `, ${state.latestVersion}`}. Updates resume when ${channel} catches up.`,
        progress,
      };
    case "available":
      return {
        headline: "Update available",
        detail: `Version ${state.availableVersion ?? "update"} is ready to install.`,
        progress,
      };
    case "downloading":
      return {
        headline: "Downloading update…",
        detail: null,
        progress: {
          text: `Downloading update… ${state.downloadPercent ?? 0}%`,
          percent: state.downloadPercent,
        },
      };
    case "downloaded":
      return {
        headline: "Update ready",
        detail: `Version ${state.availableVersion ?? "update"} needs a restart to finish.`,
        progress,
      };
    case "error":
      return {
        headline: state.failed === "download" ? "Download failed" : "Couldn't check for updates",
        detail: null,
        progress,
      };
    case "idle":
      return { headline: "Not checked yet", detail: null, progress };
  }
}

function activeView(
  operation: DesktopUpdateOperation,
  input: DesktopUpdateViewInput,
): Pick<DesktopUpdateView, "headline" | "detail" | "progress"> {
  const state = input.status?.state ?? null;
  const name = input.computerName;
  const headline =
    operation.intent.action === "channel"
      ? `Switching to ${channelName(operation.intent.channel)}`
      : operation.targetVersion === null
        ? "Updating"
        : `Updating to ${operation.targetVersion}`;
  const detail = input.stalled
    ? `This is taking longer than usual. If it doesn't come back, open Opensteer on ${name}.`
    : null;
  if (operation.state === "pending" && state === null && input.failure === null)
    return {
      headline,
      detail,
      progress: { text: `Waiting for Opensteer to open on ${name}…`, percent: null },
    };
  if (operation.state === "installing" || state === null || input.failure !== null)
    return { headline, detail, progress: { text: "Restarting…", percent: null } };
  if (operation.state === "pending")
    return { headline, detail, progress: { text: "Starting…", percent: null } };
  if (operation.state === "running")
    return { headline, detail, progress: { text: "Checking for updates…", percent: null } };
  if (state.status === "downloaded")
    return { headline, detail, progress: { text: "Getting ready to restart…", percent: 100 } };
  return {
    headline,
    detail,
    progress: {
      text:
        state.downloadPercent === null
          ? "Downloading update…"
          : `Downloading update… ${state.downloadPercent}%`,
      percent: state.downloadPercent,
    },
  };
}

function resultOf(
  operation: DesktopUpdateOperation,
  state: DesktopUpdateState | null,
  name: string,
): DesktopUpdateResult {
  const stayed = operation.fromVersion ?? state?.currentVersion ?? null;
  const stayedOn = stayed === null ? "its old version" : stayed;
  if (operation.state === "failed") {
    const text =
      operation.detail === "not-applied"
        ? `${name} restarted but stayed on ${stayedOn}. The update didn't install.`
        : operation.detail === "handoff-failed"
          ? `Opensteer couldn't restart to install the update. ${name} is still on ${stayedOn}.`
          : `The update didn't finish. ${name} is still on ${stayedOn}.`;
    return { tone: "attention", text };
  }
  const switched =
    operation.intent.action === "channel" ? channelName(operation.intent.channel) : null;
  if (operation.detail === "ahead") {
    const channel = switched ?? (state === null ? "this channel" : channelName(state.channel));
    return {
      tone: "neutral",
      text: `${switched === null ? "" : `${switched} is saved. `}${name} stays on ${state?.currentVersion ?? stayedOn} for now. Updates resume when ${channel} catches up.`,
    };
  }
  if (operation.detail === "up-to-date")
    return {
      tone: "neutral",
      text: `${switched === null ? "" : `Switched to ${switched}. `}${name} is already up to date.`,
    };
  const started = state?.currentVersion ?? operation.targetVersion ?? "the new version";
  return {
    tone: "success",
    text: `${switched === null ? "Updated." : `Switched to ${switched}.`} ${name} is now running ${started}.`,
  };
}

function freshResult(input: DesktopUpdateViewInput): DesktopUpdateResult | null {
  const operation = input.status?.operation ?? null;
  if (operation === null || !desktopUpdateFinished(operation)) return null;
  if (input.now - Date.parse(operation.updatedAt) > resultLifetimeMs) return null;
  return resultOf(operation, input.status?.state ?? null, input.computerName);
}

const retry: DesktopUpdateAction = { kind: "retry", label: "Try again" };

export function desktopUpdateView(input: DesktopUpdateViewInput): DesktopUpdateView {
  const view = settledOrActiveView(input);
  const statusLine = [view.progress?.text, view.detail].filter(Boolean).join(" ");
  return { ...view, statusLine: statusLine === "" ? null : statusLine };
}

function settledOrActiveView(input: DesktopUpdateViewInput): DesktopUpdateView {
  const name = input.computerName;
  const state = input.status?.state ?? null;
  const operation = input.status?.operation ?? null;
  const base: DesktopUpdateView = {
    hidden: false,
    title: `Opensteer on ${name}`,
    headline: "Checking…",
    detail: null,
    statusLine: null,
    versionLine: state === null ? null : `Version ${state.currentVersion}`,
    channel: state === null ? null : channelName(state.channel),
    progress: null,
    result: null,
    action: null,
    channelAction: null,
  };
  if (input.failure === "forbidden") return { ...base, hidden: true };
  if (operation !== null && desktopUpdateActive(operation)) {
    const active = { ...base, ...activeView(operation, input) };
    return input.failure === "unauthorized"
      ? {
          ...active,
          detail: `Sign in to ${name} again to see how this finishes.`,
          action: { kind: "retry", label: "Sign in again" },
        }
      : active;
  }
  if (input.requesting)
    return {
      ...base,
      headline: "Updating",
      progress: { text: "Starting…", percent: null },
    };
  if (input.status?.supported === false)
    return {
      ...base,
      headline: "Update on that computer",
      detail: `Opensteer on ${name} can't be updated from here. Update it on that computer.`,
    };
  switch (input.failure) {
    case "unsupported":
      return {
        ...base,
        headline: "Update on that computer first",
        detail: `${name} needs one update on that computer. After that, you can update it from here.`,
      };
    case "unauthorized":
      return {
        ...base,
        headline: "Sign in again",
        detail: `Sign in to ${name} again to update it.`,
        action: { kind: "retry", label: "Sign in again" },
      };
    case "offline":
      return {
        ...base,
        headline: "Not running",
        detail: `Opensteer isn't running on ${name}. Open it there, then try again.`,
        action: retry,
      };
    case "conflict":
      return {
        ...base,
        headline: "Already updating",
        detail: `Opensteer on ${name} is already updating. Its progress will show here.`,
      };
    case "unavailable":
    case "invalid-response":
      return {
        ...base,
        headline: "Couldn't check for updates",
        detail: `Opensteer on ${name} didn't answer. Try again.`,
        action: retry,
      };
    case null:
      break;
  }
  if (input.status === null) return base;
  const result = freshResult(input);
  if (state === null)
    return {
      ...base,
      result,
      headline: "Not running",
      detail: `Opensteer isn't running on ${name}. Open it there to update.`,
    };
  const copy = {
    ...settledCopy(state, name),
    ...(result?.tone === "success" && state.status === "idle" ? { headline: "Updated" } : {}),
    ...(result !== null && state.status === "ahead" ? { detail: null } : {}),
  };
  if (state.reservedBy !== null && state.reservedBy !== undefined)
    return {
      ...base,
      ...copy,
      result,
      detail: `Opensteer on ${name} is busy with an update. Try again when it finishes.`,
    };
  return {
    ...base,
    ...copy,
    result,
    action: updateAction(state, name),
    channelAction: switchAction(state, name),
  };
}
