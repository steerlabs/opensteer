import {
  chooseQuestionOption,
  isQuestionOptionChosen,
  questionDraft,
  questionStep,
  questionTakesTyping,
  typeQuestionAnswer,
  withQuestionDraft,
} from "@opensteer/client/host";
import type { Request, RequestFormField } from "@opensteer/core";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import {
  advanceQuestion,
  dismissQuestion,
  updateQuestionSession,
  useAnswersInComposer,
  useQuestionSession,
} from "./question-session.js";

/** What engines title a question with no words of its own; its prompt says it all. */
export const untitledQuestion = "More information needed";

function fieldsOf(request: Request): readonly RequestFormField[] {
  return request.presentation.kind === "form" ? request.presentation.fields : [];
}

/**
 * A question an agent asked, in its card: which of several it is, its words,
 * and its options. What the person types goes in the composer below when there
 * is one; where the card stands alone, as on a call, it brings its own field.
 */
export function QuestionBody({
  composer,
  disabled,
  request,
  threadId,
  title,
}: {
  /** A composer below this card takes the typed answer. */
  readonly composer: boolean;
  readonly disabled: boolean;
  readonly request: Request;
  /** The task whose composer this card sits above. */
  readonly threadId: string;
  /** The heading the card already shows, so a prompt saying the same isn't repeated. */
  readonly title: string;
}) {
  const { hostClient } = useShell();
  const session = useQuestionSession(request.id);
  const inComposer = useAnswersInComposer(threadId, request.id);
  const fields = fieldsOf(request);
  const index = Math.min(session.index, fields.length - 1);
  const field = fields[index];
  const listRef = useRef<HTMLDivElement | null>(null);
  if (!field) return null;
  const draft = questionDraft(session.drafts, field.id);
  const busy = disabled || session.sending;
  const choose = (value: string) => {
    if (busy) return;
    const drafts = withQuestionDraft(
      session.drafts,
      field.id,
      chooseQuestionOption(field, draft, value),
    );
    if (field.multiSelect) updateQuestionSession(request.id, { drafts });
    else advanceQuestion(hostClient, request, drafts, index);
  };
  const choices = field.choices ?? [];
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const current = rows.findIndex((row) => row === document.activeElement);
      rows[(current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      return;
    }
    const digit = Number.parseInt(event.key, 10);
    const choice = choices[digit - 1];
    if (choice && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      choose(choice.value);
    }
  };
  const prompt = field.prompt.trim();
  // Where the composer isn't this question's answer, the card gives it: its
  // own field when nothing else on screen takes words, and Next or Answer
  // whenever a tap alone can't finish the question.
  const ownField = !composer && questionTakesTyping(field);
  const ownButton = (!composer || !inComposer) && !ownField && field.multiSelect;
  const switchable = composer && !inComposer && questionTakesTyping(field);
  return (
    <div className="question">
      {fields.length > 1 ? (
        <div className="question__step">
          <span aria-live="polite">
            Question {index + 1} of {fields.length}
          </span>
          <span className="question__step-nav">
            <button
              aria-label="Previous question"
              className="icon-btn icon-btn--small"
              disabled={index === 0}
              onClick={() => updateQuestionSession(request.id, { index: index - 1 })}
              type="button"
            >
              <Icon name="chevron-left" />
            </button>
            <button
              aria-label="Next question"
              className="icon-btn icon-btn--small"
              disabled={index === fields.length - 1}
              onClick={() => updateQuestionSession(request.id, { index: index + 1 })}
              type="button"
            >
              <Icon name="chevron-right" />
            </button>
          </span>
        </div>
      ) : null}
      {prompt !== "" && prompt !== title ? <p className="question__prompt">{prompt}</p> : null}
      {choices.length > 0 ? (
        <div
          aria-label={prompt || title}
          className="action-rows"
          onKeyDown={handleKeyDown}
          ref={listRef}
          role={field.multiSelect ? "group" : "radiogroup"}
        >
          {choices.map((choice, position) => {
            const chosen = isQuestionOptionChosen(draft, choice.value);
            return (
              <button
                aria-checked={chosen}
                className={`action-row question__option${chosen ? " action-row--selected" : ""}`}
                disabled={busy}
                key={choice.value}
                onClick={() => choose(choice.value)}
                role={field.multiSelect ? "checkbox" : "radio"}
                type="button"
              >
                <span
                  aria-hidden
                  className={`question__mark${field.multiSelect ? " question__mark--many" : ""}`}
                >
                  {chosen ? <Icon name="check" /> : position + 1}
                </span>
                <span className="action-row__text">
                  <span className="action-row__label">{choice.label}</span>
                  {choice.description ? (
                    <span className="action-row__desc">{choice.description}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {ownField ? <AnswerField composer={false} disabled={disabled} request={request} /> : null}
      {session.failure ? (
        <p className="question__failure" role="alert">
          <Icon name="alert-circle" />
          <span>{session.failure}</span>
        </p>
      ) : null}
      {switchable || ownButton || request.kind === "person.question" ? (
        <div className="question__actions">
          {switchable ? (
            <button
              className="question__link"
              disabled={busy}
              onClick={() => updateQuestionSession(request.id, { typing: true })}
              title="Your message draft stays saved"
              type="button"
            >
              Type an answer
            </button>
          ) : null}
          <span className="question__actions-space" />
          {request.kind === "person.question" ? (
            <button
              className="btn btn--ghost btn--small"
              disabled={busy}
              onClick={() => void dismissQuestion(hostClient, request)}
              type="button"
            >
              Dismiss
            </button>
          ) : null}
          {ownButton ? <AnswerButton disabled={disabled} request={request} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Next, or Answer once every question has one: the control that moves a question on. */
function AnswerButton({ disabled, request }: { disabled: boolean; request: Request }) {
  const { hostClient } = useShell();
  const session = useQuestionSession(request.id);
  const fields = fieldsOf(request);
  const index = Math.min(session.index, fields.length - 1);
  const step = questionStep(fields, session.drafts, index);
  return (
    <button
      className="composer__answer"
      disabled={disabled || session.sending || step.kind === "blocked"}
      onClick={() => advanceQuestion(hostClient, request, session.drafts, index)}
      type="button"
    >
      {session.sending ? "Sending…" : step.kind === "next" ? "Next" : "Answer"}
    </button>
  );
}

/**
 * The words typed as an answer, and the control that gives it. In the composer
 * it takes the message box's place, with Stop while a Run works and nothing is
 * typed; in a card it is a plain field under the options.
 */
export function AnswerField({
  composer,
  disabled,
  onEscape,
  onStop,
  request,
  running = false,
  stopLabel = "Stop",
  stopping = false,
}: {
  readonly composer: boolean;
  readonly disabled: boolean;
  readonly onEscape?: (() => void) | undefined;
  readonly onStop?: (() => Promise<void>) | undefined;
  readonly request: Request;
  readonly running?: boolean;
  readonly stopLabel?: string;
  readonly stopping?: boolean;
}) {
  const { hostClient } = useShell();
  const session = useQuestionSession(request.id);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const fields = fieldsOf(request);
  const index = Math.min(session.index, fields.length - 1);
  const field = fields[index];
  useEffect(() => {
    // Taking the message box's place keeps the caret in it, never on the page.
    if (composer && (document.activeElement === null || document.activeElement === document.body))
      fieldRef.current?.focus();
  }, [composer, request.id, index]);
  if (!field) return null;
  const draft = questionDraft(session.drafts, field.id);
  const types = questionTakesTyping(field);
  const step = questionStep(fields, session.drafts, index);
  const blank = draft.typed.trim() === "";
  const busy = disabled || session.sending;
  const submit = () => {
    if (busy || step.kind === "blocked") return;
    advanceQuestion(hostClient, request, session.drafts, index);
  };
  const placeholder = !types
    ? "Choose an answer above"
    : field.choices === undefined
      ? "Type your answer…"
      : "Type your own answer…";
  const showStop = composer && running && onStop !== undefined && blank && step.kind === "blocked";
  return (
    <div className={composer ? "composer composer--answer" : "question__field"}>
      <div className="composer__entry">
        <textarea
          aria-label={field.prompt || "Your answer"}
          className="composer__input"
          disabled={busy || !types}
          onChange={(event) =>
            updateQuestionSession(request.id, {
              drafts: withQuestionDraft(
                session.drafts,
                field.id,
                typeQuestionAnswer(field, draft, event.target.value),
              ),
            })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape" && onEscape) {
              event.preventDefault();
              onEscape();
            }
          }}
          placeholder={placeholder}
          ref={fieldRef}
          rows={1}
          value={draft.typed}
        />
        <div className="composer__footer">
          <span className="composer__answer-space" />
          {showStop ? (
            <button
              aria-label={stopLabel}
              className="composer__stop"
              disabled={stopping || disabled}
              onClick={() => void onStop?.()}
              title="Stop"
              type="button"
            >
              <Icon name="stop" />
            </button>
          ) : (
            <AnswerButton disabled={disabled} request={request} />
          )}
        </div>
      </div>
    </div>
  );
}
