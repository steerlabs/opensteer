import { describe, expect, it } from "vitest";
import { answeredQuestion, answeredQuestionWithin } from "./answered-question.js";
import { createId } from "./ids.js";
import { RequestSchema, type Request } from "./requests.js";
import { utf8ByteLength } from "./tool-output.js";

const at = "2026-11-19T21:01:05.000Z";
const draft = "```draft\nHey Sha, would you be open to a quick chat?\n```";

function question(settled: Record<string, unknown>, secret = false): Request {
  const userId = createId("user");
  return RequestSchema.parse({
    callId: "ask",
    cancellationReason: null,
    createdAt: at,
    id: createId("request"),
    kind: "person.question",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    payload: { kind: "person.question" },
    presentation: {
      kind: "form",
      title: "Send this DM to Sha?",
      detail: draft,
      fields: [
        {
          choices: [
            { label: "Yes, send it", value: "yes" },
            { label: "No", value: "no" },
          ],
          custom: true,
          id: "question_1",
          multiSelect: false,
          prompt: "Send it from your main account?",
          secret,
        },
        {
          choices: [
            { label: "CRM", value: "crm" },
            { label: "Notes", value: "notes" },
          ],
          custom: false,
          id: "question_2",
          multiSelect: true,
          prompt: "Where should I log it?",
          secret: false,
        },
      ],
    },
    requestedBy: userId,
    requiredActor: "requester",
    resolvedAt: at,
    resolvedBy: userId,
    ...settled,
  });
}

const answered = (answers: Record<string, string[]>) =>
  question({ status: "fulfilled", response: { kind: "form", answers } });

describe("answered questions", () => {
  it("pairs each question with its answer: chosen labels, several in order, typed words as typed", () => {
    expect(
      answeredQuestion(answered({ question_1: ["yes"], question_2: ["crm", "notes"] })),
    ).toEqual({
      outcome: "answered",
      detail: draft,
      answers: [
        { prompt: "Send it from your main account?", answer: ["Yes, send it"] },
        { prompt: "Where should I log it?", answer: ["CRM", "Notes"] },
      ],
    });
    expect(
      answeredQuestion(answered({ question_1: ["Send it Monday"], question_2: ["crm"] }))
        ?.answers[0],
    ).toEqual({ prompt: "Send it from your main account?", answer: ["Send it Monday"] });
  });

  it("keeps a dismissal with what was asked and no answers", () => {
    expect(
      answeredQuestion(
        question({
          status: "declined",
          response: { kind: "external", value: { decision: "declined" } },
        }),
      ),
    ).toEqual({ outcome: "dismissed", detail: draft, answers: [] });
  });

  it("keeps nothing for a question never answered, or one whose answer is secret", () => {
    expect(
      answeredQuestion(
        question({
          status: "cancelled",
          cancellationReason: "process-lost",
          resolvedBy: null,
          response: null,
        }),
      ),
    ).toBeNull();
    expect(
      answeredQuestion(
        question(
          { status: "fulfilled", response: { kind: "form", answers: { question_2: ["crm"] } } },
          true,
        ),
      ),
    ).toBeNull();
  });

  it("fits the thread's budget, keeping the answers' order and marking what it cut", () => {
    const whole = answeredQuestion(
      answered({ question_1: ["x".repeat(5_000)], question_2: ["crm"] }),
    )!;
    const long = { ...whole, detail: `${"Long draft. ".repeat(800)}` };
    expect(answeredQuestionWithin(long, 100_000)).toBe(long);

    const cut = answeredQuestionWithin(long, 3 * 1024);
    expect(utf8ByteLength(JSON.stringify(cut))).toBeLessThanOrEqual(3 * 1024);
    expect(cut.truncated).toBe(true);
    expect(cut.answers.map(({ prompt }) => prompt)).toEqual([
      "Send it from your main account?",
      "Where should I log it?",
    ]);
    expect(long.detail.startsWith(cut.detail!)).toBe(true);
    expect(cut.detail!.length).toBeGreaterThan(1_000);
  });
});
