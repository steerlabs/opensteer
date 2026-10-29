import type { ExecutionSelection } from "@opensteer/client/host";

interface PickerAttempt {
  readonly resolve: (selection: ExecutionSelection | null) => void;
  finishing: boolean;
}

const attempts = new Map<string, PickerAttempt>();
let nextAttempt = 0;

/** A Send is tied to one picker visit, not to future execution preferences. */
export function beginFirstMessagePickerAttempt(): {
  readonly id: string;
  readonly result: Promise<ExecutionSelection | null>;
} {
  const id = `first-message-picker:${++nextAttempt}`;
  let resolveResult: (selection: ExecutionSelection | null) => void = () => undefined;
  const result = new Promise<ExecutionSelection | null>((resolve) => {
    resolveResult = resolve;
  });
  attempts.set(id, { finishing: false, resolve: resolveResult });
  return { id, result };
}

/** Closing the sheet records its last choice, including an in-flight Host acknowledgement. */
export function finishFirstMessagePickerAttempt(
  id: string,
  choice: ExecutionSelection | Promise<ExecutionSelection | null> | null,
): void {
  const attempt = attempts.get(id);
  if (attempt === undefined || attempt.finishing) return;
  attempt.finishing = true;
  void Promise.resolve(choice)
    .catch(() => null)
    .then((selection) => {
      if (attempts.get(id) !== attempt) return;
      attempts.delete(id);
      attempt.resolve(selection);
    });
}

/** Editing or leaving the draft withdraws a Send even if the picker is still saving. */
export function cancelFirstMessagePickerAttempt(id: string): void {
  const attempt = attempts.get(id);
  if (attempt === undefined) return;
  attempts.delete(id);
  attempt.resolve(null);
}
