import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  formatRelativeTime,
  sameTaskFamily,
  taskFamily,
  type FamilyTask,
  type HostClient,
  type HostSnapshot,
  type TaskFamilyGlance,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { automationPath, useMinuteClock } from "../../ui-utils.js";
import { formatCountdown, formatMoment } from "../automations/automation-presentation.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { TaskLineState } from "../task-line.js";
import { AreaLink } from "./area-link.js";
import { TaskMark } from "./task-mark.js";
import { useWorkspace } from "./workspace-context.js";

export function TaskFamilyButton({
  hostClient,
  threadId,
  glance,
}: {
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly glance: TaskFamilyGlance;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const earlierOnly = glance.running === 0 && glance.automations === 0;
  const label = earlierOnly
    ? `${glance.earlier} earlier`
    : [
        `${glance.running} task${glance.running === 1 ? "" : "s"} running`,
        ...(glance.needsYou ? ["one needs you"] : []),
        ...(glance.automations
          ? [`${glance.automations} automation${glance.automations === 1 ? "" : "s"}`]
          : []),
      ].join(", ");
  return (
    <>
      <button
        className="task-family-button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        type="button"
        ref={button}
        onClick={() => setOpen((value) => !value)}
      >
        {earlierOnly ? (
          `${glance.earlier} earlier`
        ) : (
          <>
            {glance.running > 0 ? (
              <>
                <span className="task-family-button__marks">
                  {glance.marks.map((mark, index) => (
                    <TaskMark key={index} mark={mark} size={16} />
                  ))}
                </span>
                <span>{glance.running}</span>
              </>
            ) : null}
            {glance.needsYou ? (
              <span aria-hidden className="task-family-button__attention" />
            ) : null}
            {glance.automations > 0 ? (
              <span
                className={`task-family-button__automations${glance.running > 0 ? " task-family-button__automations--separated" : ""}`}
              >
                <Icon name="clock" />
                {glance.automations}
              </span>
            ) : null}
          </>
        )}
      </button>
      {open && button.current ? (
        <FamilyPanel
          key={threadId}
          hostClient={hostClient}
          threadId={threadId}
          button={button.current}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function FamilyPanel({
  hostClient,
  threadId,
  button,
  onClose,
}: {
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly button: HTMLButtonElement;
  readonly onClose: () => void;
}) {
  const select = useCallback(
    (snapshot: HostSnapshot) => taskFamily(snapshot, threadId),
    [threadId],
  );
  const family = useHostSelector(hostClient, select, sameTaskFamily);
  const { nav } = useWorkspace();
  const now = useMinuteClock();
  const header = button.closest("header") ?? button;
  // The panel has 14px of padding/border and leaves 6px on either side.
  const [width, setWidth] = useState(() => header.getBoundingClientRect().width - 26);
  useLayoutEffect(() => {
    const measure = () => setWidth(header.getBoundingClientRect().width - 26);
    measure();
    return observeResize([header], measure);
  }, [header]);
  const onlyEarlier = family.running.length === 0 && family.automations.length === 0;
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [all, setAll] = useState(false);
  const open = (id: string) => {
    onClose();
    nav.openConversation(nav.threadPath(id));
  };
  const taskRow = (task: FamilyTask, earlier = false) => (
    <button
      type="button"
      className="task-family__row picker__row"
      key={task.threadId}
      aria-label={`${task.title}, ${task.needsYou ? "Needs you" : task.word}`}
      onClick={() => open(task.threadId)}
    >
      <TaskMark size={20} mark={task.mark} />
      <span className="task-family__text">
        <span className="task-family__title">{task.title}</span>
        {earlier ? (
          <span className="picker__detail">
            {task.word}
            {task.finishedAt ? ` · ${formatRelativeTime(task.finishedAt, new Date(now))}` : ""}
          </span>
        ) : task.detail ? (
          <span className="picker__detail">{task.detail}</span>
        ) : null}
      </span>
      {earlier ? null : (
        <span className="task-family__state" data-needs-you={task.needsYou || undefined}>
          <TaskLineState
            moving={task.moving}
            tone={task.tone}
            word={task.needsYou ? "Needs you" : task.word}
          />
        </span>
      )}
    </button>
  );
  return (
    <Popover
      anchor={header}
      returnFocusTo={button}
      below
      label="Task family"
      role="dialog"
      className="popover--task-family"
      onClose={onClose}
    >
      <div className="task-family" style={{ width: Math.max(0, width) }}>
        {family.running.length > 0 ? (
          <section aria-label="Running">
            <h2 className="task-family__heading">Running · {family.running.length}</h2>
            {family.running.map((task) => taskRow(task))}
          </section>
        ) : null}
        {family.automations.length > 0 ? (
          <section aria-label="Automations">
            <h2 className="task-family__heading">Automations · {family.automations.length}</h2>
            {family.automations.map((automation) => (
              <AreaLink
                key={automation.id}
                className="task-family__row picker__row"
                to={automationPath(automation.id)}
                onClick={onClose}
              >
                <span className="picker__glyph">
                  <Icon
                    name={
                      automation.kind === "schedule"
                        ? "clock"
                        : automation.kind === "watch"
                          ? "eye"
                          : "bolt"
                    }
                  />
                </span>
                <span className="task-family__text">
                  <span className="task-family__title">{automation.name}</span>
                  <span className="picker__detail">
                    {automation.paused
                      ? "Paused"
                      : automation.kind === "watch"
                        ? "Watching"
                        : automation.kind === "webhook"
                          ? "On webhook"
                          : automation.nextFireAt
                            ? (formatCountdown(automation.nextFireAt, now) ??
                              formatMoment(automation.nextFireAt, now))
                            : null}
                  </span>
                </span>
              </AreaLink>
            ))}
          </section>
        ) : null}
        {family.earlier.length > 0 ? (
          <section aria-label="Earlier">
            {onlyEarlier ? (
              <h2 className="task-family__heading">Earlier · {family.earlier.length}</h2>
            ) : (
              <button
                type="button"
                className="task-family__heading task-family__toggle picker__row"
                aria-expanded={earlierOpen}
                onClick={() => setEarlierOpen((value) => !value)}
              >
                Earlier · {family.earlier.length}
                <Icon name={earlierOpen ? "arrow-up" : "chevron-down"} />
              </button>
            )}
            {onlyEarlier || earlierOpen ? (
              <>
                {(all ? family.earlier : family.earlier.slice(0, 4)).map((task) =>
                  taskRow(task, true),
                )}
                {!all && family.earlier.length > 4 ? (
                  <button type="button" className="picker__row" onClick={() => setAll(true)}>
                    Show all
                  </button>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
      </div>
    </Popover>
  );
}
