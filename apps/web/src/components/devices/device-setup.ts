import { DeploymentIdSchema } from "@opensteer/core";
import type { DevicePreparedIdentity, DeviceInitialAccess } from "@opensteer/protocol";
import { outcomeWords, runAction } from "../use-action.js";

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
      return { text: "This Mac isn’t connected yet", action: "Connect" };
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
  // Each step is said in the app's words; the ports' own exception text never is.
  onStage("joining");
  const joined = await runAction(null, {
    label: "add this Mac",
    done: "added",
    happened: "this Mac was added",
    execute: async () => {
      const preparedIdentity = input.devicesAvailable ? await ports.prepare(input.name) : undefined;
      const { token } = await ports.mint({
        ...(preparedIdentity ? { preparedIdentity } : {}),
        name: input.name,
        access: input.devicesAvailable ? input.access : null,
      });
      return (await ports.setUp({ token, name: input.name })).runnerId;
    },
  });
  if (joined.kind !== "confirmed")
    return {
      ok: false,
      cause: { kind: "failed", detail: outcomeWords(joined) ?? "" },
      runnerId: null,
    };
  const runnerId = joined.value;
  if (runnerId === null)
    return {
      ok: false,
      cause: { kind: "failed", detail: "This Mac didn’t finish joining." },
      runnerId: null,
    };
  if (!input.devicesAvailable) return { ok: true, runnerId };
  const applied = await runAction(null, {
    label: "set what this Mac allows",
    done: "set",
    happened: "what this Mac allows was set",
    execute: () => ports.applyAccess(runnerId, input.access),
  });
  if (applied.kind !== "confirmed")
    return { ok: false, cause: { kind: "failed", detail: outcomeWords(applied) ?? "" }, runnerId };
  onStage("binding");
  const bound = await runAction(null, {
    label: "connect this Mac",
    done: "connected",
    happened: "this Mac connected",
    execute: () => ports.bind(runnerId),
  });
  if (bound.kind !== "confirmed")
    return { ok: false, cause: { kind: "bind", detail: outcomeWords(bound) ?? "" }, runnerId };
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
