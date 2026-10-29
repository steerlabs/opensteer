import {
  DesktopPasswordsSignInCardStateSchema,
  type DesktopPasswordsSignInApproveInput,
  type DesktopPasswordsSignInApproveResult,
  type DesktopPasswordsSignInCardChanged,
  type DesktopPasswordsSignInCardState,
} from "@opensteer/protocol/desktop";

export interface PasswordsSignInOperation {
  readonly state: () => DesktopPasswordsSignInCardState;
  readonly approve: (
    input: DesktopPasswordsSignInApproveInput,
  ) => Promise<DesktopPasswordsSignInApproveResult>;
}

/** The card sees metadata and controls only, never the released credential. */
export class PasswordsSignInOperations {
  readonly #operations = new Map<string, PasswordsSignInOperation>();
  readonly #listeners = new Set<(change: DesktopPasswordsSignInCardChanged) => void>();

  register(
    operationId: string,
    operation: PasswordsSignInOperation,
  ): { changed: () => void; unregister: () => void } {
    if (this.#operations.has(operationId)) throw new Error("That sign-in is already running.");
    this.#operations.set(operationId, operation);
    return {
      changed: () => this.#changed(operationId),
      unregister: () => {
        this.#operations.delete(operationId);
        this.#changed(operationId);
      },
    };
  }

  get(operationId: string): DesktopPasswordsSignInCardState {
    return DesktopPasswordsSignInCardStateSchema.parse(
      this.#operations.get(operationId)?.state() ?? { stage: "gone" },
    );
  }

  approve(input: DesktopPasswordsSignInApproveInput): Promise<DesktopPasswordsSignInApproveResult> {
    return this.#require(input.operationId).approve(input);
  }

  subscribe(listener: (change: DesktopPasswordsSignInCardChanged) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #require(operationId: string): PasswordsSignInOperation {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error("That sign-in is no longer running.");
    return operation;
  }

  #changed(operationId: string): void {
    const state = this.get(operationId);
    for (const listener of this.#listeners) listener({ operationId, state });
  }
}
