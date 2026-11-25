import { useEffect, useMemo, useRef, useState } from "react";
import { unwrapRpcResult } from "../host/host-session-client.js";
import type { ChatScreenHost } from "../host/chat-screen-host.js";
import type { AgentCommandActivity, AgentOperationView } from "@opensteer/core";

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

/** One initial read, then a page when asked or a fresh cut when the live session list changes. */
export function useConnectedAgentHistory(
  client: Pick<ChatScreenHost, "rpc">,
  connectionId: string,
  liveSessions?: string,
) {
  const scope = useMemo(
    () => ({ client, connectionId, liveSessions }),
    [client, connectionId, liveSessions],
  );
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
    if (
      connectionId === null ||
      !request ||
      request.scope !== scope ||
      request.busy ||
      !page?.nextBefore
    )
      return;
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
