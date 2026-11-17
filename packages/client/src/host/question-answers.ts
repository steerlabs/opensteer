import {
  hasSecretRequestFields,
  requestFieldAnswerProblem,
  type Request,
  type RequestFormAnswers,
  type RequestFormField,
} from "@opensteer/core";

/**
 * A question an agent asked, answered in the composer: its options dock above
 * the field, and what the person types there is their own answer. Engines'
 * native questions and `ask_person` read the same way; a form that collects a
 * secret, or a plugin's input, keeps its own fields.
 */
export function isQuestionRequest(request: Pick<Request, "kind" | "presentation">): boolean {
  return (
    request.presentation.kind === "form" &&
    (request.kind === "harness.input" || request.kind === "person.question") &&
    !hasSecretRequestFields(request)
  );
}

/** One question's answer while it is being given: options chosen, or words typed instead. */
export interface QuestionDraft {
  readonly selected: readonly string[];
  readonly typed: string;
}

export const emptyQuestionDraft: QuestionDraft = Object.freeze({ selected: [], typed: "" });

export type QuestionDrafts = Readonly<Record<string, QuestionDraft>>;

export function questionDraft(drafts: QuestionDrafts, fieldId: string): QuestionDraft {
  return Object.hasOwn(drafts, fieldId) ? drafts[fieldId]! : emptyQuestionDraft;
}

/** The drafts with one question's replaced, as an own property whatever its agent-chosen id. */
export function withQuestionDraft(
  drafts: QuestionDrafts,
  fieldId: string,
  draft: QuestionDraft,
): QuestionDrafts {
  const next: Record<string, QuestionDraft> = { ...drafts };
  Object.defineProperty(next, fieldId, {
    configurable: true,
    enumerable: true,
    value: draft,
    writable: true,
  });
  return next;
}

/** Whether the composer can hold this question's answer: an open question, or one offering "your own". */
export function questionTakesTyping(field: RequestFormField): boolean {
  return field.choices === undefined || field.custom;
}

/**
 * Choosing an option clears anything typed, as typing clears the choice: the
 * answer is whichever the person did last. A single choice replaces the last;
 * several keep the order they were offered in.
 */
export function chooseQuestionOption(
  field: RequestFormField,
  draft: QuestionDraft,
  value: string,
): QuestionDraft {
  const offered = field.choices?.map((choice) => choice.value) ?? [];
  if (!offered.includes(value)) return draft;
  if (!field.multiSelect) return { selected: [value], typed: "" };
  const chosen = new Set(draft.typed.trim() === "" ? draft.selected : []);
  if (chosen.has(value)) chosen.delete(value);
  else chosen.add(value);
  return { selected: offered.filter((option) => chosen.has(option)), typed: "" };
}

export function typeQuestionAnswer(
  field: RequestFormField,
  draft: QuestionDraft,
  typed: string,
): QuestionDraft {
  if (!questionTakesTyping(field)) return draft;
  return { selected: typed.trim() === "" ? draft.selected : [], typed };
}

/** Whether an option shows as chosen: never while typed words stand in for the choices. */
export function isQuestionOptionChosen(draft: QuestionDraft, value: string): boolean {
  return draft.typed.trim() === "" && draft.selected.includes(value);
}

/** What this question's answer would be sent as, or null while it has none the Host would take. */
export function questionAnswer(field: RequestFormField, draft: QuestionDraft): string[] | null {
  const typed = draft.typed.trim();
  const values = typed !== "" && questionTakesTyping(field) ? [typed] : [...draft.selected];
  return requestFieldAnswerProblem(field, values) === null ? values : null;
}

/** Every question's answer, or null while any is unanswered. */
export function questionFormAnswers(
  fields: readonly RequestFormField[],
  drafts: QuestionDrafts,
): RequestFormAnswers | null {
  const answers: Record<string, string[]> = {};
  for (const field of fields) {
    const answer = questionAnswer(field, questionDraft(drafts, field.id));
    if (answer === null) return null;
    Object.defineProperty(answers, field.id, { enumerable: true, value: answer });
  }
  return answers;
}

/**
 * Where answering goes from the question at `index`: on to the next, or the
 * whole form sent once every question has its answer. With one still empty
 * further back, it goes there instead of sending a form the Host would refuse.
 */
export type QuestionStep =
  | { readonly kind: "blocked" }
  | { readonly kind: "next"; readonly index: number }
  | { readonly kind: "send"; readonly answers: RequestFormAnswers };

export function questionStep(
  fields: readonly RequestFormField[],
  drafts: QuestionDrafts,
  index: number,
): QuestionStep {
  const field = fields[index];
  if (field === undefined || questionAnswer(field, questionDraft(drafts, field.id)) === null)
    return { kind: "blocked" };
  const answers = questionFormAnswers(fields, drafts);
  if (answers !== null) return { kind: "send", answers };
  const later = fields.findIndex(
    (candidate, position) =>
      position > index && questionAnswer(candidate, questionDraft(drafts, candidate.id)) === null,
  );
  const unanswered =
    later >= 0
      ? later
      : fields.findIndex(
          (candidate) => questionAnswer(candidate, questionDraft(drafts, candidate.id)) === null,
        );
  return { kind: "next", index: unanswered };
}
