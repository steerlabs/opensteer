import type { RequestFormField } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  chooseQuestionOption,
  emptyQuestionDraft,
  isQuestionOptionChosen,
  questionAnswer,
  questionStep,
  typeQuestionAnswer,
  withQuestionDraft,
  type QuestionDrafts,
} from "./question-answers.js";

const field = (id: string, overrides: Partial<RequestFormField> = {}): RequestFormField => ({
  choices: [
    { label: "Batches", value: "Batches" },
    { label: "All at once", value: "All at once" },
  ],
  custom: true,
  id,
  multiSelect: false,
  prompt: `Question ${id}`,
  secret: false,
  ...overrides,
});

describe("question answers", () => {
  it("answers with whichever the person did last: chose, or typed", () => {
    const q = field("q");
    const chosen = chooseQuestionOption(q, emptyQuestionDraft, "Batches");
    expect(questionAnswer(q, chosen)).toEqual(["Batches"]);
    const typed = typeQuestionAnswer(q, chosen, "  Run 2023 first ");
    expect(isQuestionOptionChosen(typed, "Batches")).toBe(false);
    expect(questionAnswer(q, typed)).toEqual(["Run 2023 first"]);
    expect(questionAnswer(q, chooseQuestionOption(q, typed, "All at once"))).toEqual([
      "All at once",
    ]);
    // Clearing the words gives the choice back rather than leaving nothing.
    expect(questionAnswer(q, typeQuestionAnswer(q, chosen, ""))).toEqual(["Batches"]);
  });

  it("never types into a question that takes only its options", () => {
    const fixed = field("q", { custom: false });
    expect(typeQuestionAnswer(fixed, emptyQuestionDraft, "Tonight")).toBe(emptyQuestionDraft);
    expect(questionAnswer(fixed, emptyQuestionDraft)).toBeNull();
  });

  it("keeps several choices in the order they were offered", () => {
    const many = field("q", { multiSelect: true });
    const draft = chooseQuestionOption(
      many,
      chooseQuestionOption(many, emptyQuestionDraft, "All at once"),
      "Batches",
    );
    expect(questionAnswer(many, draft)).toEqual(["Batches", "All at once"]);
    expect(questionAnswer(many, chooseQuestionOption(many, draft, "Batches"))).toEqual([
      "All at once",
    ]);
  });

  it("steps to the next unanswered question, and sends only once all are answered", () => {
    const fields = [field("a"), field("b", { choices: undefined }), field("c")];
    let drafts: QuestionDrafts = {};
    expect(questionStep(fields, drafts, 0)).toEqual({ kind: "blocked" });
    drafts = withQuestionDraft(
      drafts,
      "a",
      chooseQuestionOption(fields[0]!, emptyQuestionDraft, "Batches"),
    );
    expect(questionStep(fields, drafts, 0)).toEqual({ kind: "next", index: 1 });
    drafts = withQuestionDraft(
      drafts,
      "c",
      chooseQuestionOption(fields[2]!, emptyQuestionDraft, "Batches"),
    );
    // Answering the last one first goes back to the gap rather than sending.
    expect(questionStep(fields, drafts, 2)).toEqual({ kind: "next", index: 1 });
    drafts = withQuestionDraft(
      drafts,
      "b",
      typeQuestionAnswer(fields[1]!, emptyQuestionDraft, "Tuesday"),
    );
    expect(questionStep(fields, drafts, 1)).toEqual({
      kind: "send",
      answers: { a: ["Batches"], b: ["Tuesday"], c: ["Batches"] },
    });
  });
});
