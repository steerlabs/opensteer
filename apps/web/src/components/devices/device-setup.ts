import { DeploymentIdSchema } from "@opensteer/core";
import type {
  DevicePreparedIdentity,
  DeviceInitialAccess,
  DeviceSessionBindingProof,
} from "@opensteer/protocol";
import { actionErrorMessage } from "../../ui-utils.js";

/**
 * Why this Mac is not a finished device yet, with the one move that fixes it.
 * `remote` is Home's Use from anywhere, which admitting a new device needs.
 */
export type FinishSetupCause =
  | { readonly kind: "use-from-anywhere"; readonly homeName: string }
  | { readonly kind: "bind"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

export function finishSetupLine(cause: FinishSetupCause): {
  readonly text: string;
  readonly action: string;
} {
  switch (cause.kind) {
    case "use-from-anywhere":
      return {
        text: `Turn on Use from anywhere on ${cause.homeName} to finish`,
        action: "Turn on",
      };
    case "bind":
      return { text: "Finish setting up this Mac", action: "Try again" };
    case "failed":
      return { text: "Finish setting up this Mac", action: "Finish setup" };
  }
}

/** Everything setting up this Mac touches, each a port so the order is testable. */
export interface DeviceSetupPorts {
  /** Home's Use from anywhere, or null when it can't be read from here. */
  readonly remoteAccessMode: () => Promise<"off" | "connect" | "private" | null>;
  readonly prepare: (name: string) => Promise<DevicePreparedIdentity>;
  readonly mint: (input: {
    readonly preparedIdentity?: DevicePreparedIdentity;
    readonly name: string;
    readonly access: DeviceInitialAccess | null;
  }) => Promise<{ readonly token: string }>;
  readonly setUp: (input: {
    readonly token: string;
    readonly name: string;
  }) => Promise<{ readonly runnerId: string | null }>;
  readonly bind: (runnerId: string) => Promise<void>;
}

export type DeviceSetupStage = "checking" | "joining" | "binding";

type DeviceSetupResult =
  | { readonly ok: true; readonly runnerId: string }
  | { readonly ok: false; readonly cause: FinishSetupCause; readonly runnerId: string | null };

/**
 * Mints this Mac's enrollment with the switches it was set up with, starts its
 * Runner, then binds this session to it. A Host without device switches gets
 * the old enrollment; its switches are then the Host's defaults.
 */
export async function setUpThisDevice(
  ports: DeviceSetupPorts,
  input: {
    readonly name: string;
    readonly access: DeviceInitialAccess;
    readonly devicesAvailable: boolean;
    readonly homeName: string;
  },
  onStage: (stage: DeviceSetupStage) => void = () => undefined,
): Promise<DeviceSetupResult> {
  onStage("checking");
  const mode = await ports.remoteAccessMode().catch(() => null);
  if (mode === "off")
    return {
      ok: false,
      cause: { kind: "use-from-anywhere", homeName: input.homeName },
      runnerId: null,
    };
  let runnerId: string | null;
  try {
    onStage("joining");
    const preparedIdentity = input.devicesAvailable ? await ports.prepare(input.name) : undefined;
    const { token } = await ports.mint({
      ...(preparedIdentity ? { preparedIdentity } : {}),
      name: input.name,
      access: input.devicesAvailable ? input.access : null,
    });
    ({ runnerId } = await ports.setUp({ token, name: input.name }));
  } catch (reason) {
    return {
      ok: false,
      cause: { kind: "failed", detail: actionErrorMessage(reason) },
      runnerId: null,
    };
  }
  if (runnerId === null)
    return {
      ok: false,
      cause: { kind: "failed", detail: "This Mac didn’t finish joining." },
      runnerId: null,
    };
  if (!input.devicesAvailable) return { ok: true, runnerId };
  try {
    onStage("binding");
    await ports.bind(runnerId);
  } catch (reason) {
    return { ok: false, cause: { kind: "bind", detail: actionErrorMessage(reason) }, runnerId };
  }
  return { ok: true, runnerId };
}

/**
 * Replays accepted bindings through main so its durable record survives a lost receipt.
 */
export async function bindSessionToDevice(
  ports: {
    readonly currentSession: () => Promise<{
      readonly id: string;
      readonly deviceId: string | null;
    } | null>;
    readonly sign: (sessionId: string) => Promise<DeviceSessionBindingProof>;
    readonly bind: (machineId: string, proof: DeviceSessionBindingProof) => Promise<void>;
  },
  runnerId: string,
): Promise<"bound" | "already-bound"> {
  const session = await ports.currentSession();
  if (!session) throw new Error("This window has no Opensteer session to bind.");
  await ports.bind(runnerId, await ports.sign(session.id));
  return session.deviceId === runnerId ? "already-bound" : "bound";
}

export async function resumeDeviceSignIn(
  bridge: Pick<
    import("@opensteer/protocol/desktop").OpensteerDesktopBridge,
    "setUpDevice" | "select"
  >,
  deploymentId: string,
): Promise<void> {
  const id = DeploymentIdSchema.parse(deploymentId);
  await bridge.setUpDevice({ deploymentId: id, runnerName: "This Mac", runAgents: false });
  await bridge.select({ deploymentId: id });
}
