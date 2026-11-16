import type { MachineAppStatus } from "@opensteer/protocol";

type MachineAppOperationStatus = MachineAppStatus["operations"][number];

/** Adds a computer to an app-only sentence at the one agent-facing boundary. */
export function computerAppSentence(detail: string, computer: string): string {
  return `${detail.trim().replace(/\.+$/u, "")} on ${computer}.`;
}

export function computerAppOfflineDetail(app: string, computer: string): string {
  return `${computer} is offline. ${app} will work again when it is back.`;
}

/** A computer that is connected, but whose integrations stream is not. */
function integrationsServiceUnavailableDetail(computer: string): string {
  return `Opensteer's integrations service is unavailable on ${computer}.`;
}

export function computerAppTransportUnavailableDetail(
  app: string,
  computer: string,
  runnerConnected: boolean,
): string {
  return runnerConnected
    ? integrationsServiceUnavailableDetail(computer)
    : computerAppOfflineDetail(app, computer);
}

/** Renders live app state without turning it into persisted integration authority. */
export function computerAppAvailabilityDetail(input: {
  readonly app: string;
  readonly attached: boolean;
  readonly computer: string;
  readonly runnerConnected: boolean;
  readonly status: MachineAppOperationStatus | readonly MachineAppOperationStatus[] | null;
}): string | null {
  if (!input.runnerConnected || !input.attached)
    return computerAppTransportUnavailableDetail(input.app, input.computer, input.runnerConnected);
  if (input.status === null || (Array.isArray(input.status) && input.status.length === 0)) {
    return `${input.app} is unavailable on ${input.computer}.`;
  }
  if (Array.isArray(input.status)) {
    if (input.status.some(({ state }) => state === "ready")) return null;
    const blocked =
      input.status.find(({ state }) => state === "permission-required") ?? input.status[0];
    if (!blocked?.detail) return `${input.app} is unavailable on ${input.computer}.`;
    return computerAppSentence(blocked.detail, input.computer);
  }
  const operation = input.status as MachineAppOperationStatus;
  if (operation.state === "ready") return null;
  if (!operation.detail) return `${input.app} is unavailable on ${input.computer}.`;
  return computerAppSentence(operation.detail, input.computer);
}

/**
 * A phone's live state as one sentence about that phone, built from its
 * state alone. The phone's own detail is written for its owner to read
 * beside its name, so it is never extended into an agent's sentence.
 */
export function phoneAvailabilityDetail(input: {
  readonly attached: boolean;
  readonly phone: string;
  readonly runnerConnected: boolean;
  readonly status: MachineAppOperationStatus | readonly MachineAppOperationStatus[] | null;
}): string | null {
  if (!input.runnerConnected)
    return `${input.phone} is offline. It will work again when it is back.`;
  if (!input.attached) return integrationsServiceUnavailableDetail(input.phone);
  const statuses: readonly MachineAppOperationStatus[] =
    input.status === null ? [] : Array.isArray(input.status) ? input.status : [input.status];
  if (statuses.some(({ state }) => state === "ready")) return null;
  const blocked = statuses.find(({ state }) => state === "permission-required") ?? statuses[0];
  switch (blocked?.state) {
    case "permission-required":
      return `${input.phone} needs its Opensteer accessibility service turned back on in the phone's settings.`;
    case "unavailable":
      // The phone reports itself unavailable only while its owner paused it.
      return `${input.phone} is paused on the phone. The person can resume it there.`;
    default:
      return `${input.phone} is unavailable.`;
  }
}

/** iPhone app transport is available only while its first-party app is open. */
export function iphoneAppsUnavailableDetail(name: string): string {
  return `${name} is an iPhone, and agents can use its apps only while Opensteer is open on it. Ask the person to open Opensteer on ${name}, then try again; don't retry in a loop.`;
}
