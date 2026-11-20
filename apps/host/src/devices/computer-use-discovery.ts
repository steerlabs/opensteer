import type { DeviceAvailability, PhoneDisplayView } from "@opensteer/protocol";
import type { PhoneDisplayDefinitionId } from "@opensteer/core";
import type { CallableIntegrationTool } from "@opensteer/database";
import type { IntegrationAccess, IntegrationConnectionId } from "@opensteer/integration-core";
import type { Blocked } from "@opensteer/core";

function toolReference(callable: CallableIntegrationTool): string {
  return `${callable.grant.id}.${callable.tool.id}.${callable.tool.schemaDigest}`;
}

/**
 * The session operations of one computer connection this task may call.
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
export const computerAppRequestShape = "app_access_request {computerId, app, access, reason}";

/** A phone is asked for whole, so its ask names the phone and no app. */
export const phoneRequestShape = "app_access_request {computerId, access, reason}";

export const noPhone =
  "No phone display is set up for agents. The person adds one from Computers in Opensteer, with the phone plugged in.";

/** A `computerId` that names none of this person's phones set up for agents. */
export function unknownPhone(computerId: string): string {
  return `No phone display set up for agents has computerId ${computerId}. Call computer_apps to list your phones and their computerIds.`;
}

export const noComputerUseMac =
  "No Mac is set up for computer use. The person sets it up on the Mac they want agents to use.";

/**
 * A `computerId` that names none of this person's Macs set up for computer
 * use: a typo, another person's Mac, or one that was removed. Each is fixed
 * the same way, by reading the ids again.
 */
export function unknownComputerUseMac(computerId: string): string {
  return `No Mac set up for computer use has computerId ${computerId}. Call computer_apps to list your Macs and their computerIds.`;
}

type ComputerAccess =
  { access: IntegrationAccess; blocked?: never } | { blocked: Blocked; access?: never };
function blocked(code: string, message: string, next: string): { blocked: Blocked } {
  return { blocked: { code, message, next } };
}
export function computerMachineProblem(machine: {
  name: string;
  state: string;
  computerToolEnabled?: boolean;
  computerUseVersion?: number | null;
}): { blocked: Blocked } | null {
  if (machine.state === "offline")
    return blocked(
      "computer_offline",
      `${machine.name} is offline.`,
      "The person can bring it online; other work can continue.",
    );
  if (
    machine.computerToolEnabled === false ||
    (machine.computerUseVersion !== undefined && machine.computerUseVersion !== 2)
  )
    return blocked(
      "update_required",
      `${machine.name} needs an Opensteer update.`,
      "The person can update Opensteer on the task's computer and the target computer.",
    );
  if (machine.state === "permission-required")
    return blocked(
      "permission_required",
      `${machine.name} needs computer-use permissions.`,
      "The person can enable Opensteer accessibility permissions and, on macOS, Screen Recording in Settings.",
    );
  if (machine.state !== "ready")
    return blocked(
      "unavailable",
      `${machine.name} is unavailable for computer use.`,
      "The person can enable computer use in Opensteer; other work can continue.",
    );
  return null;
}
export function pendingOnComputerNextAction(machine: string): string {
  return `The owner can answer the pending request for ${machine} from any Opensteer app. A pending request grants nothing yet. Its outcome goes to the task that opened it; a running task can call app_access_request if it needs its own continuation. Automation occurrences receive no continuation.`;
}
interface CommonFacts {
  readonly callable: boolean;
  readonly canAct?: boolean;
  readonly pendingPersonalGrant: boolean;
  readonly heldByAnotherRun: boolean;
}
interface ComputerAppDiscoveryFacts extends CommonFacts {
  readonly app: string;
  readonly computerId: string;
  readonly machine: {
    name: string;
    state: string;
    appApproval: "ask" | "automatic";
    computerToolEnabled?: boolean;
    computerUseVersion?: number | null;
  };
  readonly approval: {
    readonly status: "approved" | "blocked";
    readonly access: IntegrationAccess;
  } | null;
  readonly pendingOnMac: boolean;
}
export function computerAppDiscovery(facts: ComputerAppDiscoveryFacts): ComputerAccess {
  const name = `${facts.app} on ${facts.machine.name}`;
  if (facts.approval?.status === "blocked")
    return blocked(
      "blocked_by_owner",
      `${name} is blocked by its owner.`,
      "The owner can unblock it from any Opensteer app.",
    );
  const problem = computerMachineProblem(facts.machine);
  if (problem) return problem;
  if (facts.callable && !facts.heldByAnotherRun)
    return { access: facts.canAct ? "read-write" : "read" };
  if (facts.pendingOnMac || facts.pendingPersonalGrant)
    return blocked(
      "access_pending",
      `Access to ${name} is pending.`,
      pendingOnComputerNextAction(name),
    );
  if (facts.heldByAnotherRun) return busy(name);
  return blocked(
    "access_required",
    `${name} needs access for this task.`,
    `Request access with app_access_request {computerId:${JSON.stringify(facts.computerId)}, app:${JSON.stringify(facts.app)}, access:"read-write", reason:"<why you need it>"}; ${facts.machine.appApproval === "automatic" ? "access is approved automatically." : "the owner can approve from any Opensteer app."}`,
  );
}
export interface PhoneDiscoveryFacts extends CommonFacts {
  readonly phone: {
    readonly name: string;
    readonly state: string;
    readonly computerId: string;
    readonly computerToolEnabled?: boolean;
    readonly definitionId?: PhoneDisplayDefinitionId;
    readonly availability?: DeviceAvailability;
    readonly setup?: PhoneDisplayView["setup"];
  };
  readonly connection: { readonly access: IntegrationAccess } | null;
  readonly pendingPhoneAccess: boolean;
  readonly blockedByOwner?: boolean;
}
function busy(name: string): ComputerAccess {
  return blocked(
    "in_use",
    `${name} is in use by another task.`,
    "Other work can continue while the holding task finishes.",
  );
}
export function phoneDiscovery(facts: PhoneDiscoveryFacts): ComputerAccess {
  const name = facts.phone.name;
  if (facts.blockedByOwner)
    return blocked(
      "blocked_by_owner",
      `${name} is blocked by its owner.`,
      "The owner can unblock it from any Opensteer app.",
    );
  const problem = phoneProblem(facts.phone);
  if (problem) return problem;
  if (facts.callable && !facts.heldByAnotherRun)
    return { access: facts.canAct ? "read-write" : "read" };
  if (facts.pendingPhoneAccess || facts.pendingPersonalGrant)
    return blocked(
      "access_pending",
      `Access to ${name} is pending.`,
      pendingOnComputerNextAction(name),
    );
  if (facts.heldByAnotherRun) return busy(name);
  return blocked(
    "access_required",
    `${name} needs access for this task.`,
    `Request access with app_access_request {computerId:${JSON.stringify(facts.phone.computerId)}, access:"read-write", reason:"<why you need it>"}; the owner can approve from any Opensteer app.`,
  );
}

