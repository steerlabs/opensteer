import { useCallback, useMemo, useRef, useState } from "react";
import {
  conversationSubagents,
  earlierHelpers,
  formatRelativeTime,
  sameTaskFamily,
  taskFamily,
  type AgentRoster,
  type FamilyTask,
  type HostClient,
  type HostSnapshot,
  type TaskFamilyGlance,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { automationPath, useMediaQuery, useMinuteClock } from "../../ui-utils.js";
import { formatCountdown, formatMoment } from "@opensteer/client/host";
import { AgentRosterRow } from "../agent-cards.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { TaskLineState } from "../task-line.js";
import { AreaLink } from "./area-link.js";
import { TaskMark } from "./task-mark.js";
import { useWorkspace } from "./workspace-context.js";

/** The conversation's own subagents at a glance: primitives only, so streaming never redraws the bar. */
export interface HelperGlance {
  readonly live: number;
  readonly total: number;
  readonly needsYou: boolean;
  readonly earlier: number;
}

export function helperGlance(snapshot: HostSnapshot, threadId: string): HelperGlance | null {
  const roster = conversationSubagents(snapshot, threadId, { tasks: false });
  const total = roster.now.length + roster.earlier.length;
  return total === 0
    ? null
    : {
        live: roster.pill?.live ?? 0,
        total,
        needsYou: (roster.pill?.needsYou ?? 0) > 0,
        earlier: roster.earlier.length,
      };
}

export function sameHelperGlance(left: HelperGlance | null, right: HelperGlance | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.live === right.live &&
      left.total === right.total &&
      left.needsYou === right.needsYou &&
      left.earlier === right.earlier)
  );
}

/** Cards are rebuilt on every change the panel hears; plain data, so their contents say it all. */
function sameRoster(left: AgentRoster, right: AgentRoster): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function TaskFamilyButton({
  hostClient,
  threadId,
  glance,
  helpers,
}: {
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly glance: TaskFamilyGlance | null;
  readonly helpers: HelperGlance | null;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const running = glance?.running ?? 0;
  const automations = glance?.automations ?? 0;
  const live = helpers?.live ?? 0;
  const earlier = (glance?.earlier ?? 0) + (helpers?.earlier ?? 0);
  const needsYou = glance?.needsYou === true || helpers?.needsYou === true;
  const earlierOnly = running === 0 && automations === 0 && live === 0;
  const label = earlierOnly
    ? `${earlier} earlier`
    : [
        ...(running || !live ? [`${running} task${running === 1 ? "" : "s"} running`] : []),
        ...(needsYou ? ["one needs you"] : []),
        ...(automations ? [`${automations} automation${automations === 1 ? "" : "s"}`] : []),
        ...(live && helpers ? [`${live} of ${helpers.total} subagents working`] : []),
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
            {running > 0 && glance ? (
              <>
                <span className="task-family-button__marks">
                  {glance.marks.map((mark, index) => (
                    <TaskMark key={index} mark={mark} size={16} />
                  ))}
                </span>
                <span>{running}</span>
              </>
            ) : null}
            {live > 0 && helpers ? (
              <span
                className={`task-family-button__automations${running > 0 ? " task-family-button__automations--separated" : ""}`}
              >
                <Icon name="users" />
                {live}/{helpers.total}
              </span>
            ) : null}
            {needsYou ? <span aria-hidden className="task-family-button__attention" /> : null}
            {automations > 0 ? (
              <span
                className={`task-family-button__automations${running > 0 || live > 0 ? " task-family-button__automations--separated" : ""}`}
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
  const selectHelpers = useCallback(
    (snapshot: HostSnapshot) => conversationSubagents(snapshot, threadId, { tasks: false }),
    [threadId],
  );
  const helpers = useHostSelector(hostClient, selectHelpers, sameRoster);
  const earlier = useMemo(
    () => earlierHelpers(helpers.earlier, family.earlier),
    [family.earlier, helpers.earlier],
  );
  const { nav } = useWorkspace();
  const narrow = useMediaQuery("(max-width: 620px)");
  const now = useMinuteClock();
  const onlyEarlier =
    family.running.length === 0 && family.automations.length === 0 && helpers.now.length === 0;
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
  const remaining = earlier.length - shown;
  const body = (
    <div className="task-family">
      {helpers.now.length > 0 ? (
        <section aria-label="Subagents">
          <h2 className="task-family__heading">Subagents · {helpers.now.length} working</h2>
          {helpers.now.map((card) => (
            <AgentRosterRow card={card} key={card.key} onOpen={onClose} />
          ))}
        </section>
      ) : null}
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
      {earlier.length > 0 ? (
        <section aria-label="Earlier">
          {onlyEarlier ? (
            <h2 className="task-family__heading">Earlier · {earlier.length}</h2>
          ) : (
            <button
              type="button"
              className="task-family__heading task-family__toggle picker__row"
              aria-expanded={earlierOpen}
              onClick={() => setEarlierOpen((value) => !value)}
            >
              Earlier · {earlier.length}
              <Icon name={earlierOpen ? "arrow-up" : "chevron-down"} />
            </button>
          )}
          {onlyEarlier || earlierOpen ? (
            <>
              {earlier
                .slice(0, shown)
                .map((item) =>
                  item.kind === "task" ? (
                    taskRow(item.task, true)
                  ) : (
                    <AgentRosterRow card={item.card} key={item.card.key} onOpen={onClose} />
                  ),
                )}
              {remaining > 0 ? (
                <button
                  type="button"
                  className="picker__row"
                  onClick={() => setShown(remaining > 50 ? shown + 50 : earlier.length)}
                >
                  {remaining > 50 ? "Show 50 more" : "Show all"}
                </button>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
  return narrow ? (
    <Dialog onClose={onClose} returnFocusTo={button} title="Tasks and subagents">
      {body}
    </Dialog>
  ) : (
    <Popover
      align="end"
      anchor={button}
      below
      label="Tasks and subagents"
      role="dialog"
      className="popover--task-family"
      onClose={onClose}
    >
      {body}
    </Popover>
  );
}
