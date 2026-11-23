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
  detailFormat: z.enum(["plain"]).optional(),
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

export const PersonQuestionOptionSchema = z.object({
  label: z.string().max(requestTextMaxLength),
  description: z.string().max(requestTextMaxLength).optional(),
});
export type PersonQuestionOption = z.infer<typeof PersonQuestionOptionSchema>;

export const PendingQuestionSchema = z.object({
  outcome: z.literal("pending"),
  detail: z.string().max(requestTextMaxLength).optional(),
  questions: z
    .array(
      z.object({
        prompt: z.string().max(requestTextMaxLength),
        options: z.array(PersonQuestionOptionSchema).max(100).optional(),
        multiSelect: z.literal(true).optional(),
      }),
    )
    .max(16),
  truncated: z.literal(true).optional(),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

export const SettledPersonQuestionSchema = z.object({
  outcome: z.enum(["answered", "dismissed"]),
  detail: z.string().max(requestTextMaxLength).optional(),
  answers: z
    .array(
      z.object({
        prompt: z.string().max(requestTextMaxLength),
        options: z.array(PersonQuestionOptionSchema).max(100).optional(),
        multiSelect: z.literal(true).optional(),
        answer: z.array(z.string().max(100_000)).max(100),
      }),
    )
    .max(16),
  truncated: z.literal(true).optional(),
});
export type SettledPersonQuestion = z.infer<typeof SettledPersonQuestionSchema>;

export const PersonQuestionRecordSchema = z.union([
  PendingQuestionSchema,
  SettledPersonQuestionSchema,
]);
export type PersonQuestionRecord = z.infer<typeof PersonQuestionRecordSchema>;

/**
 * A non-secret `person.question` record, pending or settled, shared by agent read surfaces.
 * Returns null for other Request kinds, cancelled/withdrawn asks, or forms with secret fields.
 */
export function personQuestionRecord(
  request: Pick<Request, "kind" | "presentation" | "response" | "status">,
): PersonQuestionRecord | null {
  if (
    request.kind !== "person.question" ||
    request.presentation.kind !== "form" ||
    hasSecretRequestFields(request)
  )
    return null;
  const { detail, fields } = request.presentation;
  const optionsFor = (field: (typeof fields)[number]): PersonQuestionOption[] | undefined =>
    field.choices?.length
      ? field.choices.map((choice) => ({
          label: choice.label,
          ...(choice.description ? { description: choice.description } : {}),
        }))
      : undefined;
  if (request.status === "pending") {
    return {
      ...(detail ? { detail } : {}),
      outcome: "pending",
      questions: fields.map((field) => {
        const options = optionsFor(field);
        return {
          prompt: field.prompt,
          ...(options ? { options } : {}),
          ...(field.multiSelect ? { multiSelect: true as const } : {}),
        };
      }),
    };
  }
  const settled = answeredQuestion(request);
  if (!settled) return null;
  return {
    ...settled,
    answers: settled.answers.map((entry, index) => {
      const field = fields[index];
      const options = field ? optionsFor(field) : undefined;
      return {
        ...entry,
        ...(options ? { options } : {}),
        ...(field?.multiSelect ? { multiSelect: true as const } : {}),
      };
    }),
  };
}

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
  const { detail, detailFormat, fields } = request.presentation;
  const asked = { ...(detail ? { detail } : {}), ...(detailFormat ? { detailFormat } : {}) };
  // A dismissal keeps what was asked, with no answer to any of it.
  if (request.status === "declined")
    return {
      ...asked,
      outcome: "dismissed",
      answers: fields.map(({ prompt }) => ({ prompt, answer: [] })),
    };
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

/** The most a settled question's record adds to its thread card, beside the card's own view. */
export const answeredQuestionPreviewBytes = 3 * 1024;

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
  const rest: AnsweredQuestion = {
    outcome: question.outcome,
    answers,
    truncated: true,
    ...(question.detailFormat ? { detailFormat: question.detailFormat } : {}),
  };
  if (question.detail === undefined) return rest;
  let detail = utf8Prefix(question.detail, Math.max(0, maxBytes - bytes(rest)));
  while (detail && bytes({ ...rest, detail }) > maxBytes)
    detail = utf8Prefix(detail, Math.floor(utf8ByteLength(detail) / 2));
  return detail ? { ...rest, detail } : rest;
}

/** Bounds a pending or settled `person.question` record to `maxBytes` of JSON. */
export function personQuestionRecordWithin(
  record: PersonQuestionRecord,
  maxBytes: number,
): PersonQuestionRecord {
  const bytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));
  if (bytes(record) <= maxBytes) return record;
  const boundOptions = (options?: readonly PersonQuestionOption[]) =>
    options?.length
      ? options.map((option) => ({
          label: utf8Prefix(option.label, answerPreviewBytes),
          ...(option.description
            ? { description: utf8Prefix(option.description, answerPreviewBytes) }
            : {}),
        }))
      : undefined;
  const fitDetail = <T extends { detail?: string | undefined }>(rest: T, detail?: string): T => {
    if (detail === undefined) return rest;
    let trimmed = utf8Prefix(detail, Math.max(0, maxBytes - bytes(rest)));
    while (trimmed && bytes({ ...rest, detail: trimmed }) > maxBytes)
      trimmed = utf8Prefix(trimmed, Math.floor(utf8ByteLength(trimmed) / 2));
    return trimmed ? { ...rest, detail: trimmed } : rest;
  };
  if (record.outcome === "pending") {
    const questions: PendingQuestion["questions"] = [];
    for (const q of record.questions) {
      const options = boundOptions(q.options);
      const entry: PendingQuestion["questions"][number] = {
        prompt: utf8Prefix(q.prompt, promptPreviewBytes),
        ...(options ? { options } : {}),
        ...(q.multiSelect ? { multiSelect: true as const } : {}),
      };
      questions.push(entry);
      if (bytes(questions) > maxBytes / 2) {
        if (entry.options) {
          delete entry.options;
          if (bytes(questions) <= maxBytes / 2) continue;
        }
        questions.pop();
        break;
      }
    }
    return fitDetail<PendingQuestion>(
      { outcome: "pending", questions, truncated: true },
      record.detail,
    );
  }
  const answers: SettledPersonQuestion["answers"] = [];
  for (const item of record.answers) {
    const options = boundOptions(item.options);
    const kept: SettledPersonQuestion["answers"][number] = {
      prompt: utf8Prefix(item.prompt, promptPreviewBytes),
      ...(options ? { options } : {}),
      ...(item.multiSelect ? { multiSelect: true as const } : {}),
      answer: [],
    };
    answers.push(kept);
    if (bytes(answers) > maxBytes / 2 && kept.options) delete kept.options;
    for (const value of item.answer) {
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
  return fitDetail<SettledPersonQuestion>(
    { outcome: record.outcome, answers, truncated: true },
    record.detail,
  );
}

function formatQuestionOptions(options?: readonly PersonQuestionOption[]): string {
  if (!options?.length) return "";
  const formatted = options.map((option) =>
    option.description ? `${option.label} — ${option.description}` : option.label,
  );
  return `\nOptions: ${formatted.join(" | ")}`;
}

/** Renders a non-secret `person.question` record canonically for agent timelines. */
export function formatPersonQuestionRecord(record: PersonQuestionRecord): string {
  const parts: string[] = [];
  if (record.detail) parts.push(record.detail);
  if (record.outcome === "pending") {
    for (const q of record.questions) {
      parts.push(`Question: ${q.prompt}${formatQuestionOptions(q.options)}`);
    }
    parts.push("Status: pending");
  } else if (record.outcome === "dismissed") {
    for (const q of record.answers) {
      parts.push(`Question: ${q.prompt}${formatQuestionOptions(q.options)}`);
    }
    parts.push("Dismissed by the person without answering.");
  } else {
    for (const q of record.answers) {
      const answer = q.answer.length ? q.answer.join(", ") : "(no answer)";
      parts.push(`Question: ${q.prompt}${formatQuestionOptions(q.options)}\nAnswer: ${answer}`);
    }
  }
  return parts.join("\n\n");
}
