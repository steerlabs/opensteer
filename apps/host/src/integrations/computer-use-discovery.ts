import type { CallableIntegrationTool } from "@opensteer/database";
import type { IntegrationAccess, IntegrationConnectionId } from "@opensteer/integration-core";
import { computerUseBusyNextStep } from "../computer-use/computer-use-service.js";

export function toolReference(callable: CallableIntegrationTool): string {
  return `${callable.grant.id}.${callable.tool.id}.${callable.tool.schemaDigest}`;
}

/**
 * The session operations of one computer connection this Workspace may call.
 * A phone also has `release`; a Mac's app does not, because a Mac's sessions
 * hold one app among the person's own and need no letting go to share it.
 */
export function computerToolRefs(
  tools: readonly CallableIntegrationTool[],
  connectionId: IntegrationConnectionId,
): { observe?: string; act?: string; release?: string } {
  const refs: { observe?: string; act?: string; release?: string } = {};
  for (const tool of tools) {
    if (tool.grant.connectionId !== connectionId) continue;
    if (tool.tool.name === "observe" || tool.tool.name === "act" || tool.tool.name === "release")
      refs[tool.tool.name] = toolReference(tool);
  }
  return refs;
}

/**
 * Every computer-use ask has this one shape. The ordinary `integration` form
 * names no app, so it can neither add an app nor say which one to grant.
 */
export const computerAppRequestShape =
  'integration_request {kind: "computer-app", runnerId, app, access, reason}';

/** A phone is asked for whole, so its ask names the phone and no app. */
export const phoneRequestShape =
  'integration_request {kind: "computer-app", runnerId, access, reason}';

export const noPhone =
  "No Android phone is set up for agents. The person adds one from Computers in Opensteer, with the phone plugged in.";

/** A `runnerId` that names none of this person's phones set up for agents. */
export function unknownPhone(runnerId: string): string {
  return `No Android phone set up for agents has runnerId ${runnerId}. Search "Android phone" with integration_search to list your phones and their runnerIds.`;
}

export const noComputerUseMac =
  "No Mac is set up for computer use. The person sets it up on the Mac they want agents to use.";

/**
 * A `runnerId` that names none of this person's Macs set up for computer
 * use: a typo, another person's Mac, or one that was removed. Each is fixed
 * the same way, by reading the ids again.
 */
export function unknownComputerUseMac(runnerId: string): string {
  return `No Mac set up for computer use has runnerId ${runnerId}. Search "Computer use" with integration_search to list your Macs and their runnerIds.`;
}

export function computerUseNextAction(machine: {
  name: string;
  state: string;
  appApproval: "ask" | "automatic";
}): string {
  return (
    unusableMachineNextAction(machine) ??
    `Search with runnerId to list installed apps on ${machine.name}. Request an app with ${computerAppRequestShape}; ${approvalOutcome(machine)}`
  );
}

function unusableMachineNextAction(machine: { name: string; state: string }): string | null {
  if (machine.state === "offline") return `${machine.name} is offline.`;
  if (machine.state === "permission-required")
    return `${machine.name} needs macOS Accessibility and Screen Recording for Opensteer Computer Use.`;
  if (machine.state === "unavailable")
    return `Computer use needs the Opensteer desktop app on ${machine.name}.`;
  return null;
}

function approvalOutcome(machine: { appApproval: "ask" | "automatic" }): string {
  return machine.appApproval === "automatic"
    ? "it is approved automatically and becomes available in the computer tool."
    : "the person approves it on that Mac.";
}

/** An app approval waits on the Mac's panel. */
export function pendingOnComputerNextAction(machine: string): string {
  return `Approval is pending on ${machine}. Continue other work or end this turn; Opensteer continues this thread when it is resolved. Do not repeat the request.`;
}

export const pendingPhoneAccessNextAction =
  "Approval is pending; the owner can allow or decline from any Opensteer app. Continue other work or end this turn; Opensteer continues this thread when it is resolved. Do not repeat the request.";

export const pendingWorkspaceGrantNextAction =
  "Approval is pending; the person can approve it from anywhere. Continue other work or end this turn; Opensteer continues this thread when it is resolved. Do not repeat the request.";

/** What discovery knows about one app on one Mac, gathered by the caller. */
export interface ComputerAppDiscoveryFacts {
  readonly app: string;
  readonly machine: Parameters<typeof computerUseNextAction>[0];
  readonly approval: {
    readonly status: "approved" | "blocked";
    readonly access: IntegrationAccess;
  } | null;
  /** This Workspace holds the app's observe tool. */
  readonly callable: boolean;
  /** A setup request for this app on this Mac awaits the person there. */
  readonly pendingOnMac: boolean;
  /** An ordinary grant request for this app's connection awaits approval for this Workspace. */
  readonly pendingWorkspaceGrant: boolean;
  /** Another Run on this Host holds the app, with its Thread's title when known. */
  readonly heldByAnotherRun: { readonly threadTitle: string | null } | null;
}