function phoneProblem(phone: PhoneDiscoveryFacts["phone"]): { blocked: Blocked } | null {
  const reason = phone.availability?.reason?.kind;
  const location =
    phone.setup?.location === "driver-mac"
      ? ` in Opensteer on ${phone.setup.driverRunnerName}`
      : " in Opensteer on its driving Mac";
  if (reason === "driver-asleep")
    return blocked(
      "computer_asleep",
      `${phone.name}'s screen driver is asleep.`,
      phone.definitionId === "iphone-screen"
        ? `It will work again when its driving Mac wakes${phone.setup?.location === "driver-mac" ? ` (${phone.setup.driverRunnerName})` : ""}; other work can continue.`
        : "It will work again when the device wakes; other work can continue.",
    );
  if (reason === "driver-offline" || (phone.state === "offline" && reason !== "not-connected"))
    return blocked(
      "computer_offline",
      `${phone.name}'s screen driver is offline.`,
      phone.definitionId === "iphone-screen"
        ? `The person can wake its driving Mac and open Opensteer there${phone.setup?.location === "driver-mac" ? ` (${phone.setup.driverRunnerName})` : ""}; other work can continue.`
        : "The person can bring the phone online; other work can continue.",
    );
  switch (reason) {
    case "approval-required":
      return computerMachineProblem({ ...phone, state: "ready" });
    case "locked":
      return blocked(
        "permission_required",
        `${phone.name} is locked.`,
        "Ask the person to unlock the iPhone physically, then observe again. Never enter or ask for its passcode.",
      );
    case "access-off":
      return blocked(
        "permission_required",
        `Apps access is off on ${phone.name}.`,
        `Ask with computer_access_request {computerId:${JSON.stringify(phone.computerId)}, access:"apps", reason:"<why you need it>"}.`,
      );
    case "driver-update-required":
      return blocked(
        "update_required",
        `${phone.name}'s screen driver needs an update.`,
        `The person can update Opensteer${location}.`,
      );
    case "trust-required":
    case "developer-mode-required":
    case "setup-required":
    case "permission-required":
      return blocked(
        "permission_required",
        `${phone.name} needs ${reason === "trust-required" ? "the person to trust its driving Mac" : reason === "developer-mode-required" ? "Developer Mode" : reason === "setup-required" ? "screen setup" : "screen permissions"}.`,
        phone.definitionId === "android-phone"
          ? "The person can enable Opensteer's accessibility service in the phone's settings."
          : `The person can finish or fix the iPhone's screen setup${location}.`,
      );
    case "paused":
      return blocked(
        "paused",
        `${phone.name}'s screen is paused.`,
        "The person can resume screen control in Opensteer or on the phone; other work can continue.",
      );
    case "protected":
      return blocked(
        "permission_required",
        `${phone.name}'s screen is protected.`,
        "The person can leave the protected screen; other work can continue.",
      );
    case "not-connected":
      return blocked(
        "unavailable",
        `${phone.name} is not connected to its screen driver.`,
        `The person can connect the iPhone to its Mac with a cable or the same Wi-Fi, then finish or fix setup${location}.`,
      );
    case "helper-unavailable":
    case "connecting":
    case "unreported":
    case "runtime-failed":
    case "unsupported":
      return blocked(
        "unavailable",
        `${phone.name}'s screen is unavailable (${reason}).`,
        `The person can check the screen driver and finish or fix setup${location}. Continue other work; do not poll or route through the Mac's apps.`,
      );
  }
  if (phone.state === "permission-required")
    return blocked(
      "permission_required",
      `${phone.name} needs screen permissions.`,
      phone.definitionId === "iphone-screen"
        ? `The person can check screen permissions and fix setup${location}.`
        : "The person can enable Opensteer's accessibility service in the phone's settings.",
    );
  if (phone.definitionId === "android-phone" && phone.state === "unavailable")
    return blocked(
      "paused",
      `${phone.name} is paused on the phone.`,
      "The person can resume it on the phone; other work can continue.",
    );
  if (phone.definitionId === "iphone-screen" && phone.state !== "ready")
    return blocked(
      "unavailable",
      `${phone.name}'s screen is unavailable.`,
      `The person can check its screen driver and fix setup${location}.`,
    );
  return computerMachineProblem(phone);
}
