import {
  chooseQuestionOption,
  questionAnswer,
  questionDraft,
  questionStep,
  typeQuestionAnswer,
  withQuestionDraft,
  type HostClient,
  type QuestionDraft,
  type QuestionDrafts,
  type QuestionStep,
  type SurfaceModel,
} from "@opensteer/client/host";
import type { RequestFormField } from "@opensteer/core";
import * as Haptics from "expo-haptics";
import { updateRequestSession } from "./request-session.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";
import { useRequestResponse, type RequestResponder } from "./use-request-response.js";

export interface QuestionAnswering {
  readonly draft: QuestionDraft;
  readonly field: RequestFormField;
  readonly fields: readonly RequestFormField[];
  /** Answering the question in view sends the form: its control says Answer rather than Next. */
  readonly finishes: boolean;
  readonly index: number;
  readonly responder: RequestResponder;
  /** Where Next or Answer goes from the question in view. */
  readonly step: QuestionStep;
  /** Marks an option; a single choice then moves on, or sends once every question has its answer. */
  readonly choose: (value: string) => void;
  readonly type: (typed: string) => void;
  readonly go: (index: number) => void;
  /** Next, or Answer: the composer's send. */
  readonly advance: () => void;
  /** Only `ask_person` can be set aside; an engine's question is ended by Stop. */
  readonly dismiss: (() => void) | null;
}

/**
 * A question's answers, given across the card and the composer. Both read and
 * write the Request's one session, so what is chosen or typed survives either
 * remounting, and a send from either retries under the key it was first sent with.
 */
export function useQuestionAnswering(input: {
  readonly canRespond: boolean;
  readonly canStartResponse: () => boolean;
  readonly gate: ThreadMutationGate;
  readonly hostClient: HostClient;
  readonly surface: SurfaceModel;
}): QuestionAnswering {
  const responder = useRequestResponse(input);
  const { session } = responder;
  const { request } = input.surface;
  const fields = request.presentation.kind === "form" ? request.presentation.fields : [];
  const index = Math.min(session.questionIndex, Math.max(fields.length - 1, 0));
  const field = fields[index]!;
  const draft = questionDraft(session.questions, field.id);
  const step = questionStep(fields, session.questions, index);
  const finishes =
    step.kind === "send" ||
    (step.kind === "blocked" &&
      fields.every(
        (other, position) =>
          position === index ||
          questionAnswer(other, questionDraft(session.questions, other.id)) !== null,
      ));

  const follow = (next: QuestionStep, busyId: string): void => {
    if (next.kind === "next") updateRequestSession(session, { questionIndex: next.index });
    else if (next.kind === "send") {
      void responder.submit({ answers: next.answers, kind: "form" }, busyId);
    }
  };
  const write = (drafts: QuestionDrafts): void =>
    updateRequestSession(session, { failure: null, questions: drafts });

  return {
    draft,
    field,
    fields,
    finishes,
    index,
    responder,
    step,
    choose: (value) => {
      if (session.responding) return;
      void Haptics.selectionAsync();
      const drafts = withQuestionDraft(
        session.questions,
        field.id,
        chooseQuestionOption(field, draft, value),
      );
      write(drafts);
      if (!field.multiSelect) follow(questionStep(fields, drafts, index), `option:${value}`);
    },
    type: (typed) =>
      write(
        withQuestionDraft(session.questions, field.id, typeQuestionAnswer(field, draft, typed)),
      ),
    go: (next) => {
      if (next >= 0 && next < fields.length) updateRequestSession(session, { questionIndex: next });
    },
    advance: () => follow(step, "form"),
    dismiss:
      request.kind === "person.question"
        ? () =>
            void responder.submit({ kind: "external", value: { decision: "declined" } }, "dismiss")
        : null,
  };
}
