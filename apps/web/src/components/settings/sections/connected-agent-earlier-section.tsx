import { connectedAgentEarlierSection, type ConnectedAgentNow } from "@opensteer/client/host";
import type { useConnectedAgentHistory } from "@opensteer/client/react";
import { SentenceText } from "../../../ui/address-text.js";
import { useOpenSessionTask } from "../../agent-work.js";
import { Icon } from "../../icon.js";
import { SettingsError, SettingsGroup } from "../primitives.js";

export function ConnectedAgentEarlierSection({
  activeAgents,
  history,
}: {
  readonly activeAgents: readonly ConnectedAgentNow[];
  readonly history: ReturnType<typeof useConnectedAgentHistory>;
}) {
  const open = useOpenSessionTask();
  const section = connectedAgentEarlierSection(history, activeAgents);
  if (!section) return null;
  const { days, more, error } = section;

  return (
    <SettingsGroup heading="Earlier" headingId="connected-agent-earlier">
      {days.map(({ day, label, sessions }) => (
        <div className="connected-agent__history-day" key={day}>
          <h3>{label}</h3>
          {sessions.map(({ sessionId, threadId, labelParts, detailParts, at, time }) => (
            <button
              className="card__row connected-agent__history-row"
              key={sessionId}
              onClick={() => open(threadId)}
              type="button"
            >
              <span className="card__row-body">
                <span className="card__row-title">
                  <SentenceText parts={labelParts} quoteNames={false} />
                </span>
                <span className="card__row-detail" dir="auto">
                  <SentenceText parts={detailParts} quoteNames={false} />
                </span>
              </span>
              <time dateTime={at}>{time}</time>
              <Icon name="chevron-right" />
            </button>
          ))}
        </div>
      ))}
      {more ? (
        <button
          className="btn btn--small connected-agent__show-earlier"
          disabled={more.disabled}
          onClick={() => void history.showEarlier()}
          type="button"
        >
          {more.label}
        </button>
      ) : null}
      {error ? <SettingsError message={error} /> : null}
    </SettingsGroup>
  );
}
