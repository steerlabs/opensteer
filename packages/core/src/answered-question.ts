import { z } from "zod";
import { hasSecretRequestFields, requestTextMaxLength, type Request } from "./requests.js";
import { utf8ByteLength, utf8Prefix } from "./tool-output.js";

/**
 * What an agent asked the person with `ask_person` and what came back, as the
 * task's thread keeps it once the question is settled.
 */
export const AnsweredQuestionSchema = z.object({
  /** Dismissed is the person's no to the whole question: it carries no answers. */
  outcome: z.enum(["answered", "dismissed"]),
  detail: z.string().max(requestTextMaxLength).optional(),
  /** One per question, in the order asked: chosen labels, or the words typed instead. */
  answers: z
    .array(
      z.object({
        prompt: z.string().max(requestTextMaxLength),
        answer: z.array(z.string().max(100_000)).max(100),
      }),
    )
    .max(16),
  /** Parts were cut to fit the thread; the Request still holds them whole. */
  truncated: z.literal(true).optional(),
});
export type AnsweredQuestion = z.infer<typeof AnsweredQuestionSchema>;

/**
 * A settled question's record, or null for anything else: another kind, one
 * still open, cancelled or withdrawn, or one with a secret field, whose answer
 * is never shown again.
 */
export function answeredQuestion(
  request: Pick<Request, "kind" | "presentation" | "response" | "status">,
): AnsweredQuestion | null {
  if (
    request.kind !== "person.question" ||
    request.presentation.kind !== "form" ||
    hasSecretRequestFields(request)
  )
    return null;
  const { detail, fields } = request.presentation;
  const asked = detail ? { detail } : {};
  if (request.status === "declined") return { ...asked, outcome: "dismissed", answers: [] };
  if (request.status !== "fulfilled" || request.response?.kind !== "form") return null;
  const { answers } = request.response;
  return {
    ...asked,
    outcome: "answered",
    answers: fields.map((field) => ({
      prompt: field.prompt,
      // Answers are stored as choice values; a value no choice has is typed words.
      answer: (Object.hasOwn(answers, field.id) ? answers[field.id]! : []).map(
        (value) => field.choices?.find((choice) => choice.value === value)?.label ?? value,
      ),
    })),
  };
}

const promptPreviewBytes = 200;
const answerPreviewBytes = 400;

/**
 * The record cut to `maxBytes` of JSON. The answers keep their questions'
 * order and take at most half; the detail gets the rest.
 */
export function answeredQuestionWithin(
  question: AnsweredQuestion,
  maxBytes: number,
): AnsweredQuestion {
  const bytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));
  if (bytes(question) <= maxBytes) return question;
  const answers: { prompt: string; answer: string[] }[] = [];
  for (const { prompt, answer } of question.answers) {
    const kept = { prompt: utf8Prefix(prompt, promptPreviewBytes), answer: [] as string[] };
    answers.push(kept);
    for (const value of answer) {
      kept.answer.push(utf8Prefix(value, answerPreviewBytes));
      if (bytes(answers) > maxBytes / 2) {
        kept.answer.pop();
        break;
      }
    }
    if (bytes(answers) > maxBytes / 2) {
      answers.pop();
      break;
    }
  }
  const rest: AnsweredQuestion = { outcome: question.outcome, answers, truncated: true };
  if (question.detail === undefined) return rest;
  let detail = utf8Prefix(question.detail, Math.max(0, maxBytes - bytes(rest)));
  while (detail && bytes({ ...rest, detail }) > maxBytes)
    detail = utf8Prefix(detail, Math.floor(utf8ByteLength(detail) / 2));
  return detail ? { ...rest, detail } : rest;
}
