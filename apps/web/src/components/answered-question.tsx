import {
  formatClockTime,
  type AnsweredQuestionEntry,
  type HostClient,
} from "@opensteer/client/host";
import { useAnsweredQuestion, type AnsweredQuestionRead } from "@opensteer/client/react";
import type { AnsweredQuestion } from "@opensteer/core";
import { useState } from "react";
import { Icon } from "./icon.js";
import { RequestDetail } from "./request-detail.js";

/**
 * An answered question in its thread: the record the thread carries, read
 * whole from its Request when the reader opens one that was cut to fit.
 */
export function AnsweredQuestionRow({
  client,
  entry,
  threadId,
}: {
  client: HostClient | null;
  entry: AnsweredQuestionEntry;
  threadId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { question, read, reload } = useAnsweredQuestion({
    client,
    threadId,
    requestId: entry.requestId,
    question: entry.question,
    open,
  });
  return (
    <AnsweredQuestionView
      answeredAt={entry.createdAt}
      cut={entry.question.truncated === true}
      onOpenChange={setOpen}
      onRetry={reload}
      open={open}
      question={question}
      read={read}
      title={entry.title}
    />
  );
}

/**
 * What was asked, then the answer: the draft folded as in the card, each
 * question's answer in its own words. A `cut` record has one disclosure for
 * the whole of it, on the draft's fold or, without a draft, its own.
 */
export function AnsweredQuestionView({
  answeredAt,
  cut = false,
  onOpenChange,
  onRetry,
  open,
  question,
  read = "whole",
  title,
}: {
  answeredAt: string;
  cut?: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry?: () => void;
  open: boolean;
  question: AnsweredQuestion;
  read?: AnsweredQuestionRead;
  title: string;
}) {
  const dismissed = question.outcome === "dismissed";
  const several = question.answers.length > 1;
  return (
    <section aria-label={`Question: ${title}`} className="answered-question">
      <p className="answered-question__head">
        <Icon name={dismissed ? "stop" : "check-circle"} />
        {dismissed ? "Dismissed" : "You answered"} ·{" "}
        <time dateTime={answeredAt}>{formatClockTime(answeredAt)}</time>
      </p>
      <p className="answered-question__title">{title}</p>
      {question.detail ? (
        <RequestDetail
          excerpt={question.truncated === true}
          markdown
          onOpenChange={onOpenChange}
          open={open}
          text={question.detail}
        />
      ) : null}
      {question.answers.map(({ prompt, answer }, index) => (
        <div className="answered-question__answer" key={index}>
          {several || prompt.trim() !== title.trim() ? (
            <p className="answered-question__prompt">{prompt}</p>
          ) : null}
          <p className="answered-question__words">{answer.join(", ")}</p>
        </div>
      ))}
      {cut && !question.detail ? (
        <button
          aria-expanded={open}
          className="message-fold__toggle"
          onClick={() => onOpenChange(!open)}
          type="button"
        >
          {open ? "Show less" : "Show more"}
          <Icon name="chevron-down" />
        </button>
      ) : null}
      {open && read === "loading" ? (
        <p className="answered-question__issue">Loading the whole question…</p>
      ) : open && read === "unavailable" ? (
        <p className="answered-question__issue">The whole question is no longer available.</p>
      ) : open && read === "failed" ? (
        <p className="answered-question__issue">
          Couldn’t load the whole question.{" "}
          <button className="answered-question__retry" onClick={onRetry} type="button">
            Retry
          </button>
        </p>
      ) : null}
    </section>
  );
}
