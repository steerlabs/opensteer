/**
 * The contract between the `integrations` module handler and one app on this
 * computer.
 *
 * A provider owns exactly one definition and answers for itself: the handler
 * never reasons about Messages, Notes or anything else, and a provider never
 * learns which Workspace asked. Arguments arrive already validated against the
 * catalog's `inputSchema`, so the provider's own narrowing is the second of two
 * checks rather than the only one — but it is still mandatory, because a
 * provider that trusted the shape it was handed would turn a Host bug into a
 * malformed SQL parameter or an AppleScript argument.
 */

import type {
  ComputerAppErrorCode,
  ComputerAppRemedy,
  ComputerAppState,
} from "@opensteer/protocol";
import type { z } from "zod";

/**
 * `busy` is the handler's answer, never a provider's: it is a fact about how
 * much this computer is already doing, which one app cannot know.
 */
export type ComputerAppProviderErrorCode = Exclude<ComputerAppErrorCode, "busy">;

/** The JSON a provider may answer with, which is what the frame can carry. */
export type ComputerAppValue = z.infer<ReturnType<typeof z.json>>;

/**
 * The only error a provider raises on purpose. Anything else that escapes is
 * `failed` with a bounded, path-free message, so a provider that throws a raw
 * `Error` degrades safely rather than leaking a stack or a home directory.
 */
export class ComputerAppError extends Error {
  // Assigned rather than declared as a constructor parameter property, which
  // this repository's `erasableSyntaxOnly` forbids.
  readonly code: ComputerAppProviderErrorCode;

  constructor(code: ComputerAppProviderErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ComputerAppError";
  }
}

export interface ComputerAppOperationInspection {
  readonly operation: string;
  readonly state: ComputerAppState;
  readonly detail: string | null;
  readonly remedy: ComputerAppRemedy | null;
}

/**
 * What the Host resolved for one call, beyond its arguments: the access the
 * connection and the calling grant allow together, the contract it expects
 * this build to implement, and the operation's effect. The handler has already
 * refused a write under `read` and a contract it does not share; a provider
 * that hands the call to another process passes these on, so that process can
 * refuse the same things itself.
 */
export interface ComputerAppInvocation {
  readonly access: "read" | "read-write";
  readonly contract: string;
  /** When the call must be answered by, in this process's clock. */
  readonly deadline: number;
  readonly effect: "read" | "write";
}

export interface ComputerAppProvider {
  readonly definitionId: string;
  readonly platforms: readonly NodeJS.Platform[];
  /**
   * What this app's state is right now. Cheap and side-effect free: it is
   * polled on a cadence and must never prompt the person at the computer.
   */
  inspect(): Promise<readonly ComputerAppOperationInspection[]>;
  /** Resolves with a JSON value, or rejects with a {@link ComputerAppError}. */
  invoke(
    operation: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    invocation: ComputerAppInvocation,
  ): Promise<ComputerAppValue>;
}

/** The longest sentence a provider may put in front of a person. */
export const computerAppMessageMaxLength = 300;
