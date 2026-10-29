import type { RequestFormAnswers, RequestFormField, RequestResponse } from "@opensteer/core";
import { canonicalJson } from "@opensteer/shared/canonicalJson";

/**
 * How a field is answered: one choice, any number of choices, typed text, or
 * not at all. A field whose `choices` is present but empty is `unavailable`:
 * the Host accepts only offered values for it, and none are offered, so no
 * answer typed here or anywhere else would be taken.
 */
export type RequestFieldMode = "one" | "many" | "text" | "unavailable";

/** The Host's limit on one answer value (`RequestFormAnswersSchema`). */
export const requestAnswerMaxLength = 100_000;

export type RequestFormDraft = Readonly<Record<string, readonly string[]>>;

export function requestFieldMode(field: RequestFormField): RequestFieldMode {
  // The current response record parser drops this reserved key. Do not offer
  // a response that the Host cannot receive, even though draft storage is safe.
  if (field.id === "__proto__") return "unavailable";
  if (field.choices === undefined) return "text";
  if (field.choices.length === 0) return "unavailable";
  return field.multiSelect ? "many" : "one";
}

/**
 * A field's draft values. Field ids are agent-chosen strings, so `constructor`
 * must not read through to the prototype, even for an unavailable field.
 */
export function requestDraftValues(draft: RequestFormDraft, fieldId: string): readonly string[] {
  return Object.hasOwn(draft, fieldId) ? draft[fieldId]! : [];
}

/** The draft with one field replaced, as an own property whatever its id. */
export function withRequestDraftValues(
  draft: RequestFormDraft,
  fieldId: string,
  values: readonly string[],
): Record<string, readonly string[]> {
  const next: Record<string, readonly string[]> = { ...draft };
  Object.defineProperty(next, fieldId, {
    configurable: true,
    enumerable: true,
    value: values,
    writable: true,
  });
  return next;
}

/**
 * The next selection after a tap. A chosen radio stays chosen, because a
 * single-choice field has no empty state to return to once answered. A
 * multi-choice selection keeps the order the choices were offered in, which
 * is the order a person reads them back in, whatever order they were tapped.
 */
export function toggleRequestChoice(
  field: RequestFormField,
  current: readonly string[],
  value: string,
): string[] {
  if (requestFieldMode(field) !== "many") return [value];
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return [...new Set((field.choices ?? []).map((choice) => choice.value))].filter((offered) =>
    next.has(offered),
  );
}

/**
 * Whether a field's draft would be accepted as its answer. Whitespace alone is
 * not an answer: the Host would take it, and the agent would act on nothing.
 */
export function isRequestFieldAnswered(
  field: RequestFormField,
  values: readonly string[],
): boolean {
  if (values.length === 0) return false;
  switch (requestFieldMode(field)) {
    case "text":
      return (
        values.length === 1 &&
        values[0]!.trim() !== "" &&
        values[0]!.length <= requestAnswerMaxLength
      );
    case "one":
      return values.length === 1 && hasChoice(field, values[0]!);
    case "many":
      return values.every((value) => hasChoice(field, value));
    case "unavailable":
      return false;
  }
}

function hasChoice(field: RequestFormField, value: string): boolean {
  return field.choices?.some((choice) => choice.value === value) ?? false;
}

export interface RequestFormProgress {
  readonly answered: number;
  readonly complete: boolean;
  readonly total: number;
  /** Fields nobody can answer, which keep the form from ever being sent. */
  readonly unavailable: number;
}

export function requestFormProgress(
  fields: readonly RequestFormField[],
  draft: RequestFormDraft,
): RequestFormProgress {
  const answered = fields.filter((field) =>
    isRequestFieldAnswered(field, requestDraftValues(draft, field.id)),
  ).length;
  const unavailable = fields.filter((field) => requestFieldMode(field) === "unavailable").length;
  return { answered, complete: answered === fields.length, total: fields.length, unavailable };
}

/** What the footer says beside Send: how far the form is from sendable. */
export function requestFormProgressLabel(progress: RequestFormProgress): string {
  if (progress.unavailable > 0) {
    if (progress.total === 1) return "This question cannot be answered";
    return progress.unavailable === 1
      ? "A question cannot be answered"
      : `${progress.unavailable} questions cannot be answered`;
  }
  if (progress.total === 1) return progress.complete ? "Answered" : "Not answered yet";
  return `${progress.answered} of ${progress.total} answered`;
}

/**
 * The answers the Host is sent: exactly one entry per field, as the Host
 * requires, so a draft can never carry a key the form does not ask for. Text
 * is sent as typed; only its emptiness and length are judged.
 */
export function requestFormAnswers(
  fields: readonly RequestFormField[],
  draft: RequestFormDraft,
): RequestFormAnswers | null {
  if (!requestFormProgress(fields, draft).complete) return null;
  return Object.fromEntries(
    fields.map((field) => [field.id, [...requestDraftValues(draft, field.id)]]),
  );
}

/** Whether two responses say the same thing. */
export function sameRequestResponse(left: RequestResponse, right: RequestResponse): boolean {
  if (left.kind === "choice" && right.kind === "choice") {
    return left.optionId === right.optionId && left.text === right.text;
  }
  if (left.kind === "form" && right.kind === "form") {
    const leftIds = Object.keys(left.answers);
    return (
      leftIds.length === Object.keys(right.answers).length &&
      leftIds.every((id) => {
        if (!Object.hasOwn(right.answers, id)) return false;
        const leftValues = left.answers[id]!;
        const rightValues = right.answers[id]!;
        return (
          leftValues.length === rightValues.length &&
          leftValues.every((value, index) => value === rightValues[index])
        );
      })
    );
  }
  if (left.kind === "external" && right.kind === "external") {
    if (left.value === undefined || right.value === undefined) return left.value === right.value;
    return canonicalJson(left.value) === canonicalJson(right.value);
  }
  return false;
}

export interface RequestSubmission {
  readonly idempotencyKey: string;
  readonly response: RequestResponse;
}

/**
 * The submission for a response, given the last one that did not settle.
 *
 * An unchanged response is a retry and keeps its key: the failure may have
 * been the reply that was lost, not the answer, and the Host treats a
 * repeated key as the same command. A changed response is a new command with
 * a new key, and it replaces the held one, so a later retry can never send an
 * answer the screen no longer shows.
 */
export function nextRequestSubmission(
  held: RequestSubmission | null,
  response: RequestResponse,
  mintKey: () => string,
): RequestSubmission {
  if (held !== null && sameRequestResponse(held.response, response)) return held;
  return { idempotencyKey: mintKey(), response };
}
