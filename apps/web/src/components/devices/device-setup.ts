import { DeploymentIdSchema } from "@opensteer/core";
import type { DevicePreparedIdentity, DeviceInitialAccess } from "@opensteer/protocol";
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
      return { text: "This Mac couldn’t confirm your sign-in", action: "Try again" };
    case "failed":
      return { text: "Finish setting up this Mac", action: "Finish setup" };
  }
}

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
  /** A retry can reach an already-joined Runner whose enrollment applied older choices. */
  readonly applyAccess: (runnerId: string, access: DeviceInitialAccess) => Promise<void>;
  readonly bind: (runnerId: string) => Promise<void>;
}

export type DeviceSetupStage = "checking" | "joining" | "binding";

type DeviceSetupResult =
  | { readonly ok: true; readonly runnerId: string }
  | { readonly ok: false; readonly cause: FinishSetupCause; readonly runnerId: string | null };

/** A Host without device switches gets the old enrollment, with the Host's default switches. */
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
    await ports.applyAccess(runnerId, input.access);
  } catch (reason) {
    return { ok: false, cause: { kind: "failed", detail: actionErrorMessage(reason) }, runnerId };
  }
  try {
    onStage("binding");
    await ports.bind(runnerId);
  } catch (reason) {
    return { ok: false, cause: { kind: "bind", detail: actionErrorMessage(reason) }, runnerId };
  }
  return { ok: true, runnerId };
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
