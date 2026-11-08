import type { HostSnapshot } from "@opensteer/client/host";
import {
  requestOptionDeclines,
  type Request,
  type RequestFormField,
  type RequestOption,
} from "@opensteer/core";
import { Alert } from "react-native";
import type { NativeMenuOption } from "./composer-menu.js";
import { requestFieldMode } from "./request-form-model.js";

/** The most answers a card holds before the choice belongs in a sheet. */
const cardAnswerLimit = 4;
/** Longer than this, or more of it, and a row of pills would wrap into a block. */
const pillLabelLimit = 16;
const pillTotalLimit = 30;
/** Past this a question takes over the composer rather than sitting above its field. */
const composerQuestionLength = 160;

/**
 * How a Request can be answered from its card, decided from what it asks and
 * never from where it is shown. Everything else opens the sheet.
 *
 * `approve` is a yes and a no with any other answers behind a menu. `choose`
 * and its two looks are answers where a tap sends. `type` is one open question
 * the composer can take. `sheet` is anything that has to be read or filled in.
 */
export type RequestCardAnswers =
  | {
      readonly kind: "approve";
      readonly allow: RequestOption;
      readonly decline: RequestOption;
      /** Asked again before it goes, because allowing it can't be taken back. */
      readonly highRisk: boolean;
      readonly more: readonly RequestOption[];
      /** The engine takes a reason with a refusal, so "say why" can reach it. */
      readonly takesReason: boolean;
    }
  | {
      readonly kind: "choose";
      readonly look: "pills" | "rows";
      readonly options: readonly CardChoice[];
    }
  | { readonly kind: "type"; readonly field: RequestFormField }
  | { readonly kind: "sheet"; readonly label: "Answer" | "Review" }
  | { readonly kind: "none" };

export interface CardChoice {
  readonly description?: string | undefined;
  readonly id: string;
  readonly label: string;
}

export function requestCardAnswers(request: Request, denied: boolean): RequestCardAnswers {
  const { presentation, payload } = request;
  if (denied || request.status !== "pending") return { kind: "none" };
  if (presentation.kind === "external") {
    return externalAnswerable(request) ? { kind: "sheet", label: "Review" } : { kind: "none" };
  }
  if (presentation.kind === "form") {
    const [field, ...others] = presentation.fields;
    // A plugin's answer never reaches the agent, and the sheet is what says so.
    if (field === undefined || others.length > 0 || payload.kind === "integration.input") {
      return { kind: "sheet", label: "Answer" };
    }
    const mode = requestFieldMode(field);
    // The composer holds a question and nothing else, so anything more needs the card.
    if (
      mode === "text" &&
      !field.secret &&
      (presentation.detail ?? "") === "" &&
      presentation.agentProposed !== true &&
      presentation.title.length + field.prompt.length <= composerQuestionLength
    ) {
      return { kind: "type", field };
    }
    if (mode === "one" && (field.choices?.length ?? 0) <= cardAnswerLimit) {
      return choose(
        (field.choices ?? []).map(({ description, label, value }) => ({
          description,
          id: value,
          label,
        })),
      );
    }
    return { kind: "sheet", label: "Answer" };
  }
  // Installing is a decision about a manifest the card has no room to show.
  if (payload.kind === "integration.install") return { kind: "sheet", label: "Review" };
  const allow = presentation.options.find(
    ({ hint }) => hint === "allow-once" || hint === "confirm",
  );
  const decline = presentation.options.find(requestOptionDeclines);
  if (allow !== undefined && decline !== undefined) {
    return {
      kind: "approve",
      allow,
      decline,
      highRisk: presentation.risk === "high",
      more: presentation.options.filter((option) => option !== allow && option !== decline),
      takesReason: request.kind === "harness.approval",
    };
  }
  return presentation.options.length <= cardAnswerLimit && presentation.risk !== "high"
    ? choose(presentation.options)
    : { kind: "sheet", label: "Answer" };
}

