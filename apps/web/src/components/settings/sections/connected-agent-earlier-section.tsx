import { useMemo } from "react";
import { agentWords, connectedAgentEarlier } from "@opensteer/client/host";
import type { useConnectedAgentHistory } from "@opensteer/client/react";
import { OutsideName } from "../../../ui/address-text.js";
import { useOpenSessionTask } from "../../agent-work.js";
import { Icon } from "../../icon.js";
import { SettingsError, SettingsGroup } from "../primitives.js";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function ConnectedAgentEarlierSection({
  activeSessionIds,
  history,
}: {
  readonly activeSessionIds: ReadonlySet<string>;
  readonly history: ReturnType<typeof useConnectedAgentHistory>;
}) {
  const open = useOpenSessionTask();
  const { page, loadingMore, failed, showEarlier } = history;
  const days = useMemo(
    () =>
      page
        ? connectedAgentEarlier({
            operations: page.operations,
            activeSessionIds,
            hasEarlier: page.nextBefore !== null,
          })
        : [],
    [page, activeSessionIds],
  );
  const more = page?.nextBefore ? (
    <button
      className="btn btn--small connected-agent__show-earlier"
      disabled={loadingMore}
      onClick={() => void showEarlier()}
      type="button"
    >
      {loadingMore ? agentWords("common.loading") : "Show earlier"}
    </button>
  ) : null;
  const error = failed ? <SettingsError message="Couldn’t load earlier activity." /> : null;
  if (!days.length && !more && !error) return null;

  return (
    <SettingsGroup heading="Earlier" headingId="connected-agent-earlier">
      {days.map(({ day, label, sessions }) => (
        <div className="connected-agent__history-day" key={day}>
          <h3>{label}</h3>
          {sessions.map(({ sessionId, threadId, place, actionCount, action, outcome, at }) => (
            <button
              className="card__row connected-agent__history-row"
              key={sessionId}
              onClick={() => open(threadId)}
              type="button"
            >
              <span className="card__row-body">
                <span className="card__row-title">
                  <OutsideName value={place} />
                  {actionCount === null
                    ? null
                    : ` · ${actionCount} ${actionCount === 1 ? "action" : "actions"}`}
                </span>
                <span className="card__row-detail" dir="auto">
                  {action} · {outcome}
                </span>
              </span>
              <time dateTime={at}>{timeFormat.format(new Date(at))}</time>
              <Icon name="chevron-right" />
            </button>
          ))}
        </div>
      ))}
      {more}
      {error}
    </SettingsGroup>
  );
}
