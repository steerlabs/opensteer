import type { DeploymentTone } from "../theme.js";
import { deploymentStatusLabel, type DeploymentRow } from "../client/deployment-rows.js";
import { deploymentInitial, deploymentTone } from "../screens/deployment-row.js";

/**
 * Which Deployment this is, and the switch to another: the foot of the
 * sidebar, and Settings' current Deployment.
 *
 * Everything here is derived from rows the client already publishes, so a
 * view can subscribe to this projection alone: a snapshot that changed a
 * thread's title produces an equal model, and the view does not re-render.
 */

/**
 * The one glyph a row in the switcher carries. It says only what is observed —
 * this is the open one, this one wants a person, this one cannot be reached —
 * and a row in an ordinary settled state carries none, because a mark on every
 * row is a mark that distinguishes nothing.
 */
export type DeploymentGlyph = "checkmark" | "exclamationmark.triangle" | "moon";

export interface DeploymentMark {
  /** One character: a name's first initial, or a dot when it has none. */
  readonly initial: string;
  readonly tone: DeploymentTone;
}

export interface DeploymentSwitcherItem {
  readonly current: boolean;
  readonly deploymentId: string;
  readonly glyph: DeploymentGlyph | null;
  readonly name: string;
  /** The status word, for the places a menu row can carry a second line. */
  readonly status: string;
}

export interface DeploymentSwitcherModel {
  readonly items: readonly DeploymentSwitcherItem[];
  readonly mark: DeploymentMark;
  readonly name: string;
  /**
   * Whether the menu is showing only part of the list, so it must offer the
   * full switcher as well. A menu is a shortcut; past a handful of rows it
   * stops being one and the screen that can scroll takes over.
   */
  readonly seeAll: boolean;
  readonly status: string;
}

/**
 * How many Deployments a menu holds before it hands over to the switcher
 * screen. Six is what fits above the fold of a menu opened from a navigation
 * bar without the menu itself becoming a list to scroll.
 */
const switcherMenuLimit = 6;

export function deploymentMark(row: {
  readonly deploymentId: string;
  readonly name: string;
}): DeploymentMark {
  return { initial: deploymentInitial(row.name), tone: deploymentTone(row.deploymentId) };
}

export function deploymentSwitcherModel(
  rows: readonly DeploymentRow[],
  deploymentId: string,
): DeploymentSwitcherModel {
  const current = rows.find((row) => row.deploymentId === deploymentId) ?? null;
  // The open Deployment leads, so it is visible and checked even when the
  // catalog lists it far enough down that the menu would have cut it.
  const ordered = [
    ...(current === null ? [] : [current]),
    ...rows.filter((row) => row.deploymentId !== deploymentId),
  ];
  return {
    items: ordered.slice(0, switcherMenuLimit).map((row) => ({
      current: row.deploymentId === deploymentId,
      deploymentId: row.deploymentId,
      glyph: deploymentGlyph(row, row.deploymentId === deploymentId),
      name: row.name,
      status: deploymentStatusLabel(row.status),
    })),
    mark:
      current === null
        ? { initial: "•", tone: deploymentTone(deploymentId) }
        : deploymentMark(current),
    name: current?.name ?? "Deployment",
    seeAll: ordered.length > switcherMenuLimit,
    // A Deployment that has left this phone's list is not "offline" and not
    // anything else the status vocabulary covers: it is simply gone.
    status: current === null ? "No longer on this phone" : deploymentStatusLabel(current.status),
  };
}

function deploymentGlyph(row: DeploymentRow, current: boolean): DeploymentGlyph | null {
  if (current) return "checkmark";
  switch (row.status) {
    case "needs-sign-in":
    case "unverified":
    case "update-required":
      return "exclamationmark.triangle";
    case "offline":
    case "unavailable":
      return "moon";
    default:
      return null;
  }
}

/**
 * Whether two projections say the same thing. The sidebar's subscription hands
 * back the previous object when they do, so an unrelated snapshot — a streaming
 * token, a thread that moved — cannot re-render it.
 */
export function sameDeploymentSwitcherModel(
  left: DeploymentSwitcherModel,
  right: DeploymentSwitcherModel,
): boolean {
  return (
    left.name === right.name &&
    left.status === right.status &&
    left.seeAll === right.seeAll &&
    left.mark.initial === right.mark.initial &&
    left.mark.tone === right.mark.tone &&
    left.items.length === right.items.length &&
    left.items.every((item, index) => {
      const other = right.items[index];
      return (
        other !== undefined &&
        item.deploymentId === other.deploymentId &&
        item.current === other.current &&
        item.glyph === other.glyph &&
        item.name === other.name &&
        item.status === other.status
      );
    })
  );
}

/** What a screen reader hears instead of a mark, a name and a chevron. */
export function switcherAccessibilityLabel(model: DeploymentSwitcherModel): string {
  return `${model.name}. ${model.status}`;
}
