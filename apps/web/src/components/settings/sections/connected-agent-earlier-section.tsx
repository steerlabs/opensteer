import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentWords,
  connectedAgentEarlier,
  unwrapRpcResult,
  type ChatScreenHost,
} from "@opensteer/client/host";
import type { AgentCommandActivity, AgentOperationView } from "@opensteer/core";
import { OutsideName } from "../../../ui/address-text.js";
import { useOpenSessionTask } from "../../agent-work.js";
import { Icon } from "../../icon.js";
import { SettingsError, SettingsGroup } from "../primitives.js";

interface ActivityPage {
  readonly operations: readonly AgentOperationView[];
  readonly commands: readonly AgentCommandActivity[];
  readonly nextBefore: string | null;
}

async function readActivityPage(
  client: Pick<ChatScreenHost, "rpc">,
  connectionId: string,
  before: string | null,
  signal: AbortSignal,
): Promise<ActivityPage> {
  return unwrapRpcResult(
    await client.rpc["connections.activity"](before ? { connectionId, before } : { connectionId }, {
      signal,
    }),
  );
}

/** One initial read and one more only when Show earlier is pressed. */
export function useConnectedAgentHistory(
  client: Pick<ChatScreenHost, "rpc">,
  connectionId: string,
) {
  const scope = useMemo(() => ({ client, connectionId }), [client, connectionId]);
  const lifetime = useRef<{ scope: typeof scope; controller: AbortController; busy: boolean }>(
    null,
  );
  const [read, setRead] = useState<{
    scope: typeof scope;
    page: ActivityPage | null;
    loadingMore: boolean;
    failed: boolean;
  }>();
  const current = read?.scope === scope ? read : undefined;
  useEffect(() => {
    const controller = new AbortController();
    const request = { scope, controller, busy: true };
    lifetime.current = request;
    void readActivityPage(scope.client, scope.connectionId, null, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        request.busy = false;
        setRead({ scope, page, loadingMore: false, failed: false });
      },
      () => {
        if (controller.signal.aborted) return;
        request.busy = false;
        setRead({ scope, page: null, loadingMore: false, failed: true });
      },
    );
    return () => controller.abort();
  }, [scope]);

  const showEarlier = async () => {
    const request = lifetime.current;
    const page = current?.page;
    if (!request || request.scope !== scope || request.busy || !page?.nextBefore) return;
    request.busy = true;
    setRead({ scope, page, loadingMore: true, failed: false });
    try {
      const next = await readActivityPage(
        client,
        connectionId,
        page.nextBefore,
        request.controller.signal,
      );
      if (request.controller.signal.aborted) return;
      setRead({
        scope,
        page: {
          operations: [...page.operations, ...next.operations],
          commands: [
            ...new Map(
              [...page.commands, ...next.commands].map((command) => [command.id, command]),
            ).values(),
          ],
          nextBefore: next.nextBefore,
        },
        loadingMore: false,
        failed: false,
      });
    } catch {
      if (!request.controller.signal.aborted)
        setRead({ scope, page, loadingMore: false, failed: true });
    } finally {
      request.busy = false;
    }
  };
  return {
    page: current?.page,
    loadingMore: current?.loadingMore ?? false,
    failed: current?.failed ?? false,
    showEarlier,
  };
}

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