function choose(options: readonly CardChoice[]): RequestCardAnswers {
  const short =
    options.every(
      ({ description, label }) =>
        (description === undefined || description === "") && label.length <= pillLabelLimit,
    ) && options.reduce((total, { label }) => total + label.length, 0) <= pillTotalLimit;
  return { kind: "choose", look: short ? "pills" : "rows", options };
}

/** The kinds this client has a way to answer; anything newer waits for a computer. */
function externalAnswerable(request: Request): boolean {
  switch (request.payload.kind) {
    case "machine.full-disk-access":
    case "computer.app.access":
    case "browser.sign-in":
    case "browser.password-sign-in":
    case "browser.access":
      return true;
    default:
      return false;
  }
}

/**
 * An engine's own words for its two everyday answers, said the way the system
 * says them. Only a harness approval: anything else offering "allow" or
 * "reject" chose those words on purpose, such as an integration's Install.
 */
export function requestOptionLabel(request: Request, option: RequestOption): string {
  if (request.kind !== "harness.approval") return option.label;
  if (option.hint === "allow-once") return "Allow";
  if (option.hint === "reject-once") return "Don’t Allow";
  return option.label;
}

/** What engines title a form that has no words of its own; its questions say it all. */
const untitledForm = "More information needed";

/**
 * What a Request asks, and anything else its title says. A lone field's prompt
 * is the question when the title adds nothing, but a title can carry the whole
 * explanation, as ACP's does, and that stays in view.
 */
export function requestCardHeading(
  request: Request,
  title: string,
): { readonly context: string | null; readonly question: string } {
  const { presentation } = request;
  const prompt =
    presentation.kind === "form" && presentation.fields.length === 1
      ? (presentation.fields[0]?.prompt.trim() ?? "")
      : "";
  if (prompt === "" || prompt === title) return { context: null, question: title };
  return title === untitledForm
    ? { context: null, question: prompt }
    : { context: prompt, question: title };
}

/**
 * Engines that hand a person's reason for refusing back to the agent. A protocol
 * with no field for it would drop the words without saying so, so an engine not
 * named here is never offered the choice.
 */
const reasonEngines: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "cursor",
  "muse",
  "opencode",
  "pi",
]);

export function threadTakesDenialReason(
  snapshot: Pick<HostSnapshot, "harnesses" | "threads">,
  threadId: string,
): boolean {
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  const harness = snapshot.harnesses.find(({ id }) => id === thread?.harnessInstanceId);
  return harness !== undefined && reasonEngines.has(harness.driverKind);
}

/** The system's own second question, for an answer that can't be taken back. */
export function confirmHighRisk(title: string, detail: string | null, onAllow: () => void): void {
  Alert.alert(title, detail ?? undefined, [
    { style: "cancel", text: "Cancel" },
    { onPress: onAllow, style: "destructive", text: "Allow" },
  ]);
}

/**
 * The answers behind an approval's menu. Each that grants follows Allow's own
 * rules: it isn't offered over a request that doesn't fit, and high risk is
 * asked again. "Say why" is a refusal, so nothing has to be read first.
 */
export function approvalMenuOptions(input: {
  readonly answers: Extract<RequestCardAnswers, { kind: "approve" }>;
  readonly detail: string | null;
  /** The whole request is on screen. */
  readonly readable: boolean;
  readonly request: Request;
  readonly takesReason: boolean;
  readonly title: string;
  readonly onAnswer: (option: RequestOption) => void;
  readonly onSayWhy: () => void;
}): NativeMenuOption[] {
  const { answers, onAnswer, request } = input;
  const options: NativeMenuOption[] = answers.more
    .filter((option) => input.readable || requestOptionDeclines(option))
    .map((option) => ({
      id: option.id,
      label: requestOptionLabel(request, option),
      onPress: () => {
        if (answers.highRisk && !requestOptionDeclines(option)) {
          confirmHighRisk(input.title, input.detail, () => onAnswer(option));
        } else onAnswer(option);
      },
    }));
  if (input.takesReason) {
    options.push({
      id: "say-why",
      label: `${requestOptionLabel(request, answers.decline)} and say why…`,
      onPress: input.onSayWhy,
    });
  }
  return options;
}