/**
 * One app's discovery status and the single next step, most specific first:
 * a block, then an approval already waiting (so the model never asks twice),
 * then another task's session, and only then whether it can call or ask.
 */
export function computerAppDiscovery(facts: ComputerAppDiscoveryFacts): {
  readonly status: "approved" | "blocked" | "not-approved";
  readonly pending?: "mac" | "workspace";
  readonly inUse?: true;
  readonly nextAction: string;
} {
  const status = facts.approval?.status ?? "not-approved";
  if (status === "blocked")
    return {
      status,
      nextAction: `${facts.app} is blocked on ${facts.machine.name}. The person can unblock it on that Mac.`,
    };
  if (facts.pendingOnMac)
    return { status, pending: "mac", nextAction: pendingOnComputerNextAction(facts.machine.name) };
  if (facts.pendingWorkspaceGrant)
    return { status, pending: "workspace", nextAction: pendingWorkspaceGrantNextAction };
  if (facts.heldByAnotherRun) {
    const title = facts.heldByAnotherRun.threadTitle;
    return {
      status,
      inUse: true,
      nextAction: `This app is already being used by another task.${title ? ` (Thread: ${title})` : ""} ${computerUseBusyNextStep}`,
    };
  }
  if (facts.callable)
    return { status, nextAction: "Use the computer tool with app() to see and operate this app." };
  if (facts.approval)
    return {
      status,
      nextAction: `Request access with ${computerAppRequestShape}; the person can approve from anywhere.`,
    };
  // This row is already one app of the Mac's listing, so the step is the
  // request itself rather than the search that produced it.
  return {
    status,
    nextAction:
      unusableMachineNextAction(facts.machine) ??
      `Request it with ${computerAppRequestShape}; ${approvalOutcome(facts.machine)}`,
  };
}

/** What discovery knows about one phone, gathered by the caller. */
export interface PhoneDiscoveryFacts {
  readonly phone: { readonly name: string; readonly state: string };
  /** The phone's approved connection, when it has one. */
  readonly connection: { readonly access: IntegrationAccess } | null;
  /** This Workspace holds the phone's observe tool. */
  readonly callable: boolean;
  /** This Workspace also holds its act tool: its grant is read-write, not only read. */
  readonly canAct: boolean;
  /** An access Request for this phone awaits its owner. */
  readonly pendingPhoneAccess: boolean;
  /** An ordinary grant request for the phone's connection awaits approval for this Workspace. */
  readonly pendingWorkspaceGrant: boolean;
  /** Another Run on this Host holds the phone, with its Thread's title when known. */
  readonly heldByAnotherRun: { readonly threadTitle: string | null } | null;
}

/**
 * One phone's discovery status and the single next step, most specific
 * first: an approval already waiting (so the model never asks twice), then a
 * phone that cannot work right now, then another task holding it, and only
 * then whether it can call or ask.
 */
export function phoneDiscovery(facts: PhoneDiscoveryFacts): {
  readonly approval: "approved" | "not-approved" | "pending";
  readonly inUse: boolean;
  readonly nextAction: string;
} {
  const inUse = facts.heldByAnotherRun !== null;
  if (facts.pendingPhoneAccess || facts.pendingWorkspaceGrant)
    return {
      approval: "pending",
      inUse,
      nextAction: facts.pendingPhoneAccess
        ? pendingPhoneAccessNextAction
        : pendingWorkspaceGrantNextAction,
    };
  const approval = facts.connection ? "approved" : "not-approved";
  const unusable = unusablePhoneNextAction(facts.phone);
  if (unusable) return { approval, inUse, nextAction: unusable };
  if (facts.heldByAnotherRun) {
    const title = facts.heldByAnotherRun.threadTitle;
    return {
      approval,
      inUse,
      nextAction: `${facts.phone.name} is already being used by another task.${title ? ` (Thread: ${title})` : ""} ${computerUseBusyNextStep}`,
    };
  }
  if (facts.callable)
    return {
      approval,
      inUse,
      nextAction: facts.canAct
        ? "Use the computer tool with phone(): observe, act, and release when you are done so another task can use the phone."
        : `Use the computer tool with phone(): observe, and release when you are done so another task can use the phone. This task may only look at ${facts.phone.name}; to act, ask with ${phoneRequestShape} and access "read-write".`,
    };
  return {
    approval,
    inUse,
    nextAction: `Request access with ${phoneRequestShape}; the owner allows it from any Opensteer app.`,
  };
}

function unusablePhoneNextAction(phone: { name: string; state: string }): string | null {
  if (phone.state === "offline") return `${phone.name} is offline.`;
  if (phone.state === "permission-required")
    return `${phone.name} needs its Opensteer accessibility service turned back on in the phone's settings. Tell the person.`;
  if (phone.state === "unavailable")
    return `${phone.name} is not taking work from agents right now, for example because it is paused on the phone. Tell the person, or continue other work.`;
  return null;
}
