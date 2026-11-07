/**
 * Where setup stands on this computer, so quitting in the middle (or macOS
 * asking to reopen after a permission) brings the person back to the same
 * step instead of a finished-looking app. It is a navigation memory, not a
 * record of what was set up: every step reads its own state live.
 */
export type SetupStepId = "ai" | "permissions" | "phone";

const steps: readonly SetupStepId[] = ["ai", "permissions", "phone"];

function key(deploymentId: string): string {
  return `opensteer.setup.v1:${deploymentId}`;
}

export function pendingSetupStep(deploymentId: string): SetupStepId | null {
  try {
    const value = localStorage.getItem(key(deploymentId));
    return steps.find((step) => step === value) ?? null;
  } catch {
    return null;
  }
}

export function rememberSetupStep(deploymentId: string, step: SetupStepId): void {
  try {
    localStorage.setItem(key(deploymentId), step);
  } catch {
    // Without storage the step is simply not resumed; setup still works.
  }
}

export function forgetSetup(deploymentId: string): void {
  try {
    localStorage.removeItem(key(deploymentId));
  } catch {
    // Nothing to forget.
  }
}

/**
 * The steps that apply here, in order. A remembered step that no longer
 * applies resumes at the next one that does.
 */
export function setupSteps(input: {
  readonly mac: boolean;
  readonly onThisComputer: boolean;
}): readonly SetupStepId[] {
  return steps.filter(
    (step) =>
      step === "ai" ||
      (step === "permissions" && input.onThisComputer && input.mac) ||
      (step === "phone" && input.onThisComputer),
  );
}

export function resumeStep(
  applicable: readonly SetupStepId[],
  remembered: SetupStepId | null,
): SetupStepId {
  if (remembered === null) return applicable[0]!;
  const from = steps.indexOf(remembered);
  return applicable.find((step) => steps.indexOf(step) >= from) ?? applicable.at(-1)!;
}
