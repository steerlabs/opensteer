import { useCallback, useRef, useState } from "react";
import {
  formatRelativeTime,
  sameTaskFamily,
  taskFamily,
  type FamilyTask,
  type HostClient,
  type HostSnapshot,
  type TaskFamilyGlance,
  type ThreadAutomation,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { automationPath, useMediaQuery, useMinuteClock } from "../../ui-utils.js";
import { formatCountdown, formatMoment } from "@opensteer/client/host";
import { Dialog } from "../dialog.js";
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
  const { running, automations, earlier, needsYou } = glance;
  const earlierOnly = running === 0 && automations === 0;
  const label = earlierOnly
    ? `${earlier} earlier`
    : [
        `${running} task${running === 1 ? "" : "s"} running`,
        ...(needsYou ? ["one needs you"] : []),
        ...(automations ? [`${automations} automation${automations === 1 ? "" : "s"}`] : []),
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
          `${earlier} earlier`
        ) : (
          <>
            {running > 0 ? (
              <>
                <span className="task-family-button__marks">
                  {glance.marks.map((mark, index) => (
                    <TaskMark key={index} mark={mark} size={16} />
                  ))}
                </span>
                <span>{running}</span>
              </>
            ) : null}
            {needsYou ? <span aria-hidden className="task-family-button__attention" /> : null}
            {automations > 0 ? (
              <span
                className={`task-family-button__automations${running > 0 ? " task-family-button__automations--separated" : ""}`}
              >
                <Icon name="clock" />
                {automations}
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
  const earlier = family.earlier;
  const { nav } = useWorkspace();
  const narrow = useMediaQuery("(max-width: 620px)");
  const now = useMinuteClock();
  const onlyEarlier = family.running.length === 0 && family.automations.length === 0;
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [shown, setShown] = useState(4);
  const open = (id: string) => {
    onClose();
    nav.openConversation(nav.threadPath(id));
  };
  const taskRow = (task: FamilyTask, settled = false) => (
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
        {settled ? (
          <span className="picker__detail">
            {task.word}
            {task.finishedAt ? ` · ${formatRelativeTime(task.finishedAt, new Date(now))}` : ""}
          </span>
        ) : task.detail ? (
          <span className="picker__detail">{task.detail}</span>
        ) : null}
      </span>
      {settled ? null : (
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
  const automationRow = (automation: ThreadAutomation) => {
    const content = (
      <>
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
            {automation.ended
              ? "Ended"
              : automation.paused
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
      </>
    );
    // One running in its own task opens that task, where its runs and reports are.
    const taskId = automation.taskId;
    return taskId ? (
      <button
        type="button"
        className="task-family__row picker__row"
        key={automation.id}
        onClick={() => open(taskId)}
      >
        {content}
      </button>
    ) : (
      <AreaLink
        key={automation.id}
        className="task-family__row picker__row"
        to={automationPath(automation.id)}
        onClick={onClose}
      >
        {content}
      </AreaLink>
    );
  };
  const earlierCount = earlier.length + family.ended.length;
  const remaining = earlier.length - shown;
  const body = (
    <div className="task-family">
      {family.running.length > 0 ? (
        <section aria-label="Running">
          <h2 className="task-family__heading">Running · {family.running.length}</h2>
          {family.running.map((task) => taskRow(task))}
        </section>
      ) : null}
      {family.automations.length > 0 ? (
        <section aria-label="Automations">
          <h2 className="task-family__heading">Automations · {family.automations.length}</h2>
          {family.automations.map(automationRow)}
        </section>
      ) : null}
      {earlierCount > 0 ? (
        <section aria-label="Earlier">
          {onlyEarlier ? (
            <h2 className="task-family__heading">Earlier · {earlierCount}</h2>
          ) : (
            <button
              type="button"
              className="task-family__heading task-family__toggle picker__row"
              aria-expanded={earlierOpen}
              onClick={() => setEarlierOpen((value) => !value)}
            >
              Earlier · {earlierCount}
              <Icon name={earlierOpen ? "arrow-up" : "chevron-down"} />
            </button>
          )}
          {onlyEarlier || earlierOpen ? (
            <>
              {earlier.slice(0, shown).map((task) => taskRow(task, true))}
              {remaining > 0 ? (
                <button
                  type="button"
                  className="picker__row"
                  onClick={() => setShown(remaining > 50 ? shown + 50 : earlier.length)}
                >
                  {remaining > 50 ? "Show 50 more" : "Show all"}
                </button>
              ) : null}
              {family.ended.map(automationRow)}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
  return narrow ? (
    <Dialog onClose={onClose} returnFocusTo={button} title="Task family">
      {body}
    </Dialog>
  ) : (
    <Popover
      align="end"
      anchor={button}
      below
      label="Task family"
      role="dialog"
      className="popover--task-family"
      onClose={onClose}
    >
      {body}
    </Popover>
  );
}
