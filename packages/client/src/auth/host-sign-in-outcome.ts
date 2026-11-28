/** Why signing in to a Host at its own address ended without a usable credential. */
export interface HostSignInFailure {
  readonly status: "update-required" | "sign-in-required" | "suppressed";
  readonly error?: unknown;
}

export class HostSignInOutcomeError extends Error {
  readonly outcome: HostSignInFailure;
  constructor(outcome: HostSignInFailure) {
    super(
      outcome.error instanceof Error
        ? outcome.error.message
        : outcome.status === "sign-in-required"
          ? "Sign in to this Home."
          : "The sign-in changed. Try again.",
    );
    this.outcome = outcome;
  }
}
