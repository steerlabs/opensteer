import type { ReactNode } from "react";
import { Icon } from "../icon.js";
import { TaskMark } from "../workspace/task-mark.js";
import { age } from "../team/team-time.js";
import type { NeedsYouItemView } from "./home-models.js";
import { TaskSource } from "./personal-sidebar.js";

export interface NeedsYouActions {
  readonly onAnswer: (itemId: string, choice: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}

/**
 * Every Request from every task, newest first. Simple ones answer in place;
 * the rest open their task. Mentions and DMs are not here: they are badges
 * and notifications.
 */
export function NeedsYouPage({
  actions,
  header,
  items,
  pending = null,
}: {
  readonly actions: NeedsYouActions;
  readonly header?: ReactNode;
  readonly items: readonly NeedsYouItemView[];
  /** The item whose answer is on its way. */
  readonly pending?: string | null;
}) {
  return (
    <div className="needs-you-page">
      {header}
      {items.length === 0 ? (
        <div className="needs-you-empty">
          <Icon name="check-circle" />
          <p className="needs-you-empty__title">Nothing needs you</p>
          <p className="needs-you-empty__body">
            When a task asks you something, it lands here and on your phone.
          </p>
        </div>
      ) : (
        <ul aria-label="Needs you" className="needs-you-list">
          {items.map((item) => (
            <li key={item.id}>
              <NeedsYouCard actions={actions} item={item} pending={pending === item.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NeedsYouCard({
  actions,
  compact = false,
  item,
  pending = false,
}: {
  readonly actions: NeedsYouActions;
  /** Home's shorter form: one line of context under the ask. */
  readonly compact?: boolean;
  readonly item: NeedsYouItemView;
  readonly pending?: boolean;
}) {
  const where =
    item.where.kind === "team" ? (
      <TaskSource source={item.where.source} />
    ) : (
      <span>{item.where.label}</span>
    );
  const answer = item.answer;
  const open = (
    <button
      className={answer.kind === "open" ? "btn btn--small" : "btn btn--small btn--ghost"}
      onClick={() => actions.onOpenTask(item.taskId)}
      type="button"
    >
      {compact && answer.kind === "open" ? "Open" : "Open task"}
    </button>
  );
  const controls =
    answer.kind === "approve" ? (
      <>
        {compact ? null : open}
        <button
          className="btn btn--small"
          disabled={pending}
          onClick={() => actions.onAnswer(item.id, "deny")}
          type="button"
        >
          {answer.deny}
        </button>
        <button
          className="btn btn--small btn--primary"
          disabled={pending}
          onClick={() => actions.onAnswer(item.id, "approve")}
          type="button"
        >
          {answer.approve}
        </button>
      </>
    ) : answer.kind === "sign-in" ? (
      <>
        {compact ? null : open}
        <button
          className="btn btn--small btn--primary"
          disabled={pending}
          onClick={() => actions.onAnswer(item.id, "sign-in")}
          type="button"
        >
          {answer.label}
        </button>
      </>
    ) : (
      open
    );
  return (
    <article className={compact ? "needs-card needs-card--compact" : "needs-card"}>
      <span className="needs-card__mark">
        <TaskMark mark={item.mark} size={20} />
      </span>
      <div className="needs-card__body">
        {compact ? (
          <>
            <p className="needs-card__task">{item.taskTitle}</p>
            <p className="needs-card__line">
              {item.where.kind === "team" ? <TaskSource source={item.where.source} /> : null}
              <span className="needs-card__ask">{item.title}</span>
            </p>
          </>
        ) : (
          <>
            <p className="needs-card__meta">
              <span>{item.taskTitle}</span>
              <span aria-hidden>·</span>
              {where}
              <span aria-hidden>·</span>
              <time dateTime={item.askedAt}>{age(item.askedAt)}</time>
            </p>
            <p className="needs-card__title">{item.title}</p>
            {item.detail ? <p className="needs-card__detail">{item.detail}</p> : null}
            {item.channelSees ? <p className="needs-card__detail">{item.channelSees}</p> : null}
            {answer.kind === "choices" ? (
              <div className="needs-card__choices">
                {answer.options.map((option) => (
                  <button
                    className="needs-card__choice"
                    disabled={pending}
                    key={option.id}
                    onClick={() => actions.onAnswer(item.id, option.id)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="needs-card__controls">{controls}</div>
    </article>
  );
}
