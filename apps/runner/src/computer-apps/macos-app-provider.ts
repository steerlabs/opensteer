import { getIntegrationDefinition } from "@opensteer/integration-catalog";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import type { ComputerUsePermissions } from "@opensteer/protocol";
import { ComputerUseBridgeError } from "./computer-use-bridge-client.js";
import {
  ComputerAppError,
  type ComputerAppOperationInspection,
  type ComputerAppProvider,
  type ComputerAppValue,
} from "./provider.js";

export const macosAppDefinitionId = "macos-app";

/**
 * The sentence a Mac without the desktop app answers with, everywhere.
 *
 * It names the Mac, which an ordinary computer app's sentence may not, for the
 * reason `computerUseDesktopMissingSentence` gives: this is a fact about the
 * computer rather than about one app on it, and `docs/computer-use.md` §3
 * fixes the wording.
 */
export const computerUseUnsupportedSentence =
  "Computer use needs the Opensteer desktop app on this Mac.";
export { computerUseDesktopMissingSentence } from "./computer-use-bridge-client.js";
export const computerUseScreenRecordingSentence =
  "Turn on macOS Screen Recording for Opensteer Computer Use.";
export const computerUseAccessibilitySentence =
  "Turn on macOS Accessibility for Opensteer Computer Use.";

export interface MacosAppProviderOptions {
  /**
   * The bridge's `permissions.get`, absent when this Runner has no bridge at
   * all. Absent is not "denied": it is a computer where the feature does not
   * exist, and the two say different sentences.
   */
  readonly permissions?: () => Promise<ComputerUsePermissions>;
}

/**
 * Computer use as `runner.integrations.status` sees it, and nothing else.
 *
 * It is a provider because readiness for every computer app rides one frame on
 * one cadence, and this app's readiness is two macOS grants the helper holds.
 * It deliberately cannot be invoked: `observe` and `act` reach the Mac on the
 * computer-use frame, carrying the session, the app identity and the access the
 * **Host** resolved, and an `invoke` naming this definition would be a call
 * with none of them — an app identity a caller chose rather than one an owner
 * approved. So the operations exist in the catalog for the tool rows and the
 * status entry, and the only answer here is a refusal.
 */
export function createMacosAppProvider(options: MacosAppProviderOptions = {}): ComputerAppProvider {
  const probe = options.permissions;

  return {
    definitionId: macosAppDefinitionId,
    platforms: ["darwin"],

    async inspect(): Promise<readonly ComputerAppOperationInspection[]> {
      const state = await readState();
      return operationNames().map((operation) => ({ ...state(operation), operation }));
    },

    invoke(): Promise<ComputerAppValue> {
      return Promise.reject(
        new ComputerAppError("unsupported", "Computer use operations do not go through invoke."),
      );
    },
  };

  async function readState(): Promise<PermissionsState> {
    if (!probe) {
      return () => ({
        detail: computerUseUnsupportedSentence,
        remedy: null,
        state: "unavailable",
      });
    }
    return probeState(probe);
  }
}

type OperationState = Omit<ComputerAppOperationInspection, "operation">;
/** What one operation's row says, which is not always the same for both. */
type PermissionsState = (operation: string) => OperationState;

async function probeState(probe: () => Promise<ComputerUsePermissions>): Promise<PermissionsState> {
  let permissions: ComputerUsePermissions;
  try {
    permissions = await probe();
  } catch (error) {
    // The bridge owns the diagnosis and its user-facing sentence. An
    // authenticated helper refusing a request is not an absent desktop app.
    const detail =
      error instanceof ComputerUseBridgeError
        ? error.message
        : "Computer use could not read its macOS permissions.";
    return () => ({
      detail,
      remedy: null,
      state: "unavailable",
    });
  }
  const screenRecording = permissions.screenRecording === "granted";
  const accessibility = permissions.accessibility === "granted";
  if (screenRecording && accessibility)
    return () => ({ detail: null, remedy: null, state: "ready" });
  // Neither operation can run without both grants — `act` ends by observing —
  // so neither is ever `ready` while one is missing. What differs is which one
  // each row names: with one grant missing there is one thing to switch on and
  // both rows say it, and with both missing each row names the grant its own
  // work needs first, so the two rows together show the person both switches
  // rather than hiding the second until the first is on.
  if (!screenRecording && !accessibility) {
    return (operation) =>
      operation === "act" ? accessibilityRequired() : screenRecordingRequired();
  }
  return screenRecording ? () => accessibilityRequired() : () => screenRecordingRequired();
}

function screenRecordingRequired(): OperationState {
  return {
    detail: computerUseScreenRecordingSentence,
    remedy: "screen-recording",
    state: "permission-required",
  };
}

function accessibilityRequired(): OperationState {
  return {
    detail: computerUseAccessibilitySentence,
    remedy: "accessibility",
    state: "permission-required",
  };
}

/**
 * The catalog's own operation names, so a definition that gains one is
 * reported rather than silently missing from the status entry.
 */
function operationNames(): readonly string[] {
  const definition = getIntegrationDefinition(macosAppDefinitionId);
  if (!definition || !isComputerAppDefinition(definition)) return [];
  return definition.config.operations.map(({ name }) => name);
}
